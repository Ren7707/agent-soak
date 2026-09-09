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
  const candidates = mergeCandidates(evidence);
  const result = { ok: true, command: 'analyze', root: '.', files: files.map((file) => path.relative(absoluteRoot, file).replaceAll('\\', '/')), evidence: redact(evidence), candidates: redact(candidates), coverage_requirements: redact(candidates.map(({ field, semantic_type, evidence_refs, required_risks }) => ({ field, semantic_type, evidence_refs, required_risks }))) };
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
  lines.forEach((line, index) => {
    let occurrence = 0;
    for (const match of line.matchAll(/\b(platform|os|email|username|status|version|amount|quantity|timezone)(?:Options|Values|Types|Names|Schema|Validator)?\b/gi)) {
      occurrence += 1;
      const field = match[1].toLowerCase();
      const values = valuesNear(lines, index, match.index + match[0].length);
      result.push({ id: `evidence-${fileIndex + 1}-${index + 1}-${occurrence}`, source, file: relative, line: index + 1, kind: values.length ? 'field_values' : 'field_reference', field, semantic_type: SEMANTIC_ALIASES[field], values, snippet: snippetNear(lines, index), confidence: values.length ? 0.9 : 0.65 });
    }
  });
  return result;
}

function extractStructuredEvidence(relative, content, lines, fileIndex) {
  const document = parseStructuredDocument(relative, content);
  if (!document || typeof document !== 'object') return [];
  const result = [];
  const lineCursor = { value: 0 };
  const kind = document.openapi || document.swagger ? 'openapi' : 'json_schema';
  walkStructuredSchema(document, [], result, relative, lines, fileIndex, lineCursor, kind);
  return result;
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

function mergeCandidates(evidence) {
  const groups = new Map();
  for (const item of evidence) {
    const candidate = groups.get(item.field) || { field: item.field, semantic_type: item.semantic_type, examples: [], evidence_refs: [], observed_value_sets: [], observed_value_set_refs: [], metadata: [], confidence: 0 };
    candidate.examples.push(...item.values.filter((value) => !candidate.examples.includes(value)));
    if (item.values.length) {
      const setIndex = candidate.observed_value_sets.findIndex((values) => sameValues(values, item.values));
      if (setIndex === -1) {
        candidate.observed_value_sets.push(item.values);
        candidate.observed_value_set_refs.push([item.id]);
      } else {
        candidate.observed_value_set_refs[setIndex].push(item.id);
      }
    }
    candidate.evidence_refs.push(item.id);
    candidate.metadata.push({ evidence_ref: item.id, source: item.source, file: item.file, line: item.line, ...(item.schema_kind ? { schema_kind: item.schema_kind } : {}), ...(item.schema_path ? { schema_path: item.schema_path } : {}), ...(item.required !== undefined ? { required: item.required } : {}), ...(item.description ? { description: item.description } : {}) });
    candidate.confidence = Math.max(candidate.confidence, item.confidence);
    groups.set(item.field, candidate);
  }
  return [...groups.values()].map((candidate) => {
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
