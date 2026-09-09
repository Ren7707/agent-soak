import fs from 'node:fs/promises';
import path from 'node:path';
import { redact, redactString } from '../core/redact.js';
import { parse as parseYaml } from 'yaml';

const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.json', '.yaml', '.yml']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'artifacts']);
const SEMANTIC_ALIASES = { platform: 'operating_system_platform', os: 'operating_system_platform', email: 'email_address', username: 'user_identifier', status: 'lifecycle_status', version: 'software_version', amount: 'currency_amount', quantity: 'quantity', timezone: 'time_zone' };

export async function analyzeSource({ root, maxFiles = 500, maxBytes = 512 * 1024, outputPath } = {}) {
  const absoluteRoot = path.resolve(root || process.cwd());
  const rootStat = await fs.stat(absoluteRoot).catch(() => null);
  if (!rootStat) throw new Error(`source_root_not_found: ${absoluteRoot}`);
  if (!rootStat.isDirectory()) throw new Error(`source_root_not_directory: ${absoluteRoot}`);
  if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error('source_max_files_invalid');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('source_max_bytes_invalid');
  const files = [];
  await collectFiles(absoluteRoot, files, maxFiles);
  files.sort();
  const evidence = [];
  for (const [fileIndex, file] of files.entries()) {
    const stat = await fs.stat(file);
    if (stat.size > maxBytes) continue;
    evidence.push(...extractEvidence(absoluteRoot, file, await fs.readFile(file, 'utf8'), fileIndex));
  }
  const operations = evidence.filter((item) => item.kind === 'operation').map(({ id, source, file, line, method, route, operation, entity, description, confidence }) => ({ id, source, file, line, method, route, operation, ...(entity ? { entity } : {}), ...(description ? { description } : {}), confidence }));
  const candidates = mergeCandidates(evidence, operations);
  const result = { ok: true, command: 'analyze', root: '.', files: files.map((file) => path.relative(absoluteRoot, file).replaceAll('\\', '/')), evidence: redact(evidence), candidates: redact(candidates), operations: redact(operations), coverage_requirements: redact(candidates.map(({ field, semantic_type, entity, operations: candidateOperations, routes, operation_refs, evidence_refs, required_risks }) => ({ field, semantic_type, ...(entity ? { entity } : {}), ...(candidateOperations?.length ? { operations: candidateOperations } : {}), ...(routes?.length ? { routes } : {}), ...(operation_refs?.length ? { operation_refs } : {}), evidence_refs, required_risks }))) };
  if (outputPath) {
    const target = path.resolve(outputPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return { ...result, output: target };
  }
  return result;
}

async function collectFiles(directory, result, maxFiles) {
  if (result.length >= maxFiles) return;
  const entries = (await fs.readdir(directory, { withFileTypes: true }).catch(() => [])).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (result.length >= maxFiles) return;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await collectFiles(target, result, maxFiles); }
    else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(target);
  }
}

function extractEvidence(root, file, content, fileIndex) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const lines = content.split(/\r?\n/);
  const source = classifySource(relative, content);
  const result = [];
  if (source === 'openapi') result.push(...extractStructuredEvidence(relative, content, lines, fileIndex));
  result.push(...extractOperationEvidence(relative, content, lines, fileIndex, source));
  lines.forEach((line, index) => {
    let occurrence = 0;
    for (const match of line.matchAll(/\b(platform|os|email|username|status|version|amount|quantity|timezone)(?:Options|Values|Types|Names|Schema|Validator)?\b/gi)) {
      occurrence += 1;
      const field = match[1].toLowerCase();
      const values = valuesNear(lines, index, match.index + match[0].length);
      result.push({ id: `evidence-${fileIndex + 1}-${index + 1}-${occurrence}`, source, file: relative, line: index + 1, kind: values.length ? 'field_values' : 'field_reference', field, semantic_type: SEMANTIC_ALIASES[field], values, snippet: snippetNear(lines, index), confidence: values.length ? 0.9 : 0.65 });
    }
  });
  return linkFieldEvidenceToNearbyOperations(result);
}

function linkFieldEvidenceToNearbyOperations(evidence) {
  const operations = evidence.filter((item) => item.kind === 'operation' && item.entity);
  return evidence.map((item) => {
    if (!item.field || item.kind === 'operation') return item;
    const nearby = operations.filter((operation) => Math.abs(operation.line - item.line) <= 40);
    const entities = [...new Set(nearby.map((operation) => operation.entity))];
    if (entities.length !== 1) return item;
    const related = nearby.filter((operation) => operation.entity === entities[0]);
    return {
      ...item,
      entity: entities[0],
      operations: [...new Set(related.map((operation) => operation.operation))],
      routes: [...new Set(related.map((operation) => operation.route))],
      operation_refs: related.map((operation) => operation.id),
    };
  });
}

