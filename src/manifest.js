import path from 'node:path';
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
const REQUIRED = ['schema_version', 'adapter', 'platform', 'capabilities', 'scenarios'];
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;

export async function loadManifest(filePath) {
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(filePath, 'utf8');
  let manifest;
  try {
    manifest = path.extname(filePath).toLowerCase() === '.json' ? JSON.parse(raw) : parseYaml(raw);
  } catch (error) {
    throw new Error(`manifest_invalid: ${error.message}`);
  }
  return validateManifest(manifest);
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest_invalid');
  for (const key of REQUIRED) if (!(key in manifest)) throw new Error(`manifest_missing_field: ${key}`);
  if (manifest.schema_version !== 1) throw new Error(`manifest_schema_unsupported: ${manifest.schema_version}`);
  if (typeof manifest.adapter !== 'string' || !manifest.adapter || pathLikeUnsafe(manifest.adapter)) throw new Error('manifest_invalid_adapter');
  const platform = manifest.platform;
  if (!platform || typeof platform !== 'object') throw new Error('manifest_platform_required');
  for (const key of ['id', 'base_url_env', 'write_gate_env', 'test_data_prefix']) {
    if (typeof platform[key] !== 'string' || !platform[key]) throw new Error(`manifest_invalid_platform_field: ${key}`);
  }
  if (!SAFE_ID.test(platform.id)) throw new Error('manifest_invalid_platform_id');
  if (/[\\/]/.test(platform.test_data_prefix)) throw new Error('manifest_invalid_test_data_prefix');
  if (!Array.isArray(manifest.capabilities)) throw new Error('manifest_capabilities_must_be_array');
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) throw new Error('manifest_scenarios_required');
  const ids = new Set();
  for (const scenario of manifest.scenarios) {
    if (!scenario || typeof scenario !== 'object' || !SAFE_ID.test(scenario.id || '') || ids.has(scenario.id)) throw new Error(`manifest_duplicate_or_invalid_scenario: ${scenario?.id || '<empty>'}`);
    if (!['readonly', 'write'].includes(scenario.mode)) throw new Error(`manifest_invalid_scenario_mode: ${scenario.id}`);
    if (scenario.capabilities !== undefined && !Array.isArray(scenario.capabilities)) throw new Error(`manifest_invalid_scenario_capabilities: ${scenario.id}`);
    if (scenario.timeout_ms !== undefined && (!Number.isInteger(scenario.timeout_ms) || scenario.timeout_ms < 1)) throw new Error(`manifest_invalid_timeout: ${scenario.id}`);
    if (scenario.retries !== undefined && (!Number.isInteger(scenario.retries) || scenario.retries < 0 || scenario.retries > 10)) throw new Error(`manifest_invalid_retries: ${scenario.id}`);
    for (const capability of scenario.capabilities || []) if (!manifest.capabilities.includes(capability)) throw new Error(`manifest_unknown_capability: ${scenario.id}:${capability}`);
    ids.add(scenario.id);
  }
  return manifest;
}

export function resolveBaseUrl(manifest, env = process.env) {
  const value = env[manifest.platform.base_url_env];
  if (!value) throw new Error(`configuration_missing: ${manifest.platform.base_url_env}`);
  let url;
  try { url = new URL(value); } catch { throw new Error('configuration_invalid_base_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('configuration_invalid_base_url');
  return url.toString().replace(/\/$/, '');
}

export function manifestPathFrom(cwd, value = 'platform.manifest.json') {
  if (value !== 'platform.manifest.json') return path.resolve(cwd, value);
  for (const candidate of ['platform.manifest.json', 'platform.manifest.yaml', 'platform.manifest.yml']) {
    const resolved = path.resolve(cwd, candidate);
    if (existsSync(resolved)) return resolved;
  }
  return path.resolve(cwd, value);
}
function pathLikeUnsafe(value) { return value.includes('\0') || path.isAbsolute(value) || value.split(/[\\/]/).includes('..'); }
