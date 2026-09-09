import { classifyFailure } from '../core/failures.js';
import { runSchedule, parseDuration } from '../core/scheduler.js';
import { resolveBaseUrl } from '../manifest.js';
import { ResourceRegistry, createRunId } from '../resources/registry.js';
import { BrowserSession } from '../browser/session.js';
import { writePreflight, writeReports } from '../reporters/index.js';
import { evaluateContract, generateContractCases } from '../contracts/index.js';
import { RuntimeObserver } from '../evidence/index.js';
import { caseId, writeReplayPackage } from '../replay/index.js';

export async function runSoak({ manifest, adapter, args, artifactDir, processRef = process }) {
  const mode = modeFrom(args);
  if (mode === 'write') assertWriteAllowed(manifest, args, processRef.env);
  const target = scheduleTarget(args);
  const baseUrl = resolveBaseUrl(manifest, processRef.env);
  const runId = safeRunId(args.runId || createRunId());
  const prefix = `${manifest.platform.test_data_prefix}${runId}-`;
  const observer = new RuntimeObserver({ artifactDir, runId });
  observer.record('run', { phase: 'started', mode, target });
  const registry = new ResourceRegistry({ artifactDir, runId, prefix, observer });
  const preflight = await runPreflight(adapter, manifest, baseUrl, observer);
  await writePreflight({ artifactDir, runId, result: preflight });
  if (!preflight.ok) {
    const observations = await persistObservations(observer, artifactDir);
    const result = { ok: false, command: 'run', status: 'preflight_failed', runId, mode, rounds: 0, cancelled: false, scenarios: [], skipped: [], cleanup: { ok: true, results: [], pending: [] }, preflight, observations };
    await writeReports({ artifactDir, result });
    return result;
  }

  const skipped = [];
  const selected = manifest.scenarios.flatMap((scenario) => {
    const implementation = adapter.scenarios.find((item) => item.id === scenario.id);
    if (args.scenario && scenario.id !== args.scenario) { skipped.push({ id: scenario.id, reason: 'scenario_filter' }); return []; }
    if (args.suite && scenario.suite !== args.suite) { skipped.push({ id: scenario.id, reason: 'suite_filter' }); return []; }
    if (args.tag && !(scenario.tags || []).includes(args.tag)) { skipped.push({ id: scenario.id, reason: 'tag_filter' }); return []; }
    if (scenario.mode === 'write' && mode === 'readonly') { skipped.push({ id: scenario.id, reason: 'write_mode_not_authorized' }); return []; }
    if ((scenario.capabilities || []).includes('browser') && args.browser !== true) { skipped.push({ id: scenario.id, reason: 'browser_not_requested' }); return []; }
    return [{ manifest: scenario, implementation, observe: adapter.observe }];
  });
  const startedAt = new Date().toISOString();
  if (selected.length === 0) {
    observer.record('run', { phase: 'finished', status: 'no_scenarios_selected' });
    const observations = await persistObservations(observer, artifactDir);
    const result = { ok: false, command: 'run', status: 'no_scenarios_selected', runId, mode, rounds: 0, cancelled: false, scenarios: [], skipped, audit: [], cleanup: { ok: true, results: [], pending: [] }, preflight, observations, startedAt, finishedAt: new Date().toISOString() };
    await writeReports({ artifactDir, result });
    return result;
  }

  let browser;
  const browserNeeded = selected.some(({ manifest: scenario }) => (scenario.capabilities || []).includes('browser'));
  if (browserNeeded) {
    browser = new BrowserSession({ artifactDir, runId, supervised: args.supervise === true, observer });
    try { await browser.start(); }
    catch (error) {
      observer.record('browser', { phase: 'start', ok: false, error: error instanceof Error ? error.message : String(error) });
      const observations = await persistObservations(observer, artifactDir);
      const failed = { id: 'browser.lifecycle', round: 0, status: 'failed', ok: false, durationMs: 0, attempts: 1, category: classifyFailure(error), error: error instanceof Error ? error.message : String(error) };
      const result = { ok: false, command: 'run', status: 'browser_start_failed', runId, mode, rounds: 0, cancelled: false, scenarios: [failed], skipped, audit: [], cleanup: { ok: true, results: [], pending: [] }, preflight, observations, startedAt, finishedAt: new Date().toISOString() };
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
        scenarios.push(...await runScenario(entry, { baseUrl, runId, round, signal: controller.signal, supervised: args.supervise === true, browser, registry, manifest, observer, artifactDir, mode, caseId: args.caseId, replayCase: args.replayCase }));
      }
      await registry.persist();
    }});
  } catch (error) {
    runtimeError = error;
  } finally {
    processRef.removeListener('SIGINT', onInterrupt);
    try { cleanupResult = await registry.cleanup((resource) => adapter.deleteResource(resource, { baseUrl, runId, manifest, observer })); }
    catch (error) { cleanupResult = { ok: false, results: [], pending: registry.resources.filter((item) => item.state !== 'cleaned'), error: error instanceof Error ? error.message : String(error) }; }
    await browser?.close();
  }

  if (runtimeError) scenarios.push({ id: 'runner.lifecycle', round: schedule.completed, status: 'failed', ok: false, durationMs: 0, attempts: 1, category: classifyFailure(runtimeError), error: runtimeError instanceof Error ? runtimeError.message : String(runtimeError) });
  const cancelled = schedule.cancelled || controller.signal.aborted;
  observer.record('run', { phase: 'finished', status: runtimeError ? 'runner_failed' : 'completed', cancelled, cleanupOk: cleanupResult.ok });
  const observations = await persistObservations(observer, artifactDir);
  const result = { ok: scenarios.length > 0 && scenarios.every((item) => item.ok) && cleanupResult.ok && !cancelled, command: 'run', status: runtimeError ? 'runner_failed' : scenarios.length === 0 && args.caseId ? 'case_not_found' : 'completed', runId, mode, ruleset_version: manifest.ruleset_version || 'unspecified', environment: environmentSummary(manifest, mode), scenarios, skipped, audit: browser?.audit || [], cleanup: cleanupResult, preflight, observations, startedAt, finishedAt: new Date().toISOString() };
  await writeReports({ artifactDir, result });
  return result;
}

