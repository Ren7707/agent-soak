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
