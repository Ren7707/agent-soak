import fs from 'node:fs/promises';
import path from 'node:path';
import { validateModelPlan } from './model.js';

export async function approveModelPlanFile({ inputPath, outputPath, conflictPath, reviewer, reason, now = new Date().toISOString(), allowAmbiguous = false } = {}) {
  if (!inputPath) throw new Error('approval_input_required');
  if (!outputPath) throw new Error('approval_output_required');
  if (!reviewer || !/^[^\s]{2,120}$/.test(reviewer)) throw new Error('approval_reviewer_required');
  if (!reason || reason.trim().length < 10) throw new Error('approval_reason_required');
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  const plan = JSON.parse(await fs.readFile(input, 'utf8'));
  validateModelPlan(plan);
  if (plan.status !== 'draft' || plan.review_required !== true || plan.approved !== false) throw new Error('approval_plan_not_draft');
  if (plan.contracts.some((contract) => contract.status !== 'draft' || contract.review_required !== true || contract.approved !== false)) throw new Error('approval_contract_not_draft');
  const conflicts = conflictPath ? JSON.parse(await fs.readFile(path.resolve(conflictPath), 'utf8')) : undefined;
  const findings = Array.isArray(conflicts?.findings) ? conflicts.findings : [];
  if (findings.some((finding) => finding?.status === 'review_required') && !allowAmbiguous) throw new Error('approval_conflicts_require_decision');
  const approved = {
    ...plan,
    status: 'approved',
    review_required: false,
    approved: true,
    approval: { reviewer, reason: reason.trim(), approved_at: now, conflict_override: allowAmbiguous && findings.length > 0 },
    contracts: plan.contracts.map((contract) => ({ ...contract, status: 'approved', review_required: false, approved: true })),
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(approved, null, 2)}\n`, 'utf8');
  return { ok: true, command: 'approve', input, output, status: approved.status, reviewer: approved.approval.reviewer, conflict_override: approved.approval.conflict_override };
}