async function runScenario(entry, context) {
  const contract = entry.implementation.contract;
  const cases = context.replayCase?.scenario_id === entry.implementation.id
    ? [context.replayCase]
    : contract ? generateContractCases(contract) : [{ id: 'baseline', kind: 'valid', input: {}, expected: {} }];
  const results = [];
  for (const testCase of cases) {
    const stableId = testCase.case_id || caseId({ scenarioId: entry.implementation.id, testCase, rulesetVersion: context.manifest.ruleset_version || 'unspecified' });
    if (context.caseId && stableId !== context.caseId) continue;
    results.push(await runScenarioCase(entry, context, contract, testCase));
  }
  return results;
}

async function runScenarioCase(entry, context, contract, testCase) {
  const started = Date.now();
  const retries = entry.manifest.retries || 0;
  let lastError;
  let attempts = 0;
  const observationRefs = [];
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    attempts = attempt;
    const observer = context.observer.scope({ scenario: entry.implementation.id, case: testCase.id, round: context.round, attempt });
    observer.record('scenario', { phase: 'started', kind: testCase.kind, input: testCase.input });
    const previousBrowserObserver = context.browser?.setObserver(observer);
    try {
      const details = await runScenarioAttempt(entry, { ...context, testCase, observer });
      if (details?.ok === false) throw new Error(details.error || 'scenario_failed');
      const contractResult = contract ? evaluateContract(contract, testCase, details) : { ok: true, status: 'passed' };
      observer.recordAssertion({ name: `contract:${testCase.id}`, expected: testCase.expected || {}, actual: details, status: contractResult.status, mismatches: contractResult.mismatches });
      observer.record('scenario', { phase: 'finished', status: contractResult.status, ok: contractResult.ok });
      observationRefs.push(...observer.ids);
      const result = { id: entry.implementation.id, suite: entry.manifest.suite, tags: entry.manifest.tags, priority: entry.manifest.priority, caseId: testCase.id, case_id: testCase.case_id || caseId({ scenarioId: entry.implementation.id, testCase, rulesetVersion: context.manifest.ruleset_version || 'unspecified' }), kind: testCase.kind, round: context.round, status: contractResult.status, ok: contractResult.ok, attempts: attempt, durationMs: Date.now() - started, details, observation_refs: [...new Set(observationRefs)], ...(contract ? { contract: contractResult } : {}) };
      if (!result.ok) result.repro = await writeReplayPackage({ artifactDir: context.artifactDir, runId: context.runId, scenario: entry.manifest, testCase, rulesetVersion: context.manifest.ruleset_version || 'unspecified', mode: context.mode, status: result.status, category: result.contract?.category, observationRefs: result.observation_refs });
      return result;
    } catch (error) {
      lastError = error;
      observer.record('scenario', { phase: 'error', error: error instanceof Error ? error.message : String(error) });
      observationRefs.push(...observer.ids);
      if (context.signal.aborted || attempt > retries) break;
    } finally {
      context.browser?.setObserver(previousBrowserObserver);
    }
  }
  const result = { id: entry.implementation.id, suite: entry.manifest.suite, tags: entry.manifest.tags, priority: entry.manifest.priority, caseId: testCase.id, case_id: testCase.case_id || caseId({ scenarioId: entry.implementation.id, testCase, rulesetVersion: context.manifest.ruleset_version || 'unspecified' }), kind: testCase.kind, round: context.round, status: 'failed', ok: false, attempts, durationMs: Date.now() - started, category: classifyFailure(lastError), error: lastError instanceof Error ? lastError.message : String(lastError), observation_refs: [...new Set(observationRefs)] };
  result.repro = await writeReplayPackage({ artifactDir: context.artifactDir, runId: context.runId, scenario: entry.manifest, testCase, rulesetVersion: context.manifest.ruleset_version || 'unspecified', mode: context.mode, status: result.status, category: result.category, observationRefs: result.observation_refs });
  return result;
}

