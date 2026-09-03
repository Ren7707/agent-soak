import fs from 'node:fs/promises';
import path from 'node:path';

const REQUIRED = ['schema_version', 'platform', 'capabilities', 'scenarios'];

export async function loadManifest(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  let manifest;
  try { manifest = JSON.parse(raw); } catch (error) { throw new Error(`manifest_invalid_json: ${error.message}`); }
  validateManifest(manifest);
  return manifest;
}

export function validateManifest(manifest) {
  for (const key of REQUIRED) if (!(key in (manifest || {}))) throw new Error(`manifest_missing_field: ${key}`);
  const platform = manifest.platform;
  for (const key of ['id', 'base_url_env', 'write_gate_env', 'test_data_prefix']) {
    if (typeof platform[key] !== 'string' || !platform[key]) throw new Error(`manifest_invalid_platform_field: ${key}`);
  }
  if (!Array.isArray(manifest.capabilities)) throw new Error('manifest_capabilities_must_be_array');
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) throw new Error('manifest_scenarios_required');
  const ids = new Set();
  for (const scenario of manifest.scenarios) {
    if (!scenario.id || ids.has(scenario.id)) throw new Error(`manifest_duplicate_scenario: ${scenario.id || '<empty>'}`);
    if (!['readonly', 'write'].includes(scenario.mode)) throw new Error(`manifest_invalid_scenario_mode: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return manifest;
}

export function resolveBaseUrl(manifest, env = process.env) {
  const value = env[manifest.platform.base_url_env];
  if (!value) throw new Error(`configuration_missing: ${manifest.platform.base_url_env}`);
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('configuration_invalid_base_url');
  return url.toString().replace(/\/$/, '');
}

export function manifestPathFrom(cwd, value = 'platform.manifest.json') {
  return path.resolve(cwd, value);
}
