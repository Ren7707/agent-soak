const SAMPLE_KINDS = new Set(['valid', 'boundary', 'nearby_semantic', 'wrong_type', 'missing', 'normalization', 'duplicate', 'relationship']);

export function generateContractCases(contract = {}) {
  const fields = Array.isArray(contract.fields) ? contract.fields : [];
  const explicit = Array.isArray(contract.cases) ? contract.cases : [];
  const generated = fields.flatMap((field) => generateFieldCases(field));
  const cases = [...explicit, ...generated];
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
  if (mismatches.length === 0) return { ok: true, status: 'passed', mismatches: [] };
  const semantic = testCase.kind === 'nearby_semantic' || testCase.kind === 'wrong_type' || contract.semantic_type;
  return {
    ok: false,
    status: semantic ? 'confirmed_bug' : 'failed',
    category: semantic ? 'semantic_constraint_missing' : 'contract_assertion_failed',
    severity: semantic ? 'high' : 'medium',
    mismatches,
    rule: { semantic_type: contract.semantic_type, field: contract.field, policy: contract.policy },
  };
}

export function validateContract(contract) {
  if (!contract || typeof contract !== 'object') throw new Error('contract_invalid');
  if (contract.semantic_type !== undefined && typeof contract.semantic_type !== 'string') throw new Error('contract_invalid_semantic_type');
  if (contract.field !== undefined && typeof contract.field !== 'string') throw new Error('contract_invalid_field');
  if (contract.fields !== undefined && !Array.isArray(contract.fields)) throw new Error('contract_fields_must_be_array');
  if (contract.cases !== undefined && !Array.isArray(contract.cases)) throw new Error('contract_cases_must_be_array');
  for (const item of contract.cases || []) validateCase(item);
  for (const field of contract.fields || []) {
    if (!field || typeof field !== 'object' || typeof field.path !== 'string') throw new Error('contract_field_invalid');
    if (field.semantic_type !== undefined && typeof field.semantic_type !== 'string') throw new Error('contract_field_semantic_type_invalid');
  }
  return contract;
}

function generateFieldCases(field) {
  const policy = field.policy || {};
  const values = Array.isArray(field.examples) ? field.examples : [];
  const cases = values.map((value, index) => ({ id: `${field.path}-valid-${index + 1}`, kind: 'valid', input: { [field.path]: value }, expected: field.valid_expected || { accepted: true, resourceCreated: true } }));
  for (const value of field.negative_examples || []) cases.push({ id: `${field.path}-nearby-${cases.length + 1}`, kind: 'nearby_semantic', input: { [field.path]: value }, expected: field.negative_expected || { accepted: false, resourceCreated: false } });
  if (policy.normalize_case && typeof values[0] === 'string') cases.push({ id: `${field.path}-normalization-case`, kind: 'normalization', input: { [field.path]: values[0].toUpperCase() }, expected: field.normalization_expected || { accepted: true, resourceCreated: true } });
  if (policy.trim_whitespace && typeof values[0] === 'string') cases.push({ id: `${field.path}-normalization-space`, kind: 'normalization', input: { [field.path]: ` ${values[0]} ` }, expected: field.normalization_expected || { accepted: true, resourceCreated: true } });
  if (field.required !== false) cases.push({ id: `${field.path}-missing`, kind: 'missing', input: {}, expected: field.missing_expected || { accepted: false, resourceCreated: false } });
  return cases;
}

function normalizeCase(item, index) {
  validateCase(item);
  return { id: item.id || `case-${index + 1}`, kind: item.kind || 'valid', input: item.input || {}, expected: item.expected || {}, description: item.description };
}

function validateCase(item) {
  if (!item || typeof item !== 'object') throw new Error('contract_case_invalid');
  if (item.kind !== undefined && !SAMPLE_KINDS.has(item.kind)) throw new Error(`contract_case_kind_invalid: ${item.kind}`);
  if (item.input !== undefined && (typeof item.input !== 'object' || Array.isArray(item.input))) throw new Error('contract_case_input_invalid');
  if (item.expected !== undefined && (typeof item.expected !== 'object' || Array.isArray(item.expected))) throw new Error('contract_case_expected_invalid');
}
