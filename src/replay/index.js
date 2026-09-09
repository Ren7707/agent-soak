import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../core/redact.js';

export function caseId({ scenarioId, testCase, rulesetVersion = 'unspecified' } = {}) {
  const payload = canonicalize({ scenarioId, caseId: testCase?.id, kind: testCase?.kind, input: testCase?.input || {}, expected: testCase?.expected || {}, sequence: testCase?.sequence || [], rulesetVersion });
  return `case-${createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex').slice(0, 20)}`;
}

export async function writeReplayPackage({ artifactDir, runId, scenario, testCase, rulesetVersion, mode, status, category, observationRefs = [] } = {}) {
  const id = testCase.case_id || caseId({ scenarioId: scenario.id, testCase, rulesetVersion });
  const directory = path.join(artifactDir, runId, 'repro');
  await fs.mkdir(directory, { recursive: true });
  const packageValue = redact({ version: 1, runId, case_id: id, scenario_id: scenario.id, case_id_source: testCase.id || testCase.case_id_source || 'replay', kind: testCase.kind, input: testCase.input || {}, expected: testCase.expected || {}, sequence: testCase.sequence || [], ruleset_version: rulesetVersion, mode, status, category, observation_refs: observationRefs });
  const file = path.join(directory, `${id}.json`);
  await fs.writeFile(file, `${JSON.stringify(packageValue, null, 2)}\n`, 'utf8');
  return { case_id: id, file: file.replace(`${artifactDir}${path.sep}`, '').replaceAll('\\', '/') };
}

export async function loadReplayPackage({ artifactDir, runId, caseId: id } = {}) {
  if (!runId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(String(runId)) || !id || !/^case-[a-f0-9]{20}$/.test(id)) throw new Error('replay_case_id_invalid');
  const file = path.join(path.resolve(artifactDir), runId, 'repro', `${id}.json`);
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (value.version !== 1 || value.case_id !== id || typeof value.scenario_id !== 'string') throw new Error('replay_package_invalid');
  return { ...value, file };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}
