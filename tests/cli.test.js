import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
