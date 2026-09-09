import fs from 'node:fs/promises';
import path from 'node:path';
import { validateContract } from './validation.js';

export async function synthesizeContracts({ analysisPath, outputPath } = {}) {
  if (!analysisPath) throw new Error('analysis_path_required');
  const source = path.resolve(analysisPath);
  const analysis = JSON.parse(await fs.readFile(source, 'utf8'));
  if (!analysis || analysis.command !== 'analyze' || !Array.isArray(analysis.candidates)) throw new Error('analysis_invalid');
  const evidenceIds = new Set((analysis.evidence || []).map((item) => item?.id).filter(Boolean));
  const contracts = analysis.candidates.map((candidate) => {
    for (const evidenceRef of candidate.evidence_refs || []) {
      if (!evidenceIds.has(evidenceRef)) throw new Error(`analysis_evidence_reference_missing: ${evidenceRef}`);
    }
    const contract = {
      id: `${candidate.field}-candidate`,
      field: candidate.field,
      semantic_type: candidate.semantic_type,
      ...(candidate.entity ? { entity: candidate.entity } : {}),
      ...(candidate.operations?.length ? { operations: candidate.operations } : {}),
      ...(candidate.routes?.length ? { routes: candidate.routes } : {}),
      ...(candidate.description ? { description: candidate.description } : {}),
      ...(candidate.evidence_summary ? { evidence_summary: candidate.evidence_summary } : {}),
      fields: [{
        path: candidate.field,
        semantic_type: candidate.semantic_type,
        examples: candidate.examples || [],
        ...(candidate.required !== undefined ? { required: candidate.required } : {}),
        policy: candidate.policy || {},
      }],
      evidence_refs: candidate.evidence_refs || [],
      confidence: candidate.confidence ?? 0,
      conflicts: candidate.conflicts || [],
      metadata_conflicts: candidate.metadata_conflicts || [],
      required_risks: candidate.required_risks || [],
      conflict_review: candidate.conflicts?.length ? { status: 'review_required', category: 'semantic_boundary_ambiguous', conflict_count: candidate.conflicts.length } : { status: 'clear' },
      semantic_review: candidate.conflicts?.length ? 'conflict_review_required' : 'candidate_review_required',
      review_required: true,
      status: 'draft',
    };
    validateContract(contract);
    return contract;
  });
  const result = { version: 1, status: 'draft', source_analysis: { path: source, root: analysis.root, files: analysis.files }, contracts };
  if (outputPath) {
    const target = path.resolve(outputPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(result, null, 2));
    return { ok: true, command: 'contract', output: target, ...result };
  }
  return { ok: true, command: 'contract', ...result };
}
