import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateModelPlan } from './model.js';
import { planFingerprint } from './fingerprint.js';
import { assertPlanQuality } from './quality.js';

export async function approveModelPlanFile({ inputPath, outputPath, conflictPath, reviewer, reason, now = new Date().toISOString(), allowAmbiguous = false } = {}) {
  if (!inputPath) throw new Error('approval_input_required');
  if (!outputPath) throw new Error('approval_output_required');
  if (!reviewer || !/^[^\s]{2,120}$/.test(reviewer)) throw new Error('approval_reviewer_required');
  if (!reason || reason.trim().length < 10) throw new Error('approval_reason_required');
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  const planRaw = await fs.readFile(input, 'utf8');
  const plan = JSON.parse(planRaw);
  validateModelPlan(plan);
  if (plan.status !== 'draft' || plan.review_required !== true || plan.approved !== false) throw new Error('approval_plan_not_draft');
  if (plan.contracts.some((contract) => contract.status !== 'draft' || contract.review_required !== true || contract.approved !== false)) throw new Error('approval_contract_not_draft');
  const conflictInput = conflictPath ? path.resolve(conflictPath) : undefined;
  const conflictRaw = conflictInput ? await fs.readFile(conflictInput, 'utf8') : undefined;
  const conflicts = conflictRaw ? JSON.parse(conflictRaw) : undefined;
  const findings = Array.isArray(conflicts?.findings) ? conflicts.findings : [];
  const contractConflicts = plan.contracts.flatMap((contract) => [
    ...(Array.isArray(contract.conflicts) ? contract.conflicts : []),
    ...(Array.isArray(contract.metadata_conflicts) ? contract.metadata_conflicts : []),
  ]);
  const conflictFields = [...new Set(plan.contracts.filter((contract) => contract.conflicts?.length || contract.metadata_conflicts?.length).map((contract) => contract.field).filter(Boolean))];
  if (contractConflicts.length && !findings.length) throw new Error('approval_conflict_report_required');
  if (findings.some((finding) => finding?.status === 'review_required') && !allowAmbiguous) throw new Error('approval_conflicts_require_decision');
  if (contractConflicts.length && findings.length && !conflictFields.every((field) => findings.some((finding) => finding.field === field))) throw new Error('approval_conflict_field_unmatched');
  const requiredCategories = expectedConflictCategories(plan.contracts);
  if (requiredCategories.some((category) => !findings.some((finding) => finding.category === category))) throw new Error('approval_conflict_category_unmatched');
  const quality = assertPlanQuality(plan, { conflictFindings: findings, allowAmbiguous });
  const approved = {
    ...plan,
    status: 'approved',
    review_required: false,
    approved: true,
    approval: { reviewer, reason: reason.trim(), approved_at: now, conflict_override: allowAmbiguous && findings.length > 0, conflict_fields: conflictFields, conflict_categories: [...new Set(findings.map((finding) => finding.category).filter(Boolean))], plan_fingerprint: planFingerprint(plan), conflict_report_fingerprint: conflictRaw ? fingerprint(conflictRaw) : null },
    contracts: plan.contracts.map((contract) => ({ ...contract, status: 'approved', review_required: false, approved: true })),
    quality,
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(approved, null, 2)}\n`, 'utf8');
  return { ok: true, command: 'approve', input, output, status: approved.status, reviewer: approved.approval.reviewer, conflict_override: approved.approval.conflict_override };
}

function expectedConflictCategories(contracts) {
  return [...new Set(contracts.flatMap((contract) => [
    ...(contract.metadata_conflicts || []).map(() => 'semantic_metadata_conflict'),
    ...(contract.conflicts || []).filter((conflict) => conflict.kind === 'observed_value_sets').map(() => 'semantic_boundary_ambiguous'),
  ]))];
}

function fingerprint(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
