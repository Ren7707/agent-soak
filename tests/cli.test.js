import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/manifest.js';

const root = new URL('..', import.meta.url);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('CLI inspect returns machine-readable manifest', async () => {
  const child = spawn(process.execPath, ['src/cli.js', 'inspect', '--json'], { cwd: root, env: { ...process.env, DEMO_PLATFORM_BASE_URL: 'http://127.0.0.1:4317' } });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); await once(child, 'close');
  const result = JSON.parse(output); assert.equal(result.ok, true); assert.equal(result.manifest.platform.id, 'demo-platform');
});

test('CLI exposes the package version as JSON', async () => {
  const result = await runCli(['--version', '--json'], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).version, '0.1.0');
});

test('CLI analyze scans an explicit source directory without loading a target manifest', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-analyze-'));
  try {
    await fs.writeFile(path.join(cwd, 'form.tsx'), "const platformOptions = ['Windows', 'Linux'];\n");
    const outputPath = path.join(cwd, 'analysis.json');
    const result = await runCli(['analyze', '--source', cwd, '--output', outputPath, '--json'], { cwd: path.dirname(cwd) });
    const body = JSON.parse(result.stdout);
    assert.equal(result.code, 0);
    assert.equal(body.command, 'analyze');
    assert.equal(body.candidates[0].field, 'platform');
    assert.equal(JSON.parse(await fs.readFile(outputPath, 'utf8')).candidates[0].field, 'platform');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI contract writes a reviewable draft from analysis JSON', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-contract-'));
  try {
    const analysisPath = path.join(cwd, 'analysis.json');
    const outputPath = path.join(cwd, 'contracts.json');
    await fs.writeFile(analysisPath, JSON.stringify({ command: 'analyze', root: cwd, files: [], evidence: [{ id: 'evidence-1' }], candidates: [{ field: 'platform', semantic_type: 'operating_system_platform', examples: ['Linux'], evidence_refs: ['evidence-1'] }] }));
    const result = await runCli(['contract', '--analysis', analysisPath, '--output', outputPath, '--json'], { cwd: path.dirname(cwd) });
    const body = JSON.parse(result.stdout);
    assert.equal(result.code, 0);
    assert.equal(body.status, 'draft');
    assert.equal(JSON.parse(await fs.readFile(outputPath, 'utf8')).contracts[0].review_required, true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI conflicts reports ambiguous source rules without selecting a winner', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-conflicts-'));
  try {
    const analysisPath = path.join(cwd, 'analysis.json');
    const outputPath = path.join(cwd, 'conflicts.json');
    await fs.writeFile(analysisPath, JSON.stringify({ command: 'analyze', evidence: [{ id: 'front', source: 'frontend' }, { id: 'back', source: 'backend_validator' }], candidates: [{ field: 'platform', semantic_type: 'operating_system_platform', evidence_refs: ['front', 'back'], policy: { allowed_values: 'observed_or_explicit_custom' }, conflicts: [{ kind: 'observed_value_sets', value_sets: [{ values: ['Windows', 'Linux'], evidence_refs: ['front'] }, { values: ['Windows', 'Linux', 'AcmeOS'], evidence_refs: ['back'] }] }] }] }));
    const result = await runCli(['conflicts', '--analysis', analysisPath, '--output', outputPath, '--json'], { cwd });
    const body = JSON.parse(result.stdout);
    assert.equal(result.code, 0);
    assert.equal(body.status, 'review_required');
    assert.equal(JSON.parse(await fs.readFile(outputPath, 'utf8')).findings[0].category, 'semantic_boundary_ambiguous');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI approve records an auditable plan decision and blocks unresolved conflicts', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-approve-'));
  try {
    const inputPath = path.join(cwd, 'draft.json');
    const conflictPath = path.join(cwd, 'conflicts.json');
    const outputPath = path.join(cwd, 'approved.json');
    const draft = { version: 1, status: 'draft', review_required: true, approved: false, contracts: [{ id: 'device', field: 'platform', status: 'draft', review_required: true, approved: false }], scenarios: [{ id: 'register-device', contract_id: 'device' }] };
    await fs.writeFile(inputPath, JSON.stringify(draft));
    await fs.writeFile(conflictPath, JSON.stringify({ findings: [{ status: 'review_required', category: 'semantic_boundary_ambiguous' }] }));
    const blocked = await runCli(['approve', '--input', inputPath, '--output', outputPath, '--conflicts', conflictPath, '--reviewer', 'owner', '--reason', '需要确认平台字段是否允许自定义系统名称', '--json'], { cwd });
    assert.equal(blocked.code, 2);
    assert.match(JSON.parse(blocked.stdout).detail_code, /approval_conflicts_require_decision/);
    const approved = await runCli(['approve', '--input', inputPath, '--output', outputPath, '--conflicts', conflictPath, '--reviewer', 'owner', '--reason', '已确认产品允许自定义系统名称并接受该边界', '--allow-ambiguous', '--json'], { cwd });
    const body = JSON.parse(approved.stdout);
    assert.equal(approved.code, 0);
    assert.equal(body.status, 'approved');
    const saved = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert.equal(saved.approval.reviewer, 'owner');
    assert.equal(saved.approval.conflict_override, true);
    assert.equal(saved.contracts[0].review_required, false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI approve binds embedded contract conflicts to reviewed findings', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-approve-integrity-'));
  try {
    const inputPath = path.join(cwd, 'draft.json');
    const outputPath = path.join(cwd, 'approved.json');
    const draft = { version: 1, status: 'draft', review_required: true, approved: false, contracts: [{ id: 'device', field: 'platform', conflicts: [{ kind: 'required_status' }], metadata_conflicts: [{ kind: 'required_status', observations: [] }], status: 'draft', review_required: true, approved: false }], scenarios: [{ id: 'register-device', contract_id: 'device' }] };
    await fs.writeFile(inputPath, JSON.stringify(draft));
    const missing = await runCli(['approve', '--input', inputPath, '--output', outputPath, '--reviewer', 'owner', '--reason', '已完成字段规则审核并记录依据', '--allow-ambiguous', '--json'], { cwd });
    assert.equal(missing.code, 2);
    assert.match(JSON.parse(missing.stdout).detail_code, /approval_conflict_report_required/);

    const conflictPath = path.join(cwd, 'conflicts.json');
    await fs.writeFile(conflictPath, JSON.stringify({ findings: [{ field: 'other', status: 'review_required', category: 'semantic_metadata_conflict' }] }));
    const unmatched = await runCli(['approve', '--input', inputPath, '--output', outputPath, '--conflicts', conflictPath, '--reviewer', 'owner', '--reason', '已完成字段规则审核并记录依据', '--allow-ambiguous', '--json'], { cwd });
    assert.equal(unmatched.code, 2);
    assert.match(JSON.parse(unmatched.stdout).detail_code, /approval_conflict_field_unmatched/);

    await fs.writeFile(conflictPath, JSON.stringify({ findings: [{ field: 'platform', status: 'review_required', category: 'semantic_metadata_conflict' }] }));
    const approved = await runCli(['approve', '--input', inputPath, '--output', outputPath, '--conflicts', conflictPath, '--reviewer', 'owner', '--reason', '已确认平台字段必填规则及其来源差异', '--allow-ambiguous', '--json'], { cwd });
    assert.equal(approved.code, 0);
    const saved = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    assert.deepEqual(saved.approval.conflict_fields, ['platform']);
    assert.deepEqual(saved.approval.conflict_categories, ['semantic_metadata_conflict']);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI plan normalizes a model plan and checks evidence references', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-plan-'));
  try {
    const inputPath = path.join(cwd, 'model-plan.json');
    const evidencePath = path.join(cwd, 'analysis.json');
    const outputPath = path.join(cwd, 'draft-plan.json');
    await fs.writeFile(inputPath, JSON.stringify({ version: 1, approved: true, contracts: [{ id: 'device', field: 'platform', semantic_type: 'operating_system_platform', evidence_refs: ['e-1'] }], scenarios: [{ id: 'register-device', mode: 'write', contract_id: 'device', evidence_refs: ['e-1'] }] }));
    await fs.writeFile(evidencePath, JSON.stringify({ evidence: [{ id: 'e-1' }] }));
    const result = await runCli(['plan', '--input', inputPath, '--evidence', evidencePath, '--output', outputPath, '--json'], { cwd: path.dirname(cwd) });
    const body = JSON.parse(result.stdout);
    assert.equal(result.code, 0);
    assert.equal(body.command, 'plan');
    assert.equal(body.status, 'draft');
    assert.equal(JSON.parse(await fs.readFile(outputPath, 'utf8')).approved, false);
    const invalid = await runCli(['plan', '--input', inputPath, '--evidence', path.join(cwd, 'missing-evidence.json'), '--json'], { cwd: path.dirname(cwd) });
    assert.equal(invalid.code, 2);
    assert.match(JSON.parse(invalid.stdout).detail_code, /ENOENT/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI scaffold generates a safe skeleton only from an approved plan', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-scaffold-'));
  try {
    const inputPath = path.join(cwd, 'approved-plan.json');
    const outputDir = path.join(cwd, 'adapters', 'personal-demo');
    const plan = {
      version: 1, status: 'approved', review_required: false, approved: true,
      contracts: [{ id: 'device', field: 'platform', semantic_type: 'operating_system_platform', description: '企业系统 https://private.example.test', evidence_refs: ['e-1'], policy: { api_key: 'secret-token' }, cases: [{ input: { email: 'owner@example.com' } }] , status: 'approved', review_required: false, approved: true }],
      scenarios: [{ id: 'register-device', mode: 'write', contract_id: 'device' }],
    };
    await fs.writeFile(inputPath, JSON.stringify(plan));
    const result = await runCli(['scaffold', '--input', inputPath, '--output', outputDir, '--id', 'personal-demo', '--json'], { cwd });
    const body = JSON.parse(result.stdout);
    assert.equal(result.code, 0);
    assert.equal(body.executes, false);
    assert.deepEqual((await fs.readdir(outputDir)).sort(), ['README.md', 'adapter.js', 'contracts.json', 'platform.manifest.json']);
    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, 'platform.manifest.json'), 'utf8'));
    assert.equal(manifest.scenarios[0].mode, 'write');
    assert.equal(manifest.platform.production, false);
    assert.equal((await loadManifest(path.join(outputDir, 'platform.manifest.json'))).platform.id, 'personal-demo');
    const generated = await Promise.all(['README.md', 'adapter.js', 'contracts.json'].map((name) => fs.readFile(path.join(outputDir, name), 'utf8')));
    assert.ok(generated.every((text) => !text.includes('private.example.test') && !text.includes('owner@example.com') && !text.includes('secret-token')));
    const duplicate = await runCli(['scaffold', '--input', inputPath, '--output', outputDir, '--id', 'personal-demo', '--json'], { cwd });
    assert.equal(duplicate.code, 2);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI scaffold rejects drafts and output paths outside the workspace', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-scaffold-'));
  try {
    const inputPath = path.join(cwd, 'draft.json');
    await fs.writeFile(inputPath, JSON.stringify({ version: 1, status: 'draft', review_required: true, approved: false, contracts: [], scenarios: [{ id: 'check' }] }));
    const draft = await runCli(['scaffold', '--input', inputPath, '--id', 'demo', '--json'], { cwd });
    assert.equal(draft.code, 2);
    assert.match(JSON.parse(draft.stdout).detail_code, /scaffold_plan_not_approved/);
    const approvedPath = path.join(cwd, 'approved.json');
    await fs.writeFile(approvedPath, JSON.stringify({ version: 1, status: 'approved', review_required: false, approved: true, contracts: [], scenarios: [{ id: 'check' }] }));
    const outside = await runCli(['scaffold', '--input', approvedPath, '--output', path.join(cwd, '..', 'outside'), '--id', 'demo', '--json'], { cwd });
    assert.equal(outside.code, 2);
    assert.match(JSON.parse(outside.stdout).detail_code, /scaffold_output_invalid/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('Demo platform regression detects semantic acceptance and cleans all resources', async () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-demo-e2e-'));
  const port = 4320 + Math.floor(Math.random() * 100);
  const server = spawn(process.execPath, ['examples/demo-platform/server.js'], { cwd, env: { ...process.env, DEMO_PORT: String(port) } });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/health`);
    const run = await runCli(['run', '--manifest', 'platform.manifest.json', '--mode', 'write', '--allow-writes', '--rounds', '1', '--artifacts', artifacts, '--json'], { cwd, env: { DEMO_PLATFORM_BASE_URL: `http://127.0.0.1:${port}`, ALLOW_TEST_WRITES: 'true' } });
    const body = JSON.parse(run.stdout);
    assert.equal(run.code, 4);
    assert.ok(body.scenarios.some((scenario) => scenario.status === 'confirmed_bug' && scenario.contract?.category === 'semantic_constraint_missing'));
    assert.equal(body.cleanup.ok, true);
    const residue = await runCli(['residue', '--manifest', 'platform.manifest.json', '--remote', '--artifacts', artifacts, '--json'], { cwd, env: { DEMO_PLATFORM_BASE_URL: `http://127.0.0.1:${port}` } });
    const residueBody = JSON.parse(residue.stdout);
    assert.equal(residue.code, 0);
    assert.deepEqual(residueBody.remote, []);
    assert.deepEqual(residueBody.pending, []);
  } finally {
    server.kill('SIGTERM');
    await once(server, 'close').catch(() => {});
    await fs.rm(artifacts, { recursive: true, force: true });
  }
});