function extractOperationEvidence(relative, content, lines, fileIndex, source) {
  const result = [];
  const routePattern = /\b(?:app|router|server)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi;
  const fetchPattern = /\bfetch\s*\(\s*['"`]([^'"`\s]+)['"`][\s\S]{0,180}?\bmethod\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/gi;
  for (const match of content.matchAll(routePattern)) result.push(operationEvidence(relative, lines, fileIndex, source, match[1], match[2], match.index, result.length));
  for (const match of content.matchAll(fetchPattern)) result.push(operationEvidence(relative, lines, fileIndex, 'runtime', match[2], match[1], match.index, result.length));
  return result;
}

function operationEvidence(relative, lines, fileIndex, source, method, route, offset, occurrence) {
  const line = contentLine(lines, offset);
  return { id: `evidence-${fileIndex + 1}-${line}-op-${occurrence + 1}`, source, kind: 'operation', file: relative, line, method: method.toUpperCase(), route: route.replace(/[?#].*$/, ''), operation: operationForMethod(method), entity: entityForRoute(route), snippet: snippetNear(lines, line - 1), confidence: 0.86 };
}

function contentLine(lines, offset) {
  let remaining = String(offset ?? 0);
  for (let index = 0; index < lines.length; index += 1) {
    if (remaining <= lines[index].length) return index + 1;
    remaining -= lines[index].length + 1;
  }
  return 1;
}

function operationForMethod(method) {
  return { GET: 'read', POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' }[String(method).toUpperCase()] || 'custom';
}

function entityForRoute(route) {
  const segment = String(route).split('/').filter((item) => item && !item.startsWith(':') && !/^v\\d+$/i.test(item)).pop();
  return segment ? segment.replace(/s$/, '') : undefined;
}

function extractStructuredEvidence(relative, content, lines, fileIndex) {
  const document = parseStructuredDocument(relative, content);
  if (!document || typeof document !== 'object') return [];
  const result = [];
  const lineCursor = { value: 0 };
  const kind = document.openapi || document.swagger ? 'openapi' : 'json_schema';
  walkStructuredSchema(document, [], result, relative, lines, fileIndex, lineCursor, kind);
  if (kind === 'openapi') extractOpenApiOperations(document, relative, lines, fileIndex, result);
  return result;
}

function extractOpenApiOperations(document, relative, lines, fileIndex, result) {
  if (!document.paths || typeof document.paths !== 'object') return;
  for (const [route, definition] of Object.entries(document.paths)) {
    if (!definition || typeof definition !== 'object') continue;
    for (const [method, operation] of Object.entries(definition)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) continue;
      const line = findStructuredFieldLine(lines, route, { value: 0 });
      result.push({ id: `evidence-${fileIndex + 1}-${line}-op-${result.length + 1}`, source: 'openapi', kind: 'operation', schema_kind: 'openapi', file: relative, line, method: method.toUpperCase(), route: String(route).replace(/[?#].*$/, ''), operation: operationForMethod(method), entity: entityForRoute(route), ...(typeof operation?.summary === 'string' ? { description: operation.summary.slice(0, 240) } : {}), confidence: 0.98 });
    }
  }
}

function parseStructuredDocument(relative, content) {
  try {
    return path.extname(relative).toLowerCase() === '.json' ? JSON.parse(content) : parseYaml(content);
  } catch {
    return null;
  }
}

function walkStructuredSchema(node, schemaPath, result, relative, lines, fileIndex, lineCursor, kind) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkStructuredSchema(item, [...schemaPath, index], result, relative, lines, fileIndex, lineCursor, kind));
    return;
  }

  const properties = node.properties && typeof node.properties === 'object' ? node.properties : null;
  if (properties) {
    for (const [field, fieldSchema] of Object.entries(properties)) {
      const semanticType = semanticTypeForField(field);
      if (semanticType) {
        const fieldPath = [...schemaPath, 'properties', field];
        const line = findStructuredFieldLine(lines, field, lineCursor);
        const values = Array.isArray(fieldSchema?.enum) ? fieldSchema.enum.filter((value) => typeof value === 'string').slice(0, 50) : [];
        const description = typeof fieldSchema?.description === 'string' ? fieldSchema.description.slice(0, 240) : undefined;
        result.push({
          id: `evidence-${fileIndex + 1}-${line}-${result.length + 1}`,
          source: 'openapi',
          kind: 'schema_field',
          schema_kind: kind,
          file: relative,
          line,
          field: field.toLowerCase(),
          semantic_type: semanticType,
          ...(entityFromSchemaPath(fieldPath) ? { entity: entityFromSchemaPath(fieldPath) } : {}),
          schema_path: `$.${fieldPath.map(String).join('.')}`,
          values,
          required: Array.isArray(node.required) && node.required.includes(field),
          ...(description ? { description } : {}),
          snippet: lines[Math.max(0, line - 1)]?.trim().slice(0, 240) || '',
          confidence: values.length || description ? 0.98 : 0.9,
        });
      }
      walkStructuredSchema(fieldSchema, [...schemaPath, 'properties', field], result, relative, lines, fileIndex, lineCursor, kind);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties') continue;
    walkStructuredSchema(value, [...schemaPath, key], result, relative, lines, fileIndex, lineCursor, kind);
  }
}

function findStructuredFieldLine(lines, field, lineCursor) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:["']${escaped}["']|^\\s*${escaped})\\s*:`);
  for (let index = lineCursor.value; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      lineCursor.value = index + 1;
      return index + 1;
    }
  }
  return 1;
}

