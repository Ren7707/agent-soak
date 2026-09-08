import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadManifest, manifestPathFrom, validateManifest, resolveBaseUrl } from '../src/manifest.js';
import { initAdapter } from '../src/adapters/init.js';
import { ResourceRegistry } from '../src/resources/registry.js';
import { parseDuration, runSchedule } from '../src/core/scheduler.js';
import { redact } from '../src/core/redact.js';
import { evaluateContract, evaluateInvariants, generateContractCases, generateRiskCases, getRiskProfile, synthesizeContracts, validateContract } from '../src/contracts/index.js';
import { analyzeSource } from '../src/knowledge/index.js';
import { normalizeModelPlan, validateModelPlan } from '../src/plans/index.js';

const manifest = { schema_version: 1, adapter: './adapter.js', platform: { id: 'demo', base_url_env: 'BASE', write_gate_env: 'ALLOW', test_data_prefix: 'SOAK_', production: false }, capabilities: ['health'], scenarios: [{ id: 'health', mode: 'readonly', capabilities: ['health'] }] };

test('semantic contract generates nearby, normalization, and missing cases', () => {
  const cases = generateContractCases({ fields: [{ path: 'platform', semantic_type: 'operating_system_platform', examples: ['linux'], negative_examples: ['test computer 0001'], policy: { normalize_case: true, trim_whitespace: true } }] });
  assert.deepEqual(cases.map((item) => item.kind), ['valid', 'nearby_semantic', 'normalization', 'normalization', 'missing']);
  assert.equal(cases.find((item) => item.kind === 'nearby_semantic').expected.accepted, false);
});

test('semantic contract generates an executable duplicate sequence for unique fields', () => {
  const cases = generateContractCases({ fields: [{ path: 'name', examples: ['same-name'], policy: { unique: true } }] });
  const duplicate = cases.find((item) => item.kind === 'duplicate');
  assert.deepEqual(duplicate.sequence, ['submit', 'submit']);
  assert.equal(duplicate.expected.accepted, false);
});

test('semantic contract generates idempotent duplicate and invalid lifecycle cases', () => {
  const idempotent = generateContractCases({ fields: [{ path: 'requestId', examples: ['req-1'], policy: { idempotent: true } }] }).find((item) => item.kind === 'duplicate');
  assert.equal(idempotent.expected.idempotent, true);
  const lifecycle = generateContractCases({ lifecycle: { states: ['draft', 'published', 'deleted'], transitions: [{ from: 'draft', to: 'published' }, { from: 'published', to: 'deleted' }], invalid_transitions: [{ from: 'deleted', to: 'published' }] } }).find((item) => item.kind === 'lifecycle');
  assert.deepEqual(lifecycle.sequence, ['deleted', 'published']);
  assert.equal(lifecycle.expected.state, 'deleted');
});

test('risk library generates cross-domain values only when policy enables it', () => {
  assert.equal(generateRiskCases({ path: 'platform', semantic_type: 'operating_system_platform' }).length, 0);
  const cases = generateRiskCases({ path: 'platform', semantic_type: 'operating_system_platform', policy: { reject_unclassified_value: true } });
  assert.ok(cases.some((item) => item.input.platform === 'test computer 0001'));
  assert.ok(cases.some((item) => item.kind === 'wrong_type'));
  assert.ok(getRiskProfile('email_address').nearby_semantic.length > 0);
});

test('generated risk cases are deduplicated against explicit negatives', () => {
  const cases = generateContractCases({ fields: [{ path: 'platform', semantic_type: 'operating_system_platform', negative_examples: ['test computer 0001'], policy: { generate_risk_cases: true } }] });
  assert.equal(cases.filter((item) => item.input.platform === 'test computer 0001').length, 1);
});

test('semantic contract detects a semantically wrong value accepted and persisted', () => {
  const contract = { field: 'platform', semantic_type: 'operating_system_platform' };
  const result = evaluateContract(contract, { kind: 'nearby_semantic', input: { platform: 'test computer 0001' }, expected: { accepted: false, resourceCreated: false } }, { accepted: true, resourceCreated: true, resource: { id: '1', platform: 'test computer 0001' } });
  assert.equal(result.status, 'confirmed_bug');
  assert.equal(result.category, 'semantic_constraint_missing');
  assert.equal(result.ok, false);
});

test('unreviewed semantic contracts produce suspects instead of confirmed bugs', () => {
  const contract = { field: 'platform', semantic_type: 'operating_system_platform', review_required: true, status: 'draft' };
  const result = evaluateContract(contract, { kind: 'nearby_semantic', input: { platform: 'test computer 0001' }, expected: { accepted: false } }, { accepted: true });
  assert.equal(result.status, 'semantic_suspect');
  assert.equal(result.category, 'semantic_suspect');
  assert.equal(result.severity, 'unknown');
});

