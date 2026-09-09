import fs from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../core/redact.js';

const SOURCE_PRIORITY = Object.freeze({ adapter_explicit: 100, backend_validator: 90, openapi: 80, frontend: 70, runtime: 60, model_inference: 50, generic_risk: 40, source: 30 });

export function inspectRuleConflicts(analysis) {
  if (!analysis || analysis.command !== 'analyze' || !Array.isArray(analysis.candidates) || !Array.isArray(analysis.evidence)) throw new Error('analysis_invalid');
  const evidenceById = new Map(analysis.evidence.map((item) => [item?.id, item]));
  const findings = analysis.candidates.flatMap((candidate) => {
    const valueSets = candidate.conflicts?.flatMap((conflict) => conflict.kind === 'observed_value_sets' ? conflict.value_sets || [] : []) || [];
    const metadataConflicts = candidate.metadata_conflicts || candidate.conflicts?.filter((conflict) => ['required_status', 'description'].includes(conflict.kind)) || [];
    const sources = [...new Set((candidate.evidence_refs || []).map((id) => evidenceById.get(id)?.source || 'unknown'))];
    const policy = candidate.policy?.allowed_values;
    const reasons = [];
    if (valueSets.length > 1) reasons.push({ kind: 'allowed_value_sets', value_sets: valueSets });
    if (policy === 'observed_or_explicit_custom' && valueSets.length > 1) reasons.push({ kind: 'custom_boundary', policy });
    if (metadataConflicts.length) reasons.push(...metadataConflicts);
    if (!reasons.length) return [];
    const category = metadataConflicts.length && valueSets.length === 0 ? 'semantic_metadata_conflict' : 'semantic_boundary_ambiguous';
    return [{ field: candidate.field, semantic_type: candidate.semantic_type, status: 'review_required', category, certainty: 'review_required', sources, source_priority: sources.map((source) => ({ source, priority: SOURCE_PRIORITY[source] ?? 0 })), evidence_refs: candidate.evidence_refs || [], reasons }];
  });
  return redact({ ok: true, command: 'conflicts', status: findings.length ? 'review_required' : 'clear', findings });
}

export async function inspectRuleConflictsFile({ analysisPath, outputPath } = {}) {
  if (!analysisPath) throw new Error('analysis_path_required');
  const source = path.resolve(analysisPath);
  const analysis = JSON.parse(await fs.readFile(source, 'utf8'));
  const result = inspectRuleConflicts(analysis);
  if (!outputPath) return { ...result, input: source };
  const target = path.resolve(outputPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ ...result, input: source }, null, 2)}\n`, 'utf8');
  return { ...result, input: source, output: target };
}
