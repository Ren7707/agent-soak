import fs from 'node:fs/promises';
import path from 'node:path';

export async function compareRunFiles({ baselinePath, currentPath } = {}) {
  if (!baselinePath || !currentPath) throw new Error('compare_inputs_required');
  const [baseline, current] = await Promise.all([readRun(baselinePath), readRun(currentPath)]);
  const baselineMap = indexScenarios(baseline.scenarios);
  const currentMap = indexScenarios(current.scenarios);
  const keys = [...new Set([...baselineMap.keys(), ...currentMap.keys()])].sort();
  const changes = keys.flatMap((key) => {
    const before = baselineMap.get(key);
    const after = currentMap.get(key);
    if (!before) return [{ key, change: 'added', current: summarize(after) }];
    if (!after) return [{ key, change: 'removed', baseline: summarize(before) }];
    const beforeStatus = statusOf(before);
    const afterStatus = statusOf(after);
    if (beforeStatus === afterStatus && Boolean(before.ok) === Boolean(after.ok)) return [];
    return [{ key, change: 'changed', baseline: { status: beforeStatus, ok: before.ok, category: categoryOf(before) }, current: { status: afterStatus, ok: after.ok, category: categoryOf(after) } }];
  });
  return {
    ok: true,
    command: 'compare',
    baseline: { path: path.resolve(baselinePath), runId: baseline.runId, ruleset_version: baseline.ruleset_version || 'unspecified' },
    current: { path: path.resolve(currentPath), runId: current.runId, ruleset_version: current.ruleset_version || 'unspecified' },
    changed: changes.length,
    regressions: changes.filter((item) => item.change === 'changed' && item.baseline.ok === true && item.current.ok === false).length,
    improvements: changes.filter((item) => item.change === 'changed' && item.baseline.ok === false && item.current.ok === true).length,
    changes,
  };
}

async function readRun(file) {
  const value = JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
  if (!value || typeof value !== 'object' || !Array.isArray(value.scenarios) || value.command !== 'run') throw new Error('compare_run_invalid');
  return value;
}

function indexScenarios(scenarios) {
  return new Map(scenarios.map((item) => [`${item.id}:${item.caseId || item.round || ''}`, item]));
}
function statusOf(item) { return item.status || (item.ok ? 'passed' : 'failed'); }
function categoryOf(item) { return item.category || item.contract?.category || ''; }
function summarize(item) { return { status: statusOf(item), ok: item.ok, category: categoryOf(item) }; }