test('semantic contract accepts explicitly allowed custom values without a false positive', () => {
  const contract = { field: 'platform', semantic_type: 'operating_system_platform' };
  const result = evaluateContract(contract, { kind: 'valid', input: { platform: 'AcmeOS' }, expected: { accepted: true, resourceCreated: true } }, { accepted: true, resourceCreated: true });
  assert.equal(result.ok, true);
});

test('semantic contract classifies normalization and acceptance defects separately', () => {
  const contract = { field: 'platform', semantic_type: 'operating_system_platform' };
  const normalization = evaluateContract(contract, { kind: 'normalization', input: { platform: ' Linux ' }, expected: { accepted: true, normalizedValue: 'Linux' } }, { accepted: true, normalizedValue: ' Linux ' });
  assert.equal(normalization.status, 'confirmed_bug');
  assert.equal(normalization.category, 'normalization_inconsistency');
  const rejection = evaluateContract(contract, { kind: 'valid', input: { platform: 'Linux' }, expected: { accepted: true } }, { accepted: false });
  assert.equal(rejection.status, 'failed');
  assert.equal(rejection.category, 'unexpected_rejection');
});

test('business invariants detect field, range, time, and state violations', () => {
  const invariants = [
    { id: 'same-owner', description: '所有者一致', type: 'equals', left: 'resource.ownerId', right: 'request.ownerId' },
    { id: 'valid-status', description: '状态合法', type: 'in', left: 'state', values: ['active', 'deleted'] },
    { id: 'ordered-window', description: '开始时间早于结束时间', type: 'before', left: 'startAt', right: 'endAt' },
    { id: 'allowed-transition', description: '状态转换合法', type: 'state_transition', transitions: [{ from: 'active', to: 'deleted' }] },
  ];
  assert.equal(evaluateInvariants(invariants, { resource: { ownerId: 'u-1' }, request: { ownerId: 'u-2' }, state: 'archived', startAt: '2026-09-08', endAt: '2026-09-07', previousState: 'deleted' }).length, 4);
  assert.equal(evaluateInvariants(invariants, { resource: { ownerId: 'u-1' }, request: { ownerId: 'u-1' }, state: 'active', startAt: '2026-09-07', endAt: '2026-09-08', previousState: 'active' }).length, 1);
});

test('contract evaluation includes invariant violations in deterministic findings', () => {
  const result = evaluateContract({ status: 'approved', approved: true, invariants: [{ id: 'owner', description: '所有者一致', type: 'equals', left: 'resource.ownerId', right: 'request.ownerId' }] }, { kind: 'relationship', expected: {} }, { resource: { ownerId: 'u-1' }, request: { ownerId: 'u-2' } });
  assert.equal(result.status, 'confirmed_bug');
  assert.equal(result.category, 'state_transition_violation');
  assert.match(result.mismatches[0].field, /invariant:owner/);
});

test('semantic contract rejects malformed declarations', () => {
  assert.throws(() => validateContract({ fields: [{ path: 'platform' }], cases: [{ kind: 'not-a-kind' }] }), /contract_case_kind_invalid/);
  assert.throws(() => validateContract({ fields: [{ path: 'platform', examples: 'Linux' }] }), /contract_field_examples_must_be_array/);
  assert.throws(() => validateContract({ confidence: 2 }), /contract_confidence_invalid/);
  assert.throws(() => validateContract({ policy: { allowed_values: 'anything' } }), /contract_policy_allowed_values_invalid/);
  assert.throws(() => validateContract({ fields: [{ path: 'platform', policy: { normalize_case: 'yes' } }] }), /contract_field_policy_normalize_case_invalid/);
  assert.throws(() => validateContract({ fields: [{ path: 'platform', policy: { risk_expected: { accepted: 'no' } } }] }), /contract_field_policy_risk_expected_accepted_invalid/);
  assert.doesNotThrow(() => validateContract({ fields: [{ path: 'platform', policy: { allowed_values: 'known_only', generate_risk_cases: true, risk_expected: { accepted: false, resourceCreated: false } } }] }));
  assert.doesNotThrow(() => validateContract({ id: 'device', invariants: [{ id: 'no-duplicates', description: '规范化后不得重复', type: 'equals', left: 'resource.key', right: 'request.key', severity: 'high' }], cases: [{ kind: 'lifecycle', sequence: ['create', 'delete'] }] }));
  assert.throws(() => validateContract({ invariants: [{ id: 'broken' }] }), /contract_invariant_invalid/);
  assert.throws(() => validateContract({ cases: [{ kind: 'duplicate', sequence: ['submit'] }] }), /contract_case_sequence_invalid/);
  assert.throws(() => validateContract({ invariants: [{ id: 'bad', description: '错误', type: 'unknown' }] }), /contract_invariant_type_invalid/);
  assert.throws(() => validateContract({ lifecycle: { states: ['draft'], transitions: [{ from: 'draft', to: 'missing' }] } }), /contract_lifecycle_state_unknown/);
});

