import { validateCase, validateContract } from './validation.js';
import { generateRiskCases } from './risk-library.js';

export function generateContractCases(contract = {}) {
  const fields = Array.isArray(contract.fields) ? contract.fields : [];
  const explicit = Array.isArray(contract.cases) ? contract.cases : [];
  const generated = fields.flatMap((field) => generateFieldCases(field));
  const cases = dedupeCases([...explicit, ...generated]);
  if (cases.length === 0) return [{ id: 'baseline', kind: 'valid', input: {}, expected: {} }];
  return cases.map((item, index) => normalizeCase(item, index));
}

export function evaluateContract(contract, testCase, details) {
  const expected = testCase.expected || contract.expected || {};
  const actual = details && typeof details === 'object' ? details : {};
  const mismatches = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue === undefined) continue;
    if (!Object.is(actual[key], expectedValue)) mismatches.push({ field: key, expected: expectedValue, actual: actual[key] });
  }
  mismatches.push(...evaluateInvariants(contract.invariants, actual));
  if (mismatches.length === 0) return { ok: true, status: 'passed', mismatches: [] };
  const semantic = ['nearby_semantic', 'wrong_type', 'missing', 'normalization', 'duplicate', 'relationship', 'lifecycle'].includes(testCase.kind);
  const acceptanceMismatch = mismatches.find((item) => item.field === 'accepted');
  const statusMismatch = mismatches.find((item) => item.field === 'resourceCreated' || item.field === 'state' || item.field === 'normalizedValue');
  let category = 'contract_assertion_failed';
  if (['nearby_semantic', 'wrong_type', 'missing'].includes(testCase.kind)) category = 'semantic_constraint_missing';
  else if (testCase.kind === 'normalization') category = 'normalization_inconsistency';
  else if (testCase.kind === 'duplicate' || testCase.kind === 'relationship' || testCase.kind === 'lifecycle') category = 'state_transition_violation';
  else if (acceptanceMismatch?.expected === false && acceptanceMismatch.actual === true) category = 'unexpected_acceptance';
  else if (acceptanceMismatch?.expected === true && acceptanceMismatch.actual === false) category = 'unexpected_rejection';
  else if (statusMismatch) category = 'state_transition_violation';
  if (semantic && category === 'contract_assertion_failed') category = 'semantic_constraint_missing';
  const confirmed = !semantic || isReviewedContract(contract);
  return {
    ok: false,
    status: confirmed ? (semantic ? 'confirmed_bug' : 'failed') : 'semantic_suspect',
    category: confirmed ? category : 'semantic_suspect',
    severity: confirmed ? (semantic ? 'high' : 'medium') : 'unknown',
    certainty: confirmed ? 'confirmed' : 'suspect',
    mismatches,
    rule: ruleFor(contract, testCase),
    ...(confirmed ? {} : { reason: 'contract_requires_review' }),
  };
}

export function evaluateInvariants(invariants = [], actual = {}) {
  return invariants.flatMap((invariant) => {
    const violation = checkInvariant(invariant, actual);
    return violation ? [{ field: `invariant:${invariant.id}`, expected: invariant.description, actual: violation }] : [];
  });
}

export { synthesizeContracts } from './synthesis.js';
export { validateCase, validateContract } from './validation.js';