test('CLI filters scenarios by suite and compares historical run results', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-compare-'));
  try {
    await fs.writeFile(path.join(cwd, 'platform.manifest.json'), JSON.stringify({ schema_version: 1, ruleset_version: 'rules-1', adapter: './adapter.js', platform: { id: 'test', base_url_env: 'BASE', write_gate_env: 'ALLOW', test_data_prefix: 'SOAK_' }, capabilities: ['health'], scenarios: [{ id: 'smoke', mode: 'readonly', suite: 'smoke', tags: ['fast'], priority: 'high' }, { id: 'other', mode: 'readonly', suite: 'regression' }] }));
    await fs.writeFile(path.join(cwd, 'adapter.js'), `export function createAdapter() { return { async preflight() { return { ok: true }; }, async discover() { return {}; }, scenarios: [{ id: 'smoke', async run() { return { ok: true }; } }, { id: 'other', async run() { return { ok: true }; } }], async deleteResource() {} }; }`);
    const run = await runCli(['run', '--rounds', '1', '--suite', 'smoke', '--json'], { cwd, env: { BASE: 'http://127.0.0.1:1' } });
    const body = JSON.parse(run.stdout);
    assert.equal(run.code, 0);
    assert.equal(body.ruleset_version, 'rules-1');
    assert.deepEqual(body.scenarios.map((item) => item.id), ['smoke']);
    assert.deepEqual(body.scenarios[0].tags, ['fast']);
    const baseline = path.join(cwd, 'baseline.json');
    const current = path.join(cwd, 'current.json');
    await fs.writeFile(baseline, JSON.stringify({ command: 'run', runId: 'old', ruleset_version: 'rules-1', scenarios: [{ id: 'smoke', caseId: 'baseline', status: 'passed', ok: true }] }));
    await fs.writeFile(current, JSON.stringify({ command: 'run', runId: 'new', ruleset_version: 'rules-2', scenarios: [{ id: 'smoke', caseId: 'baseline', status: 'failed', ok: false, category: 'script' }, { id: 'added', caseId: 'baseline', status: 'passed', ok: true }] }));
    const compared = await runCli(['compare', '--baseline', baseline, '--current', current, '--json'], { cwd });
    const comparison = JSON.parse(compared.stdout);
    assert.equal(compared.code, 0);
    assert.equal(comparison.regressions, 1);
    assert.equal(comparison.changed, 2);
    assert.equal(comparison.current.ruleset_version, 'rules-2');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI doctor reports missing environment prerequisites', async () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const result = await runCli(['doctor', '--json'], { cwd, env: { DEMO_PLATFORM_BASE_URL: '' } });
  const body = JSON.parse(result.stdout);
  assert.equal(result.code, 3);
  assert.equal(body.code, 'PREFLIGHT_FAILED');
  assert.equal(body.checks.find((check) => check.id === 'base-url-env').ok, false);
});