test('source analysis returns evidence-bound semantic candidates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-source-analysis-'));
  try {
    await fs.writeFile(path.join(dir, 'device-form.tsx'), "const platformOptions = ['Windows', 'macOS', 'Linux'];\nconst platform = 'platform';\n");
    await fs.writeFile(path.join(dir, 'device-settings.tsx'), "const platformValues = ['Linux', 'Windows'];\n");
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'node_modules', 'ignored.js'), "const platformOptions = ['secret'];\n");
    const result = await analyzeSource({ root: dir });
    assert.deepEqual(result.files, ['device-form.tsx', 'device-settings.tsx']);
    assert.equal(result.candidates[0].semantic_type, 'operating_system_platform');
    assert.deepEqual(result.candidates[0].examples, ['Windows', 'macOS', 'Linux']);
    assert.equal(result.evidence[0].line, 1);
    assert.notEqual(result.evidence[0].id, result.evidence[2].id);
    assert.equal(result.candidates[0].conflicts[0].kind, 'observed_value_sets');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('contract synthesis creates reviewable draft contracts from analysis', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-contract-synthesis-'));
  try {
    const analysisPath = path.join(dir, 'analysis.json');
    const outputPath = path.join(dir, 'contracts.json');
    await fs.writeFile(analysisPath, JSON.stringify({ command: 'analyze', root: dir, files: ['form.tsx'], evidence: [{ id: 'evidence-1' }], candidates: [{ field: 'platform', semantic_type: 'operating_system_platform', examples: ['Windows', 'Linux'], evidence_refs: ['evidence-1'], confidence: 0.9, policy: { allowed_values: 'observed_or_explicit_custom' } }] }));
    const result = await synthesizeContracts({ analysisPath, outputPath });
    assert.equal(result.status, 'draft');
    assert.equal(result.contracts[0].review_required, true);
    assert.deepEqual(result.contracts[0].evidence_refs, ['evidence-1']);
    assert.equal(JSON.parse(await fs.readFile(outputPath, 'utf8')).contracts[0].field, 'platform');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('contract synthesis rejects non-analysis input', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-contract-invalid-'));
  try {
    const analysisPath = path.join(dir, 'invalid.json');
    await fs.writeFile(analysisPath, JSON.stringify({ command: 'inspect' }));
    await assert.rejects(synthesizeContracts({ analysisPath }), /analysis_invalid/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('source analysis rejects a missing or non-directory root', async () => {
  await assert.rejects(analyzeSource({ root: path.join(os.tmpdir(), 'agent-soak-source-does-not-exist') }), /source_root_not_found/);
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-source-file-')), 'source.ts');
  try {
    await fs.writeFile(file, 'const platform = true;\n');
    await assert.rejects(analyzeSource({ root: file }), /source_root_not_directory/);
  } finally {
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  }
});

test('contract synthesis rejects evidence references that are not in the analysis', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-contract-evidence-'));
  try {
    const analysisPath = path.join(dir, 'analysis.json');
    await fs.writeFile(analysisPath, JSON.stringify({ command: 'analyze', root: dir, files: [], evidence: [], candidates: [{ field: 'platform', evidence_refs: ['missing-evidence'] }] }));
    await assert.rejects(synthesizeContracts({ analysisPath }), /analysis_evidence_reference_missing/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('model plans validate evidence and contract references', () => {
  const plan = { version: 1, contracts: [{ id: 'device-contract', field: 'platform', semantic_type: 'operating_system_platform', evidence_refs: ['e-1'] }], scenarios: [{ id: 'register-device', mode: 'write', contract_id: 'device-contract', evidence_refs: ['e-1'] }] };
  assert.doesNotThrow(() => validateModelPlan(plan, { evidenceIds: ['e-1'] }));
  const normalized = normalizeModelPlan({ ...plan, approved: true }, { evidenceIds: ['e-1'] });
  assert.equal(normalized.status, 'draft');
  assert.equal(normalized.approved, false);
  assert.equal(normalized.contracts[0].review_required, true);
  assert.throws(() => validateModelPlan(plan, { evidenceIds: ['other'] }), /model_plan_evidence_reference_missing/);
  assert.throws(() => validateModelPlan({ ...plan, scenarios: [{ id: 'broken', contract_id: 'missing' }] }, { evidenceIds: ['e-1'] }), /model_plan_contract_missing/);
});

test('manifest validation rejects duplicate scenario ids', () => assert.throws(() => validateManifest({ ...manifest, scenarios: [{ id: 'x', mode: 'readonly' }, { id: 'x', mode: 'write' }] }), /manifest_duplicate_or_invalid_scenario/));
test('manifest validation rejects undeclared capabilities', () => assert.throws(() => validateManifest({ ...manifest, scenarios: [{ id: 'x', mode: 'readonly', capabilities: ['missing'] }] }), /manifest_unknown_capability/));
test('manifest validation accepts suite, tags, priority, and ruleset metadata', () => assert.doesNotThrow(() => validateManifest({ ...manifest, ruleset_version: 'rules-1', scenarios: [{ id: 'x', mode: 'readonly', suite: 'smoke', tags: ['semantic', 'fast'], priority: 'high' }] })));
test('manifest validation rejects invalid scenario metadata', () => { assert.throws(() => validateManifest({ ...manifest, scenarios: [{ id: 'x', mode: 'readonly', tags: [''] }] }), /manifest_invalid_tags/); assert.throws(() => validateManifest({ ...manifest, scenarios: [{ id: 'x', mode: 'readonly', priority: 'urgent' }] }), /manifest_invalid_priority/); });
test('manifest loader supports YAML and default discovery', async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-yaml-')); try { await fs.writeFile(path.join(dir, 'platform.manifest.yaml'), `schema_version: 1\nadapter: ./adapter.js\nplatform:\n  id: demo\n  base_url_env: BASE\n  write_gate_env: ALLOW\n  test_data_prefix: SOAK_\ncapabilities: [health]\nscenarios:\n  - id: health\n    mode: readonly\n`); const file = manifestPathFrom(dir); assert.equal(path.extname(file), '.yaml'); assert.equal((await loadManifest(file)).platform.id, 'demo'); } finally { await fs.rm(dir, { recursive: true, force: true }); } });
test('adapter initializer creates isolated starter files', async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-init-')); try { const result = await initAdapter({ cwd: dir, id: 'sample-platform' }); assert.equal(result.ok, true); assert.deepEqual((await fs.readdir(path.join(dir, 'adapters', 'sample-platform'))).sort(), ['.env.example', 'README.md', 'adapter.js', 'platform.manifest.yaml']); } finally { await fs.rm(dir, { recursive: true, force: true }); } });
test('manifest validation checks timeout and retry bounds', () => { assert.throws(() => validateManifest({ ...manifest, scenarios: [{ id: 'x', mode: 'readonly', timeout_ms: 0 }] }), /manifest_invalid_timeout/); assert.throws(() => validateManifest({ ...manifest, scenarios: [{ id: 'x', mode: 'readonly', retries: 11 }] }), /manifest_invalid_retries/); });
test('base URL validation rejects credentials and non-http schemes', () => { assert.throws(() => resolveBaseUrl(manifest, { BASE: 'ftp://example.test' }), /configuration_invalid_base_url/); assert.throws(() => resolveBaseUrl(manifest, { BASE: 'https://user:pass@example.test' }), /configuration_invalid_base_url/); });
test('duration parser handles hours and rejects unknown units', () => { assert.equal(parseDuration('2h'), 7200000); assert.throws(() => parseDuration('3days'), /duration_invalid/); });
test('scheduler requires exactly one target and supports cancellation', async () => { await assert.rejects(runSchedule({ onRound: async () => {} }), /schedule_requires_exactly_one_target/); const controller = new AbortController(); let rounds = 0; const result = await runSchedule({ durationMs: 50, intervalMs: 50, signal: controller.signal, onRound: async () => { rounds += 1; controller.abort(); } }); assert.equal(result.cancelled, true); assert.equal(rounds, 1); });
test('resource registry enforces run ownership and cleans resources', async () => { const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-registry-')); try { const registry = new ResourceRegistry({ artifactDir, runId: 'run-a', prefix: 'SOAK_run-a-' }); const item = registry.register({ id: '1', type: 'item', name: 'SOAK_run-a-item' }); assert.equal(registry.owns(item), true); await registry.cleanup(async () => {}); assert.equal(registry.resources[0].state, 'cleaned'); } finally { await fs.rm(artifactDir, { recursive: true, force: true }); } });
test('resource registry writes pending records for failed cleanup', async () => { const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-pending-')); try { const registry = new ResourceRegistry({ artifactDir, runId: 'run-b', prefix: 'SOAK_run-b-' }); registry.register({ id: '1', type: 'item', name: 'SOAK_run-b-item' }); const result = await registry.cleanup(async () => { throw new Error('delete refused'); }); assert.equal(result.ok, false); assert.equal(result.pending.length, 1); assert.equal(await fs.access(path.join(artifactDir, 'run-b', 'cleanup-pending.json')).then(() => true), true); } finally { await fs.rm(artifactDir, { recursive: true, force: true }); } });
test('redaction hides sensitive fields and bearer values', () => assert.deepEqual(redact({ token: 'secret', message: 'Bearer abc123' }), { token: '[REDACTED]', message: 'Bearer [REDACTED]' }));
