import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeArtifactManifest, verifyArtifactManifest } from '../src/artifacts/index.js';

test('artifact verification rejects duplicate and case-colliding manifest paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-soak-artifact-verify-'));
  try {
    await fs.writeFile(path.join(directory, 'run.json'), '{}');
    await writeArtifactManifest(directory, { runId: 'run-test', result_schema_version: 1 });
    const file = path.join(directory, 'artifact-manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    const entry = manifest.files.find((item) => item.path === 'run.json');
    manifest.files.push({ ...entry });
    manifest.files.push({ ...entry, path: 'RUN.JSON' });
    await fs.writeFile(file, JSON.stringify(manifest));
    const result = await verifyArtifactManifest({ directory, runId: 'run-test' });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === 'artifact_manifest_duplicate_path'));
    assert.ok(result.issues.some((issue) => issue.code === 'artifact_manifest_case_collision'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
