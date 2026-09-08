import { validateContract } from '../contracts/validation.js';

const PLAN_VERSION = 1;
const MODES = new Set(['readonly', 'write']);

export function validateModelPlan(plan, { evidenceIds = [] } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('model_plan_invalid');
  if (plan.version !== PLAN_VERSION) throw new Error('model_plan_version_invalid');
  if (!Array.isArray(plan.contracts)) throw new Error('model_plan_contracts_invalid');
  if (!Array.isArray(plan.scenarios)) throw new Error('model_plan_scenarios_invalid');
  const knownEvidence = new Set(evidenceIds);
  for (const contract of plan.contracts) {
    validateContract(contract);
    validateEvidenceRefs(contract.evidence_refs, knownEvidence);
  }
  for (const scenario of plan.scenarios) {
    if (!scenario || typeof scenario !== 'object' || typeof scenario.id !== 'string' || !scenario.id) throw new Error('model_plan_scenario_invalid');
    if (scenario.mode !== undefined && !MODES.has(scenario.mode)) throw new Error('model_plan_scenario_mode_invalid');
    if (scenario.contract_id !== undefined && typeof scenario.contract_id !== 'string') throw new Error('model_plan_contract_id_invalid');
    validateEvidenceRefs(scenario.evidence_refs, knownEvidence);
  }
  const contractIds = new Set(plan.contracts.map((contract) => contract.id).filter(Boolean));
  for (const scenario of plan.scenarios) if (scenario.contract_id && !contractIds.has(scenario.contract_id)) throw new Error(`model_plan_contract_missing: ${scenario.contract_id}`);
  return plan;
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

function validateEvidenceRefs(refs, knownEvidence) {
  if (refs === undefined) return;
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string' || !ref)) throw new Error('model_plan_evidence_refs_invalid');
  if (knownEvidence.size && refs.some((ref) => !knownEvidence.has(ref))) throw new Error('model_plan_evidence_reference_missing');
}
