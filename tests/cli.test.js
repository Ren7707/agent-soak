import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = new URL('..', import.meta.url);
test('CLI inspect returns machine-readable manifest', async () => {
  const child = spawn(process.execPath, ['src/cli.js', 'inspect', '--json'], { cwd: root, env: { ...process.env, DEMO_PLATFORM_BASE_URL: 'http://127.0.0.1:4317' } });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); await once(child, 'close');
  const result = JSON.parse(output); assert.equal(result.ok, true); assert.equal(result.manifest.platform.id, 'demo-platform');
});
