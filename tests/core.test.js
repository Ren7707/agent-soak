import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../src/manifest.js';
import { ResourceRegistry } from '../src/resources.js';
import { parseDuration } from '../src/scheduler.js';

const manifest = { schema_version: 1, platform: { id: 'demo', base_url_env: 'BASE', write_gate_env: 'ALLOW', test_data_prefix: 'SOAK_', production: false }, capabilities: ['health'], scenarios: [{ id: 'health', mode: 'readonly' }] };

test('manifest validation rejects duplicate scenario ids', () => assert.throws(() => validateManifest({ ...manifest, scenarios: [{ id: 'x', mode: 'readonly' }, { id: 'x', mode: 'write' }] }), /manifest_duplicate_scenario/));
test('duration parser handles hours and rejects unknown units', () => { assert.equal(parseDuration('2h'), 7200000); assert.throws(() => parseDuration('3days'), /duration_invalid/); });
test('resource registry enforces run ownership and prefix', async () => { const registry = new ResourceRegistry({ artifactDir: 'artifacts-test', runId: 'run-a', prefix: 'SOAK_run-a-' }); const item = registry.register({ id: '1', type: 'item', name: 'SOAK_run-a-item' }); assert.equal(registry.owns(item), true); await registry.cleanup(async () => {}); assert.equal(registry.resources[0].state, 'cleaned'); });
