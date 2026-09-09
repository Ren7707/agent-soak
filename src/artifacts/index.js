import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeArtifactManifest(directory, result) {
  const files = await describeFiles(directory);
  const value = { version: 1, run_id: result.runId, result_schema_version: result.result_schema_version, files };
  await fs.writeFile(path.join(directory, 'artifact-manifest.json'), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function verifyArtifactManifest({ directory, runId } = {}) {
  const manifestFile = path.join(directory, 'artifact-manifest.json');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); }
  catch (error) { return { ok: false, command: 'verify', status: 'artifact_manifest_unreadable', runId, files_checked: 0, issues: [{ code: error?.code === 'ENOENT' ? 'artifact_manifest_missing' : 'artifact_manifest_invalid' }] }; }
  if (manifest.version !== 1 || manifest.run_id !== runId || !Array.isArray(manifest.files)) return { ok: false, command: 'verify', status: 'artifact_manifest_invalid', runId, files_checked: 0, issues: [{ code: 'artifact_manifest_invalid' }] };
  const actual = new Map((await describeFiles(directory)).map((file) => [file.path, file]));
  const issues = [];
  const expected = new Set();
  const canonicalExpected = new Map();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !isSafeRelativePath(file.path) || !Number.isInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) { issues.push({ code: 'artifact_manifest_entry_invalid', path: file?.path }); continue; }
    const canonicalPath = file.path.toLowerCase();
    if (expected.has(file.path)) issues.push({ code: 'artifact_manifest_duplicate_path', path: file.path });
    if (canonicalExpected.has(canonicalPath) && canonicalExpected.get(canonicalPath) !== file.path) issues.push({ code: 'artifact_manifest_case_collision', path: file.path, expected: canonicalExpected.get(canonicalPath) });
    expected.add(file.path);
    canonicalExpected.set(canonicalPath, file.path);
    const observed = actual.get(file.path);
    if (!observed) { issues.push({ code: 'artifact_file_missing', path: file.path }); continue; }
    if (observed.bytes !== file.bytes) issues.push({ code: 'artifact_file_size_mismatch', path: file.path, expected: file.bytes, actual: observed.bytes });
    if (observed.sha256 !== file.sha256) issues.push({ code: 'artifact_file_hash_mismatch', path: file.path });
  }
  for (const file of actual.values()) if (!expected.has(file.path)) issues.push({ code: 'artifact_file_unexpected', path: file.path });
  return { ok: issues.length === 0, command: 'verify', status: issues.length === 0 ? 'verified' : 'artifact_integrity_failed', runId, files_checked: manifest.files.length, issues };
}

async function describeFiles(directory) {
  const files = [];
  for (const file of await listFiles(directory)) {
    if (path.basename(file) === 'artifact-manifest.json') continue;
    const content = await fs.readFile(file);
    files.push({ path: path.relative(directory, file).replaceAll('\\', '/'), bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

function isSafeRelativePath(value) { return value && !path.isAbsolute(value) && value.split('/').every((part) => part && part !== '.' && part !== '..'); }
