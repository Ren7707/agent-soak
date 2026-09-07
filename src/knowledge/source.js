import fs from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../core/redact.js';

const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.json', '.yaml', '.yml']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'artifacts']);
const SEMANTIC_ALIASES = { platform: 'operating_system_platform', os: 'operating_system_platform', email: 'email_address', username: 'user_identifier', status: 'lifecycle_status', version: 'software_version', amount: 'currency_amount', quantity: 'quantity', timezone: 'time_zone' };

export async function analyzeSource({ root, maxFiles = 500, maxBytes = 512 * 1024 } = {}) {
  const absoluteRoot = path.resolve(root || process.cwd());
  const files = [];
  await collectFiles(absoluteRoot, files, maxFiles);
  const evidence = [];
  for (const file of files) {
    const stat = await fs.stat(file);
    if (stat.size > maxBytes) continue;
    evidence.push(...extractEvidence(absoluteRoot, file, await fs.readFile(file, 'utf8')));
  }
  return { ok: true, command: 'analyze', root: absoluteRoot, files: files.map((file) => path.relative(absoluteRoot, file)), evidence: redact(evidence), candidates: redact(mergeCandidates(evidence)) };
}

async function collectFiles(directory, result, maxFiles) {
  if (result.length >= maxFiles) return;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (result.length >= maxFiles) return;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await collectFiles(target, result, maxFiles); }
    else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(target);
  }
}

function extractEvidence(root, file, content) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const result = [];
  content.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(/\b(platform|os|email|username|status|version|amount|quantity|timezone)(?:Options|Values|Types|Names)?\b/gi)) {
      const field = match[1].toLowerCase();
      const values = valuesNear(line, match.index + match[0].length);
      result.push({ id: `evidence-${index + 1}-${result.length + 1}`, source: 'source', file: relative, line: index + 1, kind: values.length ? 'field_values' : 'field_reference', field, semantic_type: SEMANTIC_ALIASES[field], values, snippet: line.trim().slice(0, 300), confidence: values.length ? 0.9 : 0.65 });
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
    const candidate = groups.get(item.field) || { field: item.field, semantic_type: item.semantic_type, examples: [], evidence_refs: [], confidence: 0 };
    candidate.examples.push(...item.values.filter((value) => !candidate.examples.includes(value)));
    candidate.evidence_refs.push(item.id);
    candidate.confidence = Math.max(candidate.confidence, item.confidence);
    groups.set(item.field, candidate);
  }
  return [...groups.values()].map((candidate) => ({ ...candidate, policy: candidate.examples.length ? { allowed_values: 'observed_or_explicit_custom' } : { allowed_values: 'unknown' } }));
}