test('CLI init-adapter creates a starter adapter', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-init-'));
  try {
    const result = await runCli(['init-adapter', 'sample-platform', '--json'], { cwd });
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).id, 'sample-platform');
    assert.equal((await fs.stat(path.join(cwd, 'adapters', 'sample-platform', 'platform.manifest.yaml'))).isFile(), true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI retries a failed scenario and reports attempts', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-run-'));
  try {
    await fs.writeFile(path.join(cwd, 'platform.manifest.json'), JSON.stringify({ schema_version: 1, adapter: './adapter.js', platform: { id: 'test', base_url_env: 'BASE', write_gate_env: 'ALLOW', test_data_prefix: 'SOAK_' }, capabilities: ['health'], scenarios: [{ id: 'flaky', mode: 'readonly', timeout_ms: 1000, retries: 1 }] }));
    await fs.writeFile(path.join(cwd, 'adapter.js'), `let attempts = 0; export function createAdapter() { return { async preflight() { return { ok: true }; }, async discover() { return {}; }, scenarios: [{ id: 'flaky', async run() { attempts += 1; if (attempts === 1) throw new Error('temporary_failure'); return { ok: true }; } }], async deleteResource() {} }; }`);
    const result = await runCli(['run', '--rounds', '1', '--json'], { cwd, env: { BASE: 'http://127.0.0.1:1' } });
    const body = JSON.parse(result.stdout);
    assert.equal(result.code, 0);
    assert.equal(body.scenarios[0].attempts, 2);
    assert.equal(body.scenarios[0].ok, true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI fails clearly when readonly mode selects no scenarios', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-empty-'));
  try {
    await fs.writeFile(path.join(cwd, 'platform.manifest.json'), JSON.stringify({ schema_version: 1, adapter: './adapter.js', platform: { id: 'test', base_url_env: 'BASE', write_gate_env: 'ALLOW', test_data_prefix: 'SOAK_' }, capabilities: ['health'], scenarios: [{ id: 'write-only', mode: 'write' }] }));
    await fs.writeFile(path.join(cwd, 'adapter.js'), `export function createAdapter() { return { async preflight() { return { ok: true }; }, async discover() { return {}; }, scenarios: [{ id: 'write-only', async run() { return { ok: true }; } }], async deleteResource() {} }; }`);
    const result = await runCli(['run', '--rounds', '1', '--json'], { cwd, env: { BASE: 'http://127.0.0.1:1' } });
    assert.equal(result.code, 4);
    assert.equal(JSON.parse(result.stdout).status, 'no_scenarios_selected');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI turns a scenario timeout into a failed result', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-timeout-'));
  try {
    await fs.writeFile(path.join(cwd, 'platform.manifest.json'), JSON.stringify({ schema_version: 1, adapter: './adapter.js', platform: { id: 'test', base_url_env: 'BASE', write_gate_env: 'ALLOW', test_data_prefix: 'SOAK_' }, capabilities: ['health'], scenarios: [{ id: 'slow', mode: 'readonly', timeout_ms: 10 }] }));
    await fs.writeFile(path.join(cwd, 'adapter.js'), `export function createAdapter() { return { async preflight() { return { ok: true }; }, async discover() { return {}; }, scenarios: [{ id: 'slow', async run() { await new Promise((resolve) => setTimeout(resolve, 50)); return { ok: true }; } }], async deleteResource() {} }; }`);
    const result = await runCli(['run', '--rounds', '1', '--json'], { cwd, env: { BASE: 'http://127.0.0.1:1' } });
    const body = JSON.parse(result.stdout);
    assert.equal(result.code, 4);
    assert.equal(body.scenarios[0].ok, false);
    assert.match(body.scenarios[0].error, /scenario_timeout/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI reports a semantic contract bug when a nearby value is accepted', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-semantic-'));
  try {
    await fs.writeFile(path.join(cwd, 'platform.manifest.json'), JSON.stringify({ schema_version: 1, adapter: './adapter.js', platform: { id: 'test', base_url_env: 'BASE', write_gate_env: 'ALLOW', test_data_prefix: 'SOAK_' }, capabilities: ['device'], scenarios: [{ id: 'register-device', mode: 'readonly' }] }));
    await fs.writeFile(path.join(cwd, 'adapter.js'), `export function createAdapter() { return { async preflight() { return { ok: true }; }, async discover() { return {}; }, scenarios: [{ id: 'register-device', contract: { field: 'platform', semantic_type: 'operating_system_platform', cases: [{ id: 'nearby-device-name', kind: 'nearby_semantic', input: { platform: 'test computer 0001' }, expected: { accepted: false, resourceCreated: false } }] }, async run({ testCase }) { return { accepted: true, resourceCreated: true, resource: { platform: testCase.input.platform } }; } }], async deleteResource() {} }; }`);
    const result = await runCli(['run', '--rounds', '1', '--json'], { cwd, env: { BASE: 'http://127.0.0.1:1' } });
    const body = JSON.parse(result.stdout);
    assert.equal(result.code, 4);
    assert.equal(body.scenarios[0].status, 'confirmed_bug');
    assert.equal(body.scenarios[0].contract.category, 'semantic_constraint_missing');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('CLI persists runtime observations and applies adapter observation results', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-cli-observations-'));
  try {
    const artifactDir = path.join(cwd, 'artifacts');
    await fs.writeFile(path.join(cwd, 'platform.manifest.json'), JSON.stringify({ schema_version: 1, adapter: './adapter.js', platform: { id: 'test', base_url_env: 'BASE', write_gate_env: 'ALLOW', test_data_prefix: 'SOAK_' }, capabilities: ['device'], scenarios: [{ id: 'register-device', mode: 'readonly' }] }));
    await fs.writeFile(path.join(cwd, 'adapter.js'), `export function createAdapter() { return { async preflight() { return { ok: true }; }, async discover() { return {}; }, async observe({ observer }) { observer.recordPage({ url: 'https://demo.test/device', title: 'Device' }); return { resourceCreated: false }; }, scenarios: [{ id: 'register-device', contract: { field: 'platform', semantic_type: 'operating_system_platform', cases: [{ id: 'valid-platform', kind: 'valid', input: { platform: 'Linux' }, expected: { accepted: true, resourceCreated: false } }] }, async run({ observer }) { observer.recordRequest({ method: 'POST', url: 'https://demo.test/devices', body: { platform: 'Linux' } }); return { accepted: true, resourceCreated: true }; } }], async deleteResource() {} }; }`);
    const result = await runCli(['run', '--rounds', '1', '--artifacts', artifactDir, '--json'], { cwd, env: { BASE: 'http://127.0.0.1:1' } });
    const body = JSON.parse(result.stdout);
    const observations = JSON.parse(await fs.readFile(path.join(artifactDir, body.runId, 'observations.json'), 'utf8'));
    assert.equal(result.code, 0);
    assert.equal(body.scenarios[0].ok, true);
    assert.ok(body.observations.count >= 5);
    assert.ok(observations.events.some((event) => event.type === 'request'));
    assert.ok(observations.events.some((event) => event.type === 'page'));
    assert.equal(body.scenarios[0].details.resourceCreated, false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

function runCli(args, { cwd, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`demo_health_timeout: ${url}`);
}
