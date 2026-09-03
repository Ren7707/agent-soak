import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';

export async function loadAdapter(manifestPath, manifest, options = {}) {
  const adapterPath = path.resolve(path.dirname(manifestPath), manifest.adapter);
  const stats = await fs.stat(adapterPath).catch(() => null);
  if (!stats?.isFile()) throw new Error(`adapter_not_found: ${manifest.adapter}`);
  const moduleUrl = `${pathToFileURL(adapterPath).href}?v=${stats.mtimeMs}`;
  const module = await import(moduleUrl);
  const factory = module.createAdapter || module.default;
  if (typeof factory !== 'function') throw new Error('adapter_factory_required');
  const adapter = await factory({ manifest, ...options });
  validateAdapter(adapter, manifest);
  return adapter;
}

function validateAdapter(adapter, manifest) {
  if (!adapter || typeof adapter !== 'object') throw new Error('adapter_invalid');
  for (const method of ['preflight', 'discover', 'deleteResource']) {
    if (typeof adapter[method] !== 'function') throw new Error(`adapter_missing_method: ${method}`);
  }
  if (!Array.isArray(adapter.scenarios)) throw new Error('adapter_scenarios_required');
  const declared = new Set(manifest.scenarios.map((scenario) => scenario.id));
  const implemented = new Set();
  for (const scenario of adapter.scenarios) {
    if (!scenario || typeof scenario.id !== 'string' || typeof scenario.run !== 'function') throw new Error('adapter_scenario_invalid');
    if (implemented.has(scenario.id)) throw new Error(`adapter_duplicate_scenario: ${scenario.id}`);
    if (!declared.has(scenario.id)) throw new Error(`adapter_scenario_not_declared: ${scenario.id}`);
    implemented.add(scenario.id);
  }
  for (const id of declared) if (!implemented.has(id)) throw new Error(`adapter_scenario_missing: ${id}`);
}