function valuesNear(lines, lineIndex, offset) {
  const window = lines.slice(lineIndex, Math.min(lines.length, lineIndex + 5)).join(' ');
  const current = lines[lineIndex].slice(offset);
  const context = `${current} ${window}`;
  const bracket = context.match(/(?:[=:]\s*(?:z\.enum\s*\(|enum\s*)?|\()[ ]*\[([^\]]+)\]/);
  return bracket ? [...bracket[1].matchAll(/['"`]([^'"`\n]{1,80})['"`]/g)].map((match) => match[1]) : [];
}

function snippetNear(lines, lineIndex) { return redactString(lines.slice(lineIndex, Math.min(lines.length, lineIndex + 3)).join(' ').trim().slice(0, 300)); }

function classifySource(relative, content) {
  const value = `${relative}\n${content}`.toLowerCase();
  if (/openapi|swagger|schema\.(?:json|ya?ml)|components:\s*schemas/.test(value)) return 'openapi';
  if (/validator|validation|zod|joi|yup|class-validator|dto/.test(value)) return 'backend_validator';
  if (/react|vue|svelte|tsx|jsx|<select|option|label|form/.test(value)) return 'frontend';
  if (/fetch\(|axios|request\(|response\.|statuscode/.test(value)) return 'runtime';
  return 'source';
}

function semanticTypeForField(field) {
  const normalized = String(field).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const direct = SEMANTIC_ALIASES[normalized];
  if (direct) return direct;
  const alias = Object.keys(SEMANTIC_ALIASES).find((key) => normalized === `${key}_type` || normalized === `${key}_name` || normalized === `${key}_value`);
  return alias ? SEMANTIC_ALIASES[alias] : undefined;
}

function entityFromSchemaPath(schemaPath) {
  const values = Array.isArray(schemaPath) ? schemaPath : [];
  const schemasIndex = values.findIndex((value) => value === 'schemas');
  const entity = schemasIndex >= 0 ? values[schemasIndex + 1] : undefined;
  return typeof entity === 'string' && entity ? entity.replace(/s$/, '').toLowerCase() : undefined;
}

function mergeCandidates(evidence, operations = []) {
  const groups = new Map();
  for (const item of evidence) {
    if (!item.field) continue;
    const groupKey = item.field || `operation:${item.entity || 'unknown'}`;
    const candidate = groups.get(groupKey) || { field: item.field, semantic_type: item.semantic_type, entity: item.entity, operations: [], routes: [], operation_refs: [], examples: [], evidence_refs: [], observed_value_sets: [], observed_value_set_refs: [], metadata: [], confidence: 0 };
    if (!candidate.entity && item.entity) candidate.entity = item.entity;
    if (item.operation && !candidate.operations.includes(item.operation)) candidate.operations.push(item.operation);
    if (item.route && !candidate.routes.includes(item.route)) candidate.routes.push(item.route);
    if (item.kind === 'operation' && !candidate.operation_refs.includes(item.id)) candidate.operation_refs.push(item.id);
    const itemValues = Array.isArray(item.values) ? item.values : [];
    candidate.examples.push(...itemValues.filter((value) => !candidate.examples.includes(value)));
    if (itemValues.length) {
      const setIndex = candidate.observed_value_sets.findIndex((existingValues) => sameValues(existingValues, itemValues));
      if (setIndex === -1) {
        candidate.observed_value_sets.push(itemValues);
        candidate.observed_value_set_refs.push([item.id]);
      } else {
        candidate.observed_value_set_refs[setIndex].push(item.id);
      }
    }
    candidate.evidence_refs.push(item.id);
    candidate.metadata.push({ evidence_ref: item.id, source: item.source, file: item.file, line: item.line, ...(item.kind ? { kind: item.kind } : {}), ...(item.schema_kind ? { schema_kind: item.schema_kind } : {}), ...(item.schema_path ? { schema_path: item.schema_path } : {}), ...(item.required !== undefined ? { required: item.required } : {}), ...(item.description ? { description: item.description } : {}) });
    candidate.confidence = Math.max(candidate.confidence, item.confidence);
    groups.set(item.field, candidate);
  }
  const operationByEntity = new Map();
  for (const operation of operations) {
    if (!operation.entity) continue;
    const list = operationByEntity.get(operation.entity) || [];
    list.push(operation);
    operationByEntity.set(operation.entity, list);
  }
  return [...groups.values()].map((candidate) => {
    const relatedOperations = candidate.entity ? operationByEntity.get(candidate.entity) || [] : [];
    for (const operation of relatedOperations) {
      if (!candidate.operations.includes(operation.operation)) candidate.operations.push(operation.operation);
      if (!candidate.routes.includes(operation.route)) candidate.routes.push(operation.route);
      if (!candidate.operation_refs.includes(operation.id)) candidate.operation_refs.push(operation.id);
    }
    const conflicts = candidate.observed_value_sets.length > 1
      ? [{ kind: 'observed_value_sets', value_sets: candidate.observed_value_sets.map((values, index) => ({ values, evidence_refs: candidate.observed_value_set_refs[index] })) }]
      : [];
    const metadataConflicts = metadataConflictsFor(candidate.metadata);
    const { observed_value_sets: _, observed_value_set_refs: __, metadata: ___, ...publicCandidate } = candidate;
    const descriptions = uniqueMetadataValues(candidate.metadata, 'description');
    const requiredValues = uniqueMetadataValues(candidate.metadata, 'required');
    const requiredRisks = requiredRisksFor(candidate);
    return {
      ...publicCandidate,
      ...(candidate.operation_refs.length ? { operation_refs: candidate.operation_refs } : {}),
      ...(descriptions.length === 1 ? { description: descriptions[0] } : {}),
      ...(requiredValues.length === 1 ? { required: requiredValues[0] } : {}),
      evidence_summary: candidate.metadata,
      metadata_conflicts: metadataConflicts,
      conflicts: [...conflicts, ...metadataConflicts],
      required_risks: requiredRisks,
      ...(candidate.examples.length ? { policy: { allowed_values: 'observed_or_explicit_custom' } } : {}),
    };
  });
}

function requiredRisksFor(candidate) {
  const risks = new Set(['valid']);
  if (candidate.examples.length > 1) risks.add('boundary');
  if (candidate.semantic_type) risks.add('nearby_semantic');
  if (candidate.semantic_type) risks.add('wrong_type');
  if (candidate.metadata.some((item) => item.required === true)) risks.add('missing');
  if (candidate.examples.some((value) => typeof value === 'string')) risks.add('normalization');
  if (candidate.examples.length && candidate.semantic_type) risks.add('duplicate');
  if (candidate.conflicts?.length) risks.add('relationship');
  return [...risks];
}

function metadataConflictsFor(metadata) {
  const conflicts = [];
  for (const key of ['required', 'description']) {
    const observations = metadata.filter((item) => item[key] !== undefined);
    const values = uniqueMetadataValues(observations, key);
    if (values.length > 1) conflicts.push({ kind: key === 'required' ? 'required_status' : 'description', observations: observations.map((item) => ({ value: item[key], evidence_refs: [item.evidence_ref], source: item.source })) });
  }
  return conflicts;
}

function uniqueMetadataValues(metadata, key) {
  return [...new Set(metadata.map((item) => item[key]).filter((value) => value !== undefined && value !== ''))];
}

function sameValues(left, right) {
  const normalize = (values) => [...new Set(values)].sort();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
