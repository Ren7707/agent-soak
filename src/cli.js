#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { loadManifest, manifestPathFrom, resolveBaseUrl } from './manifest.js';
import { ResourceRegistry, createRunId } from './resources.js';
import { runSchedule, parseDuration } from './scheduler.js';
import { writeReports } from './reporters.js';

const args = parseArgs(process.argv.slice(2));
const cwd = process.cwd();
const manifestPath = manifestPathFrom(cwd, args.manifest);
const json = args.json === true;

async function main() {
try {
  const manifest = await loadManifest(manifestPath);
  if (args.command === 'inspect') return output({ ok: true, command: 'inspect', manifest }, json);
  if (args.command === 'discover') return output({ ok: true, command: 'discover', capabilities: manifest.capabilities, scenarios: manifest.scenarios }, json);
  if (args.command === 'validate') return output(validate(manifest, args), json);
  if (args.command === 'run') return output(await run(manifest, args), json);
  if (args.command === 'cleanup') return output(await cleanup(manifest, args), json);
  if (args.command === 'residue') return output(await residue(args), json);
  throw new Error(`command_unknown: ${args.command || '<empty>'}`);
} catch (error) {
  output({ ok: false, error: error.message, code: error.message.split(':')[0] }, json);
  process.exitCode = 2;
}
}

await main();

function validate(manifest, args) {
  const mode = args.mode || 'readonly';
  if (!['readonly', 'write'].includes(mode)) throw new Error(`mode_invalid: ${mode}`);
  const writeScenarios = manifest.scenarios.filter((item) => item.mode === 'write');
  if (mode === 'write') assertWriteAllowed(manifest, args);
  return { ok: true, command: 'validate', mode, writeScenarios: writeScenarios.map((item) => item.id) };
}

async function run(manifest, args) {
  const mode = args.mode || 'readonly';
  validate(manifest, args);
  const baseUrl = resolveBaseUrl(manifest);
  const runId = args.runId || createRunId();
  const artifactDir = path.resolve(args.artifacts || 'artifacts');
  const registry = new ResourceRegistry({ artifactDir, runId, prefix: `${manifest.platform.test_data_prefix}${runId}-` });
  const selected = manifest.scenarios.filter((scenario) => scenario.mode === 'readonly' || mode === 'write');
  const scenarios = [];
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const schedule = await runSchedule({ rounds: args.rounds ? Number(args.rounds) : undefined, durationMs: args.duration ? parseDuration(args.duration) : undefined, signal: controller.signal, onRound: async (round) => {
    for (const scenario of selected) {
      const started = Date.now();
      try {
        const result = await executeScenario(scenario, { baseUrl, runId, round, registry });
        scenarios.push({ id: scenario.id, round, ok: result.ok !== false, durationMs: Date.now() - started, details: result });
      } catch (error) { scenarios.push({ id: scenario.id, round, ok: false, durationMs: Date.now() - started, error: error.message }); }
    }
  }});
  const cleanup = await registry.cleanup(async (resource) => {
    const response = await fetch(`${baseUrl}/items/${encodeURIComponent(resource.id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`cleanup_http_${response.status}`);
  });
  const result = { ok: scenarios.every((item) => item.ok) && cleanup.ok && !schedule.cancelled, command: 'run', runId, mode, baseUrl, rounds: schedule.completed, cancelled: schedule.cancelled, scenarios, cleanup, startedAt: new Date(Date.now() - schedule.durationMs).toISOString(), finishedAt: new Date().toISOString() };
  await writeReports({ artifactDir, runId, result });
  return result;
}

async function cleanup(manifest, args) {
  const runId = args.runId;
  if (!runId) throw new Error('run_id_required');
  const artifactDir = path.resolve(args.artifacts || 'artifacts');
  const file = path.join(artifactDir, runId, 'resources.json');
  const resources = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
  const baseUrl = resolveBaseUrl(manifest);
  const registry = new ResourceRegistry({ artifactDir, runId, prefix: `${manifest.platform.test_data_prefix}${runId}-`});
  for (const resource of resources) registry.resources.push(resource);
  return registry.cleanup(async (resource) => {
    const response = await fetch(`${baseUrl}/items/${encodeURIComponent(resource.id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`cleanup_http_${response.status}`);
  }, { dryRun: args.dryRun === true });
}

async function residue(args) {
  const fs = await import('node:fs/promises');
  const artifactDir = path.resolve(args.artifacts || 'artifacts');
  const entries = await fs.readdir(artifactDir, { withFileTypes: true }).catch(() => []);
  const pending = [];
  for (const entry of entries) if (entry.isDirectory()) { const file = path.join(artifactDir, entry.name, 'cleanup-pending.json'); if (await fs.access(file).then(() => true).catch(() => false)) pending.push(file); }
  return { ok: pending.length === 0, pending };
}

async function executeScenario(scenario, context) {
  if (scenario.id === 'health') { const response = await fetch(`${context.baseUrl}/health`); if (!response.ok) throw new Error(`health_http_${response.status}`); return { ok: true }; }
  if (scenario.id === 'list-items') { const response = await fetch(`${context.baseUrl}/items`); if (!response.ok) throw new Error(`items_http_${response.status}`); return { ok: true, count: (await response.json()).items.length }; }
  if (scenario.id === 'create-delete-item') {
    const name = `${context.registry.prefix}item-${context.round}`;
    const create = await fetch(`${context.baseUrl}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    if (!create.ok) throw new Error(`create_http_${create.status}`);
    const item = await create.json();
    context.registry.register({ id: item.id, type: 'item', name });
    return { ok: true, id: item.id };
  }
  throw new Error(`scenario_not_implemented: ${scenario.id}`);
}

function assertWriteAllowed(manifest, args) {
  if (manifest.platform.production === true) throw new Error('write_rejected_production_target');
  if (args.allowWrites !== true || process.env[manifest.platform.write_gate_env] !== 'true') throw new Error(`write_gate_required: use --allow-writes and ${manifest.platform.write_gate_env}=true`);
}
function parseArgs(values) { const out = { command: values[0] }; for (let index = 1; index < values.length; index += 1) { const value = values[index]; if (value === '--json' || value === '--allow-writes') out[toCamel(value.slice(2))] = true; else if (value.startsWith('--')) out[toCamel(value.slice(2))] = values[++index]; } return out; }
function toCamel(value) { return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase()); }
function output(value, asJson) { if (asJson) console.log(JSON.stringify(value)); else console.log(JSON.stringify(value, null, 2)); }



