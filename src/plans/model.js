import { validateContract } from '../contracts/validation.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const PLAN_VERSION = 1;
const MODES = new Set(['readonly', 'write']);

export function validateModelPlan(plan, { evidenceIds = [] } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('model_plan_invalid');
  if (plan.version !== PLAN_VERSION) throw new Error('model_plan_version_invalid');
  if (!Array.isArray(plan.contracts)) throw new Error('model_plan_contracts_invalid');
  if (!Array.isArray(plan.scenarios)) throw new Error('model_plan_scenarios_invalid');
  if (plan.status !== undefined && typeof plan.status !== 'string') throw new Error('model_plan_status_invalid');
  if (plan.review_required !== undefined && typeof plan.review_required !== 'boolean') throw new Error('model_plan_review_required_invalid');
  if (plan.approved !== undefined && typeof plan.approved !== 'boolean') throw new Error('model_plan_approved_invalid');
  if (plan.requires_write_approval !== undefined && typeof plan.requires_write_approval !== 'boolean') throw new Error('model_plan_write_approval_invalid');
  if (plan.approval !== undefined) validateApproval(plan.approval);
  const knownEvidence = new Set(evidenceIds);
  for (const contract of plan.contracts) {
    validateContract(contract);
    validateEvidenceRefs(contract.evidence_refs, knownEvidence);
  }
  for (const scenario of plan.scenarios) {
    if (!scenario || typeof scenario !== 'object' || typeof scenario.id !== 'string' || !scenario.id) throw new Error('model_plan_scenario_invalid');
    if (scenario.mode !== undefined && !MODES.has(scenario.mode)) throw new Error('model_plan_scenario_mode_invalid');
    if (scenario.contract_id !== undefined && typeof scenario.contract_id !== 'string') throw new Error('model_plan_contract_id_invalid');
    if (scenario.capabilities !== undefined && (!Array.isArray(scenario.capabilities) || scenario.capabilities.some((item) => typeof item !== 'string' || !item))) throw new Error('model_plan_scenario_capabilities_invalid');
    if (scenario.suite !== undefined && (typeof scenario.suite !== 'string' || !scenario.suite)) throw new Error('model_plan_scenario_suite_invalid');
    if (scenario.tags !== undefined && (!Array.isArray(scenario.tags) || scenario.tags.some((item) => typeof item !== 'string' || !item))) throw new Error('model_plan_scenario_tags_invalid');
    if (scenario.priority !== undefined && !['low', 'medium', 'high', 'critical'].includes(scenario.priority)) throw new Error('model_plan_scenario_priority_invalid');
    validateEvidenceRefs(scenario.evidence_refs, knownEvidence);
  }
  const contractIds = new Set(plan.contracts.map((contract) => contract.id).filter(Boolean));
  for (const scenario of plan.scenarios) if (scenario.contract_id && !contractIds.has(scenario.contract_id)) throw new Error(`model_plan_contract_missing: ${scenario.contract_id}`);
  return plan;
}

function validateApproval(approval) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) throw new Error('model_plan_approval_invalid');
  for (const key of ['reviewer', 'reason', 'approved_at']) if (typeof approval[key] !== 'string' || !approval[key]) throw new Error(`model_plan_approval_${key}_invalid`);
  if (typeof approval.conflict_override !== 'boolean') throw new Error('model_plan_approval_conflict_override_invalid');
  for (const key of ['conflict_fields', 'conflict_categories']) if (!Array.isArray(approval[key]) || approval[key].some((item) => typeof item !== 'string' || !item)) throw new Error(`model_plan_approval_${key}_invalid`);
  for (const key of ['plan_fingerprint', 'conflict_report_fingerprint']) if (approval[key] !== undefined && approval[key] !== null && (typeof approval[key] !== 'string' || !/^[a-f0-9]{64}$/.test(approval[key]))) throw new Error(`model_plan_approval_${key}_invalid`);
}

export function normalizeModelPlan(plan, options) {
  validateModelPlan(plan, options);
  return {
    ...plan,
    status: 'draft',
    review_required: true,
    approved: false,
    requires_write_approval: plan.requires_write_approval === true,
    contracts: plan.contracts.map((contract) => ({ ...contract, status: 'draft', review_required: true, approved: false })),
    scenarios: plan.scenarios.map((scenario) => ({ ...scenario, mode: scenario.mode || 'readonly' })),
  };
}

export async function normalizeModelPlanFile({ inputPath, outputPath, evidencePath } = {}) {
  if (!inputPath) throw new Error('model_plan_input_required');
  const input = path.resolve(inputPath);
  const plan = JSON.parse(await fs.readFile(input, 'utf8'));
  const evidence = evidencePath ? JSON.parse(await fs.readFile(path.resolve(evidencePath), 'utf8')) : undefined;
  const evidenceIds = Array.isArray(evidence?.evidence) ? evidence.evidence.map((item) => item?.id).filter(Boolean) : [];
  const normalized = normalizeModelPlan(plan, { evidenceIds });
  if (!outputPath) return { ok: true, command: 'plan', input: input, ...normalized };
  const output = path.resolve(outputPath);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return { ok: true, command: 'plan', input, output, ...normalized };
}

function validateEvidenceRefs(refs, knownEvidence) {
  if (refs === undefined) return;
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string' || !ref)) throw new Error('model_plan_evidence_refs_invalid');
  if (knownEvidence.size && refs.some((ref) => !knownEvidence.has(ref))) throw new Error('model_plan_evidence_reference_missing');
}