async function runScenarioAttempt(entry, context) {
  const timeoutMs = entry.manifest.timeout_ms;
  const run = async (runContext) => {
    const executor = runContext.testCase?.sequence?.length > 1 && typeof entry.implementation.runSequence === 'function'
      ? entry.implementation.runSequence
      : entry.implementation.run;
    const details = await executor({ ...runContext, scenario: entry.manifest });
    if (typeof entry.observe !== 'function') return details;
    const observed = await entry.observe({ ...runContext, phase: 'scenario', scenario: entry.manifest, result: details });
    if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return details;
    return { ...(details && typeof details === 'object' ? details : {}), ...observed, observed };
  };
  if (!timeoutMs) return run(context);
  const controller = new AbortController();
  const onAbort = () => controller.abort(context.signal.reason);
  context.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`scenario_timeout: ${entry.implementation.id} after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await Promise.race([
      run({ ...context, signal: controller.signal }),
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new Error('scenario_cancelled')), { once: true })),
    ]);
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', onAbort);
  }
}

async function runPreflight(adapter, manifest, baseUrl, observer) {
  try {
    const result = await adapter.preflight({ manifest, baseUrl, observer });
    const normalized = result && typeof result === 'object' ? { ok: result.ok !== false, ...result } : { ok: true };
    observer.record('preflight', normalized);
    return normalized;
  } catch (error) {
    const normalized = { ok: false, issues: [{ category: classifyFailure(error), error: error instanceof Error ? error.message : String(error) }] };
    observer.record('preflight', normalized);
    return normalized;
  }
}

async function persistObservations(observer, artifactDir) {
  const file = await observer.persist();
  return { ...observer.summary(), file: pathRelative(artifactDir, file) };
}

function pathRelative(root, file) { return file.startsWith(root) ? file.slice(root.length + 1).replaceAll('\\', '/') : file.replaceAll('\\', '/'); }

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
function environmentSummary(manifest, mode) { return { node: process.version, platform: process.platform, arch: process.arch, mode, platform_id: manifest.platform.id, base_url_configured: true }; }
