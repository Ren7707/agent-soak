import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateManifest, resolveBaseUrl } from '../src/manifest.js';
import { ResourceRegistry } from '../src/resources/registry.js';
import { parseDuration, runSchedule } from '../src/core/scheduler.js';
import { redact } from '../src/core/redact.js';

const manifest = { schema_version: 1, adapter: './adapter.js', platform: { id: 'demo', base_url_env: 'BASE', write_gate_env: 'ALLOW', test_data_prefix: 'SOAK_', production: false }, capabilities: ['health'], scenarios: [{ id: 'health', mode: 'readonly', capabilities: ['health'] }] };

test('manifest validation rejects duplicate scenario ids', () => assert.throws(() => validateManifest({ ...manifest, scenarios: [{ id: 'x', mode: 'readonly' }, { id: 'x', mode: 'write' }] }), /manifest_duplicate_or_invalid_scenario/));
test('manifest validation rejects undeclared capabilities', () => assert.throws(() => validateManifest({ ...manifest, scenarios: [{ id: 'x', mode: 'readonly', capabilities: ['missing'] }] }), /manifest_unknown_capability/));
test('base URL validation rejects credentials and non-http schemes', () => { assert.throws(() => resolveBaseUrl(manifest, { BASE: 'ftp://example.test' }), /configuration_invalid_base_url/); assert.throws(() => resolveBaseUrl(manifest, { BASE: 'https://user:pass@example.test' }), /configuration_invalid_base_url/); });
test('duration parser handles hours and rejects unknown units', () => { assert.equal(parseDuration('2h'), 7200000); assert.throws(() => parseDuration('3days'), /duration_invalid/); });
test('scheduler requires exactly one target and supports cancellation', async () => { await assert.rejects(runSchedule({ onRound: async () => {} }), /schedule_requires_exactly_one_target/); const controller = new AbortController(); let rounds = 0; const result = await runSchedule({ durationMs: 50, intervalMs: 50, signal: controller.signal, onRound: async () => { rounds += 1; controller.abort(); } }); assert.equal(result.cancelled, true); assert.equal(rounds, 1); });
test('resource registry enforces run ownership and cleans resources', async () => { const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-registry-')); try { const registry = new ResourceRegistry({ artifactDir, runId: 'run-a', prefix: 'SOAK_run-a-' }); const item = registry.register({ id: '1', type: 'item', name: 'SOAK_run-a-item' }); assert.equal(registry.owns(item), true); await registry.cleanup(async () => {}); assert.equal(registry.resources[0].state, 'cleaned'); } finally { await fs.rm(artifactDir, { recursive: true, force: true }); } });
test('resource registry writes pending records for failed cleanup', async () => { const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-pending-')); try { const registry = new ResourceRegistry({ artifactDir, runId: 'run-b', prefix: 'SOAK_run-b-' }); registry.register({ id: '1', type: 'item', name: 'SOAK_run-b-item' }); const result = await registry.cleanup(async () => { throw new Error('delete refused'); }); assert.equal(result.ok, false); assert.equal(result.pending.length, 1); assert.equal(await fs.access(path.join(artifactDir, 'run-b', 'cleanup-pending.json')).then(() => true), true); } finally { await fs.rm(artifactDir, { recursive: true, force: true }); } });
test('redaction hides sensitive fields and bearer values', () => assert.deepEqual(redact({ token: 'secret', message: 'Bearer abc123' }), { token: '[REDACTED]', message: 'Bearer [REDACTED]' }));
