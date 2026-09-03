#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { initAdapter } from './adapters/init.js';
import { loadAdapter } from './adapters/loader.js';
import { BrowserSession } from './browser/session.js';
import { classifyFailure } from './core/failures.js';
import { ERROR_CODES, EXIT_CODES, exitCodeForResult, resultCode } from './core/exit-codes.js';
import { runSchedule, parseDuration } from './core/scheduler.js';
import { loadManifest, manifestPathFrom, resolveBaseUrl } from './manifest.js';
import { ResourceRegistry, createRunId } from './resources/registry.js';
import { writePreflight, writeReports } from './reporters/index.js';

const PACKAGE_VERSION = JSON.parse(await fs.readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')).version;

const HELP = `agent-soak <command> [options]

Commands:
  inspect                 Read and print a manifest without contacting a target
  init-adapter <id>       Create a new adapter, manifest, and README template
  discover                Ask the adapter for capabilities and live metadata
  validate                Run configuration and service preflight checks
  run                     Run scenarios by round count or duration
  cleanup                 Retry cleanup for a previous run
  residue                 Find pending cleanup records in an artifact directory
  doctor                  Check runtime, manifest, adapter, and local prerequisites

Options:
  --manifest <path>       Manifest path (default: platform.manifest.json)
  --mode <readonly|write> Run mode (default: readonly)
  --rounds <number>       Number of rounds
  --duration <value>      Duration such as 30s, 10m, or 2h
  --interval <value>      Delay between rounds
  --run-id <id>           Reuse a safe run identifier for recovery
  --artifacts <path>      Artifact directory (default: artifacts)
  --allow-writes          Explicitly authorize write or cleanup operations
  --browser               Include browser-capable scenarios
  --supervise             Show the browser and install the supervision marker
  --dry-run               Preview cleanup without deleting resources
  --remote                Include adapter-backed residue scanning
  --force                 Overwrite files created by init-adapter
  --version               Show the package version
  --json                  Emit one-line machine-readable JSON
  --help                  Show this help
`;

export async function main(argv = process.argv.slice(2)) {
  const wantsJson = argv.includes('--json');
  let args;
  try {
    args = parseArgs(argv);
    if (args.version) { output({ ok: true, command: 'version', version: PACKAGE_VERSION }, wantsJson); return EXIT_CODES.success; }
    if (args.help || !args.command) { output({ ok: true, command: 'help', usage: HELP }, wantsJson); return EXIT_CODES.success; }
    const manifestPath = manifestPathFrom(process.cwd(), String(args.manifest || 'platform.manifest.json'));
    if (args.command === 'init-adapter') return finish(await initAdapter({ cwd: process.cwd(), id: args.positionals[0], force: args.force === true }), wantsJson);
    if (args.positionals.length) throw new Error(`argument_unknown: ${args.positionals[0]}`);
    const manifest = await loadManifest(manifestPath);
    if (args.command === 'inspect') { output({ ok: true, command: 'inspect', manifest }, wantsJson); return EXIT_CODES.success; }
    if (args.command === 'residue') {
      if (args.remote === true) {
        const adapter = await loadAdapter(manifestPath, manifest);
        const result = await residue(args, manifest, adapter);
        return finish(result, wantsJson);
      }
      return finish(await residue(args), wantsJson);
    }
    const adapter = await loadAdapter(manifestPath, manifest);
    if (args.command === 'doctor') return finish(await doctor(manifestPath, manifest, adapter, args), wantsJson);
    if (args.command === 'discover') return finish(await discover(manifest, adapter), wantsJson);
    if (args.command === 'validate') return finish(await validate(manifest, adapter, args), wantsJson);
    if (args.command === 'run') return finish(await run(manifest, adapter, args), wantsJson);
    if (args.command === 'cleanup') return finish(await cleanup(manifest, adapter, args), wantsJson);
    throw new Error(`command_unknown: ${args.command}`);
  } catch (error) {
    output({ ok: false, code: ERROR_CODES.INPUT_INVALID, error: error instanceof Error ? error.message : String(error), detail_code: codeFromError(error) }, wantsJson);
    return EXIT_CODES.input;
  }
}

async function discover(manifest, adapter) {
  const baseUrl = resolveBaseUrl(manifest);
  return { ok: true, command: 'discover', ...(await adapter.discover({ manifest, baseUrl })) };
}

async function validate(manifest, adapter, args) {
  const mode = modeFrom(args);
  if (mode === 'write') assertWriteAllowed(manifest, args);
  const baseUrl = resolveBaseUrl(manifest);
  const preflight = await runPreflight(adapter, manifest, baseUrl);
  return { ok: preflight.ok, command: 'validate', mode, preflight, writeScenarios: manifest.scenarios.filter((item) => item.mode === 'write').map((item) => item.id) };
}

async function run(manifest, adapter, args) {
  const mode = modeFrom(args);
  if (mode === 'write') assertWriteAllowed(manifest, args);
  const target = scheduleTarget(args);
  const baseUrl = resolveBaseUrl(manifest);
  const runId = safeRunId(args.runId || createRunId());
  const artifactDir = path.resolve(String(args.artifacts || 'artifacts'));
  const prefix = `${manifest.platform.test_data_prefix}${runId}-`;
  const registry = new ResourceRegistry({ artifactDir, runId, prefix });
  const preflight = await runPreflight(adapter, manifest, baseUrl);
  await writePreflight({ artifactDir, runId, result: preflight });
  if (!preflight.ok) return { ok: false, command: 'run', status: 'preflight_failed', runId, mode, rounds: 0, cancelled: false, scenarios: [], skipped: [], cleanup: { ok: true, results: [], pending: [] }, preflight };

  const skipped = [];
  const selected = [];
  for (const scenario of manifest.scenarios) {
    const implementation = adapter.scenarios.find((item) => item.id === scenario.id);
    if (scenario.mode === 'write' && mode === 'readonly') { skipped.push({ id: scenario.id, reason: 'write_mode_not_authorized' }); continue; }
    if ((scenario.capabilities || []).includes('browser') && args.browser !== true) { skipped.push({ id: scenario.id, reason: 'browser_not_requested' }); continue; }
    selected.push({ manifest: scenario, implementation });
  }

  const startedAt = new Date().toISOString();
  if (selected.length === 0) {
    const result = { ok: false, command: 'run', status: 'no_scenarios_selected', runId, mode, rounds: 0, cancelled: false, scenarios: [], skipped, audit: [], cleanup: { ok: true, results: [], pending: [] }, preflight, startedAt, finishedAt: new Date().toISOString() };
    await writeReports({ artifactDir, result });
    return result;
  }

  let browser;
  const browserNeeded = selected.some(({ manifest: scenario }) => (scenario.capabilities || []).includes('browser'));
  if (browserNeeded) {
    browser = new BrowserSession({ artifactDir, runId, supervised: args.supervise === true });
    try { await browser.start(); }
    catch (error) {
      const failed = { id: 'browser.lifecycle', round: 0, status: 'failed', ok: false, durationMs: 0, category: classifyFailure(error), error: error instanceof Error ? error.message : String(error) };
      const result = { ok: false, command: 'run', status: 'browser_start_failed', runId, mode, rounds: 0, cancelled: false, scenarios: [failed], skipped, audit: [], cleanup: { ok: true, results: [], pending: [] }, preflight, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
      await writeReports({ artifactDir, result });
      return result;
    }
  }

  const scenarios = [];
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt);
  let schedule = { completed: 0, cancelled: false, durationMs: 0 };
  let runtimeError;
  let cleanupResult = { ok: true, results: [], pending: [] };
  try {
    schedule = await runSchedule({ ...target, intervalMs: args.interval ? parseDuration(String(args.interval)) : 0, signal: controller.signal, onRound: async (round) => {
      for (const entry of selected) {
        if (controller.signal.aborted) break;
        scenarios.push(await runScenario(entry, { baseUrl, runId, round, signal: controller.signal, supervised: args.supervise === true, browser, registry, manifest }));
      }
      await registry.persist();
    }});
  } catch (error) {
    runtimeError = error;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    try {
      cleanupResult = await registry.cleanup((resource) => adapter.deleteResource(resource, { baseUrl, runId, manifest }));
    } catch (error) {
      cleanupResult = { ok: false, results: [], pending: registry.resources.filter((item) => item.state !== 'cleaned'), error: error instanceof Error ? error.message : String(error) };
    }
    await browser?.close();
  }

  if (runtimeError) scenarios.push({ id: 'runner.lifecycle', round: schedule.completed, status: 'failed', ok: false, durationMs: 0, attempts: 1, category: classifyFailure(runtimeError), error: runtimeError instanceof Error ? runtimeError.message : String(runtimeError) });
  const cancelled = schedule.cancelled || controller.signal.aborted;
  const result = { ok: scenarios.every((item) => item.ok) && cleanupResult.ok && !cancelled, command: 'run', status: runtimeError ? 'runner_failed' : 'completed', runId, mode, rounds: schedule.completed, cancelled, scenarios, skipped, audit: browser?.audit || [], cleanup: cleanupResult, preflight, startedAt, finishedAt: new Date().toISOString() };
  await writeReports({ artifactDir, result });
  return result;
}

async function doctor(manifestPath, manifest, adapter, args) {
  const checks = [{ id: 'node-version', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.version, expected: '>=20' }, { id: 'manifest', ok: true, detail: manifestPath }, { id: 'adapter', ok: Boolean(adapter), detail: manifest.adapter }, { id: 'base-url-env', ok: Boolean(process.env[manifest.platform.base_url_env]), detail: manifest.platform.base_url_env }];
  if (args.browser) {
    try { await import('playwright'); checks.push({ id: 'playwright', ok: true }); }
    catch (error) { checks.push({ id: 'playwright', ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  }
  return { ok: checks.every((check) => check.ok), command: 'doctor', checks };
}

async function runScenario(entry, context) {
  const started = Date.now();
  const retries = entry.manifest.retries || 0;
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    attempts = attempt;
    try {
      const details = await runScenarioAttempt(entry, context);
      if (details?.ok === false) throw new Error(details.error || 'scenario_failed');
      return { id: entry.implementation.id, round: context.round, status: 'passed', ok: true, attempts: attempt, durationMs: Date.now() - started, details };
    } catch (error) {
      lastError = error;
      if (context.signal.aborted || attempt > retries) break;
    }
  }
  return { id: entry.implementation.id, round: context.round, status: 'failed', ok: false, attempts, durationMs: Date.now() - started, category: classifyFailure(lastError), error: lastError instanceof Error ? lastError.message : String(lastError) };
}

async function runScenarioAttempt(entry, context) {
  const timeoutMs = entry.manifest.timeout_ms;
  if (!timeoutMs) return entry.implementation.run({ ...context, scenario: entry.manifest });
  const controller = new AbortController();
  const onAbort = () => controller.abort(context.signal.reason);
  context.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`scenario_timeout: ${entry.implementation.id} after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await Promise.race([
      entry.implementation.run({ ...context, signal: controller.signal, scenario: entry.manifest }),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new Error('scenario_cancelled')), { once: true })),
    ]);
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', onAbort);
  }
}

async function cleanup(manifest, adapter, args) {
  const runId = safeRunId(args.runId);
  const dryRun = args.dryRun === true;
  if (!dryRun) assertWriteAllowed(manifest, args);
  const artifactDir = path.resolve(String(args.artifacts || 'artifacts'));
  const baseUrl = resolveBaseUrl(manifest);
  const registry = await ResourceRegistry.restore(artifactDir, runId, `${manifest.platform.test_data_prefix}${runId}-`);
  const result = await registry.cleanup((resource) => adapter.deleteResource(resource, { baseUrl, runId, manifest }), { dryRun });
  return { ...result, command: 'cleanup', runId, dryRun };
}

async function residue(args, manifest, adapter) {
  const artifactDir = path.resolve(String(args.artifacts || 'artifacts'));
  const entries = await fs.readdir(artifactDir, { withFileTypes: true }).catch(() => []);
  const pending = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(artifactDir, entry.name, 'cleanup-pending.json');
    if (await fs.access(file).then(() => true).catch(() => false)) pending.push(file);
  }
  const result = { ok: pending.length === 0, command: 'residue', pending };
  if (manifest && adapter) {
    if (typeof adapter.scanResidue !== 'function') return { ...result, ok: false, error: 'adapter_scan_residue_required' };
    const baseUrl = resolveBaseUrl(manifest);
    const prefix = String(args.prefix || manifest.platform.test_data_prefix);
    try {
      result.remote = await adapter.scanResidue({ manifest, baseUrl, prefix });
      if (!Array.isArray(result.remote)) throw new Error('adapter_scan_residue_invalid_result');
      result.ok = result.ok && result.remote.length === 0;
    } catch (error) {
      return { ...result, ok: false, remoteError: error instanceof Error ? error.message : String(error) };
    }
  }
  return result;
}

async function runPreflight(adapter, manifest, baseUrl) {
  try {
    const result = await adapter.preflight({ manifest, baseUrl });
    return result && typeof result === 'object' ? { ok: result.ok !== false, ...result } : { ok: true };
  } catch (error) {
    return { ok: false, issues: [{ category: classifyFailure(error), error: error instanceof Error ? error.message : String(error) }] };
  }
}

function scheduleTarget(args) {
  const hasRounds = args.rounds !== undefined;
  const hasDuration = args.duration !== undefined;
  if (hasRounds === hasDuration) throw new Error('schedule_requires_exactly_one_target');
  if (hasRounds) { const rounds = Number(args.rounds); if (!Number.isInteger(rounds) || rounds < 1) throw new Error('schedule_invalid_rounds'); return { rounds }; }
  return { durationMs: parseDuration(String(args.duration)) };
}
function modeFrom(args) { const mode = String(args.mode || 'readonly'); if (mode !== 'readonly' && mode !== 'write') throw new Error(`mode_invalid: ${mode}`); return mode; }
function assertWriteAllowed(manifest, args) { if (manifest.platform.production === true) throw new Error('write_rejected_production_target'); if (args.allowWrites !== true || process.env[manifest.platform.write_gate_env] !== 'true') throw new Error(`write_gate_required: use --allow-writes and ${manifest.platform.write_gate_env}=true`); }
function safeRunId(value) { if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(String(value))) throw new Error('run_id_invalid'); return String(value); }
function codeFromError(error) { const message = error instanceof Error ? error.message : String(error); return message.split(':')[0]; }
function finish(result, json) { const code = resultCode(result); output({ ...result, ...(code ? { code } : {}) }, json); if (result.ok !== false) return EXIT_CODES.success; if (result.command === 'validate' || result.command === 'discover' || result.command === 'doctor' || result.status === 'preflight_failed') return EXIT_CODES.preflight; if (result.command === 'cleanup' || result.command === 'residue') return EXIT_CODES.cleanup; return exitCodeForResult(result); }
function parseArgs(values) { const out = { command: undefined, positionals: [] }; const booleans = new Set(['json', 'allowWrites', 'dryRun', 'supervise', 'browser', 'help', 'remote', 'force', 'version']); const valueFlags = new Set(['manifest', 'mode', 'rounds', 'duration', 'interval', 'runId', 'artifacts', 'prefix']); for (let index = 0; index < values.length; index += 1) { const token = values[index]; if (index === 0 && !token.startsWith('--')) { out.command = token; continue; } if (!token.startsWith('--')) { out.positionals.push(token); continue; } const [rawName, inlineValue] = token.slice(2).split('=', 2); const name = toCamel(rawName); if (booleans.has(name)) { if (inlineValue !== undefined) throw new Error(`argument_boolean_value: --${rawName}`); out[name] = true; continue; } if (!valueFlags.has(name)) throw new Error(`argument_unknown: --${rawName}`); const value = inlineValue ?? values[++index]; if (!value || value.startsWith('--')) throw new Error(`argument_value_required: --${rawName}`); out[name] = value; } return out; }
function toCamel(value) { return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase()); }
function output(value, json) { console.log(json ? JSON.stringify(value) : JSON.stringify(value, null, 2)); }


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

