const SAMPLE_KINDS = new Set(['valid', 'boundary', 'nearby_semantic', 'wrong_type', 'missing', 'normalization', 'duplicate', 'relationship', 'lifecycle']);
const ALLOWED_VALUE_POLICIES = new Set(['known_only', 'known_or_explicit_custom', 'observed_or_explicit_custom']);

export function validateContract(contract) {
  if (!contract || typeof contract !== 'object') throw new Error('contract_invalid');
  if (contract.semantic_type !== undefined && typeof contract.semantic_type !== 'string') throw new Error('contract_invalid_semantic_type');
  if (contract.field !== undefined && typeof contract.field !== 'string') throw new Error('contract_invalid_field');
  if (contract.id !== undefined && (typeof contract.id !== 'string' || !contract.id)) throw new Error('contract_invalid_id');
  if (contract.description !== undefined && typeof contract.description !== 'string') throw new Error('contract_invalid_description');
  if (contract.policy !== undefined) validatePolicy(contract.policy, 'contract_policy');
  if (contract.risk_profile !== undefined && typeof contract.risk_profile !== 'string') throw new Error('contract_risk_profile_invalid');
  if (contract.status !== undefined && typeof contract.status !== 'string') throw new Error('contract_status_invalid');
  if (contract.review_required !== undefined && typeof contract.review_required !== 'boolean') throw new Error('contract_review_required_invalid');
  if (contract.approved !== undefined && typeof contract.approved !== 'boolean') throw new Error('contract_approved_invalid');
  if (contract.confidence !== undefined && (!Number.isFinite(contract.confidence) || contract.confidence < 0 || contract.confidence > 1)) throw new Error('contract_confidence_invalid');
  if (contract.evidence_refs !== undefined && (!Array.isArray(contract.evidence_refs) || contract.evidence_refs.some((item) => typeof item !== 'string' || !item))) throw new Error('contract_evidence_refs_invalid');
  if (contract.fields !== undefined && !Array.isArray(contract.fields)) throw new Error('contract_fields_must_be_array');
  if (contract.cases !== undefined && !Array.isArray(contract.cases)) throw new Error('contract_cases_must_be_array');
  if (contract.invariants !== undefined && !Array.isArray(contract.invariants)) throw new Error('contract_invariants_must_be_array');
  for (const item of contract.cases || []) validateCase(item);
  for (const item of contract.invariants || []) validateInvariant(item);
  for (const field of contract.fields || []) {
    if (!field || typeof field !== 'object' || typeof field.path !== 'string') throw new Error('contract_field_invalid');
    if (field.semantic_type !== undefined && typeof field.semantic_type !== 'string') throw new Error('contract_field_semantic_type_invalid');
    if (field.policy !== undefined) validatePolicy(field.policy, 'contract_field_policy');
    for (const key of ['examples', 'negative_examples']) if (field[key] !== undefined && !Array.isArray(field[key])) throw new Error(`contract_field_${key}_must_be_array`);
  }
  return contract;
}

function validatePolicy(policy, prefix) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error(`${prefix}_invalid`);
  if (policy.allowed_values !== undefined && !ALLOWED_VALUE_POLICIES.has(policy.allowed_values)) throw new Error(`${prefix}_allowed_values_invalid`);
  for (const key of ['normalize_case', 'trim_whitespace', 'generate_risk_cases', 'reject_unclassified_value', 'unique']) {
    if (policy[key] !== undefined && typeof policy[key] !== 'boolean') throw new Error(`${prefix}_${key}_invalid`);
  }
  if (policy.risk_expected !== undefined) {
    if (!policy.risk_expected || typeof policy.risk_expected !== 'object' || Array.isArray(policy.risk_expected)) throw new Error(`${prefix}_risk_expected_invalid`);
    for (const key of ['accepted', 'resourceCreated']) {
      if (policy.risk_expected[key] !== undefined && typeof policy.risk_expected[key] !== 'boolean') throw new Error(`${prefix}_risk_expected_${key}_invalid`);
    }
  }
}

export function validateCase(item) {
  if (!item || typeof item !== 'object') throw new Error('contract_case_invalid');
  if (item.kind !== undefined && !SAMPLE_KINDS.has(item.kind)) throw new Error(`contract_case_kind_invalid: ${item.kind}`);
  if (item.input !== undefined && (typeof item.input !== 'object' || Array.isArray(item.input))) throw new Error('contract_case_input_invalid');
  if (item.expected !== undefined && (typeof item.expected !== 'object' || Array.isArray(item.expected))) throw new Error('contract_case_expected_invalid');
  if (item.sequence !== undefined && (!Array.isArray(item.sequence) || item.sequence.length < 2 || item.sequence.some((step) => typeof step !== 'string' || !step))) throw new Error('contract_case_sequence_invalid');
}

function validateInvariant(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || typeof item.description !== 'string' || !item.description) throw new Error('contract_invariant_invalid');
  if (!['equals', 'not_equals', 'in', 'before', 'state_transition'].includes(item.type)) throw new Error('contract_invariant_type_invalid');
  if (['equals', 'not_equals', 'before'].includes(item.type) && (typeof item.left !== 'string' || typeof item.right !== 'string')) throw new Error('contract_invariant_fields_invalid');
  if (item.type === 'in' && (typeof item.left !== 'string' || !Array.isArray(item.values))) throw new Error('contract_invariant_values_invalid');
  if (item.type === 'state_transition' && (!Array.isArray(item.transitions) || item.transitions.some((transition) => !transition || typeof transition.from !== 'string' || typeof transition.to !== 'string'))) throw new Error('contract_invariant_transitions_invalid');
  if (item.severity !== undefined && !['low', 'medium', 'high'].includes(item.severity)) throw new Error('contract_invariant_severity_invalid');
  if (item.evidence_refs !== undefined && (!Array.isArray(item.evidence_refs) || item.evidence_refs.some((ref) => typeof ref !== 'string' || !ref))) throw new Error('contract_invariant_evidence_refs_invalid');
}
