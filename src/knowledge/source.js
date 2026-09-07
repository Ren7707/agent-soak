import fs from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../core/redact.js';

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
  const result = { ok: true, command: 'analyze', root: absoluteRoot, files: files.map((file) => path.relative(absoluteRoot, file).replaceAll('\\', '/')), evidence: redact(evidence), candidates: redact(mergeCandidates(evidence)) };
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
  const result = [];
  content.split(/\r?\n/).forEach((line, index) => {
    let occurrence = 0;
    for (const match of line.matchAll(/\b(platform|os|email|username|status|version|amount|quantity|timezone)(?:Options|Values|Types|Names)?\b/gi)) {
      occurrence += 1;
      const field = match[1].toLowerCase();
      const values = valuesNear(line, match.index + match[0].length);
      result.push({ id: `evidence-${fileIndex + 1}-${index + 1}-${occurrence}`, source: 'source', file: relative, line: index + 1, kind: values.length ? 'field_values' : 'field_reference', field, semantic_type: SEMANTIC_ALIASES[field], values, snippet: line.trim().slice(0, 300), confidence: values.length ? 0.9 : 0.65 });
    }
  });
  return result;
}

function valuesNear(line, offset) {
  const bracket = line.slice(offset).match(/[=:]\s*\[([^\]]+)\]/);
  return bracket ? [...bracket[1].matchAll(/['"`]([^'"`\n]{1,80})['"`]/g)].map((match) => match[1]) : [];
}

function mergeCandidates(evidence) {
  const groups = new Map();
  for (const item of evidence) {
    const candidate = groups.get(item.field) || { field: item.field, semantic_type: item.semantic_type, examples: [], evidence_refs: [], observed_value_sets: [], observed_value_set_refs: [], confidence: 0 };
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
    candidate.confidence = Math.max(candidate.confidence, item.confidence);
    groups.set(item.field, candidate);
  }
  return [...groups.values()].map((candidate) => {
    const conflicts = candidate.observed_value_sets.length > 1
      ? [{ kind: 'observed_value_sets', value_sets: candidate.observed_value_sets.map((values, index) => ({ values, evidence_refs: candidate.observed_value_set_refs[index] })) }]
      : [];
    const { observed_value_sets: _, observed_value_set_refs: __, ...publicCandidate } = candidate;
    return { ...publicCandidate, conflicts, policy: candidate.examples.length ? { allowed_values: 'observed_or_explicit_custom' } : { allowed_values: 'unknown' } };
  });
}

function sameValues(left, right) {
  const normalize = (values) => [...new Set(values)].sort();
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
