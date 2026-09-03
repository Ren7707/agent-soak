import { classifyFailure } from '../core/failures.js';
import { runSchedule, parseDuration } from '../core/scheduler.js';
import { resolveBaseUrl } from '../manifest.js';
import { ResourceRegistry, createRunId } from '../resources/registry.js';
import { BrowserSession } from '../browser/session.js';
import { writePreflight, writeReports } from '../reporters/index.js';

export async function runSoak({ manifest, adapter, args, artifactDir, processRef = process }) {
  const mode = modeFrom(args);
  if (mode === 'write') assertWriteAllowed(manifest, args, processRef.env);
  const target = scheduleTarget(args);
  const baseUrl = resolveBaseUrl(manifest, processRef.env);
  const runId = safeRunId(args.runId || createRunId());
  const prefix = `${manifest.platform.test_data_prefix}${runId}-`;
  const registry = new ResourceRegistry({ artifactDir, runId, prefix });
  const preflight = await runPreflight(adapter, manifest, baseUrl);
  await writePreflight({ artifactDir, runId, result: preflight });
  if (!preflight.ok) return { ok: false, command: 'run', status: 'preflight_failed', runId, mode, rounds: 0, cancelled: false, scenarios: [], skipped: [], cleanup: { ok: true, results: [], pending: [] }, preflight };

  const skipped = [];
  const selected = manifest.scenarios.flatMap((scenario) => {
    const implementation = adapter.scenarios.find((item) => item.id === scenario.id);
    if (scenario.mode === 'write' && mode === 'readonly') { skipped.push({ id: scenario.id, reason: 'write_mode_not_authorized' }); return []; }
    if ((scenario.capabilities || []).includes('browser') && args.browser !== true) { skipped.push({ id: scenario.id, reason: 'browser_not_requested' }); return []; }
    return [{ manifest: scenario, implementation }];
  });
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
      const failed = { id: 'browser.lifecycle', round: 0, status: 'failed', ok: false, durationMs: 0, attempts: 1, category: classifyFailure(error), error: error instanceof Error ? error.message : String(error) };
      const result = { ok: false, command: 'run', status: 'browser_start_failed', runId, mode, rounds: 0, cancelled: false, scenarios: [failed], skipped, audit: [], cleanup: { ok: true, results: [], pending: [] }, preflight, startedAt, finishedAt: new Date().toISOString() };
      await writeReports({ artifactDir, result });
      return result;
    }
  }

  const scenarios = [];
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  processRef.once('SIGINT', onInterrupt);
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
    processRef.removeListener('SIGINT', onInterrupt);
    try { cleanupResult = await registry.cleanup((resource) => adapter.deleteResource(resource, { baseUrl, runId, manifest })); }
    catch (error) { cleanupResult = { ok: false, results: [], pending: registry.resources.filter((item) => item.state !== 'cleaned'), error: error instanceof Error ? error.message : String(error) }; }
    await browser?.close();
  }

  if (runtimeError) scenarios.push({ id: 'runner.lifecycle', round: schedule.completed, status: 'failed', ok: false, durationMs: 0, attempts: 1, category: classifyFailure(runtimeError), error: runtimeError instanceof Error ? runtimeError.message : String(runtimeError) });
  const cancelled = schedule.cancelled || controller.signal.aborted;
  const result = { ok: scenarios.every((item) => item.ok) && cleanupResult.ok && !cancelled, command: 'run', status: runtimeError ? 'runner_failed' : 'completed', runId, mode, rounds: schedule.completed, cancelled, scenarios, skipped, audit: browser?.audit || [], cleanup: cleanupResult, preflight, startedAt, finishedAt: new Date().toISOString() };
  await writeReports({ artifactDir, result });
  return result;
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
function assertWriteAllowed(manifest, args, env) { if (manifest.platform.production === true) throw new Error('write_rejected_production_target'); if (args.allowWrites !== true || env[manifest.platform.write_gate_env] !== 'true') throw new Error(`write_gate_required: use --allow-writes and ${manifest.platform.write_gate_env}=true`); }
function safeRunId(value) { if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(String(value))) throw new Error('run_id_invalid'); return String(value); }