function generateFieldCases(field) {
  const policy = field.policy || {};
  const values = Array.isArray(field.examples) ? field.examples : [];
  const cases = values.map((value, index) => ({ id: `${field.path}-valid-${index + 1}`, kind: 'valid', input: { [field.path]: value }, expected: field.valid_expected || { accepted: true, resourceCreated: true } }));
  for (const value of field.negative_examples || []) cases.push({ id: `${field.path}-nearby-${cases.length + 1}`, kind: 'nearby_semantic', input: { [field.path]: value }, expected: field.negative_expected || { accepted: false, resourceCreated: false } });
  cases.push(...generateRiskCases(field));
  if (policy.unique && values.length > 0) cases.push({ id: `${field.path}-duplicate`, kind: 'duplicate', input: { [field.path]: values[0] }, sequence: ['submit', 'submit'], expected: field.duplicate_expected || { accepted: false, resourceCreated: false }, description: '重复提交同一业务标识不得产生重复资源' });
  if (policy.normalize_case && typeof values[0] === 'string') cases.push({ id: `${field.path}-normalization-case`, kind: 'normalization', input: { [field.path]: values[0].toUpperCase() }, expected: field.normalization_expected || { accepted: true, resourceCreated: true } });
  if (policy.trim_whitespace && typeof values[0] === 'string') cases.push({ id: `${field.path}-normalization-space`, kind: 'normalization', input: { [field.path]: ` ${values[0]} ` }, expected: field.normalization_expected || { accepted: true, resourceCreated: true } });
  if (field.required !== false) cases.push({ id: `${field.path}-missing`, kind: 'missing', input: {}, expected: field.missing_expected || { accepted: false, resourceCreated: false } });
  return cases;
}

function normalizeCase(item, index) {
  validateCase(item);
  return { id: item.id || `case-${index + 1}`, kind: item.kind || 'valid', input: item.input || {}, expected: item.expected || {}, description: item.description, ...(item.sequence ? { sequence: item.sequence } : {}) };
}

function dedupeCases(cases) {
  const seen = new Set();
  return cases.filter((item) => {
    const key = `${item.kind || 'valid'}:${stableValue(item.input)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stableValue(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function ruleFor(contract, testCase) {
  const fields = Array.isArray(contract.fields) ? contract.fields : [];
  const fieldPath = contract.field || Object.keys(testCase.input || {})[0];
  const field = fields.find((item) => item.path === fieldPath) || fields[0];
  return {
    semantic_type: contract.semantic_type || field?.semantic_type,
    field: fieldPath || field?.path,
    policy: contract.policy || field?.policy,
  };
}

function isReviewedContract(contract) {
  return contract?.review_required !== true
    && !['draft', 'candidate', 'review_required'].includes(contract?.status)
    && contract?.approved !== false;
}

function checkInvariant(invariant, actual) {
  if (!invariant || typeof invariant !== 'object') return 'invalid_invariant';
  const left = readPath(actual, invariant.left);
  const right = readPath(actual, invariant.right);
  switch (invariant.type) {
    case 'equals': return Object.is(left, right) ? null : `${invariant.left} != ${invariant.right}`;
    case 'not_equals': return Object.is(left, right) ? `${invariant.left} == ${invariant.right}` : null;
    case 'in': return Array.isArray(invariant.values) && invariant.values.some((value) => Object.is(value, left)) ? null : `${invariant.left} is outside allowed values`;
    case 'before': return compareValues(left, right) < 0 ? null : `${invariant.left} is not before ${invariant.right}`;
    case 'state_transition': return allowedTransition(invariant, actual) ? null : `transition ${String(readPath(actual, invariant.from || 'previousState'))} -> ${String(readPath(actual, invariant.to || 'state'))} is not allowed`;
    default: return `unsupported invariant type: ${String(invariant.type)}`;
  }
}

function allowedTransition(invariant, actual) {
  const from = readPath(actual, invariant.from || 'previousState');
  const to = readPath(actual, invariant.to || 'state');
  return Array.isArray(invariant.transitions) && invariant.transitions.some((item) => item?.from === from && item?.to === to);
}

function compareValues(left, right) {
  const leftTime = typeof left === 'string' ? Date.parse(left) : Number(left);
  const rightTime = typeof right === 'string' ? Date.parse(right) : Number(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return String(left).localeCompare(String(right));
}

function readPath(value, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((current, key) => current == null ? undefined : current[key], value);
}

export { getRiskProfile, generateRiskCases } from './risk-library.js';
