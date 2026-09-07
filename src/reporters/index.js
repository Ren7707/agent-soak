import { redact } from '../core/redact.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writePreflight({ artifactDir, runId, result }) {
  const dir = path.join(artifactDir, runId); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'preflight.json'), JSON.stringify(redact(result), null, 2));
}

export async function writeReports({ artifactDir, result }) {
  const dir = path.join(artifactDir, result.runId); await fs.mkdir(dir, { recursive: true });
  const safe = redact(result);
  await Promise.all([
    fs.writeFile(path.join(dir, 'run.json'), JSON.stringify(safe, null, 2)),
    fs.writeFile(path.join(dir, 'summary.md'), markdown(safe)),
    fs.writeFile(path.join(dir, 'junit.xml'), junit(safe)),
    fs.writeFile(path.join(dir, 'report.html'), html(safe)),
  ]);
  return dir;
}

function markdown(result) {
  const rows = (result.scenarios || []).map((item) => `| ${cell(item.id)} | ${cell(item.caseId || item.round)} | ${cell(statusOf(item))} | ${item.attempts ?? ''} | ${cell(categoryOf(item))} | ${item.durationMs ?? ''} | ${cell(item.error || item.contract?.mismatches?.map((mismatch) => `${mismatch.field}: expected ${JSON.stringify(mismatch.expected)}, actual ${JSON.stringify(mismatch.actual)}`).join('; ') || item.skipReason || '')} |`).join('\n');
  const skipped = (result.skipped || []).map((item) => `- ${item.id}: ${item.reason}`).join('\n') || '- none';
  const findings = (result.scenarios || []).filter((item) => item.ok === false).map((item) => `| ${cell(item.id)} | ${cell(item.caseId || '')} | ${cell(item.contract?.severity || item.severity || 'unknown')} | ${cell(categoryOf(item))} | ${cell((item.observation_refs || []).join(', '))} |`).join('\n') || '| none | | | | |';
  const observationTypes = Object.entries(result.observations?.types || {}).map(([type, count]) => `${type}=${count}`).join(', ') || 'none';
  return `# Soak Run ${result.runId}\n\n- Mode: ${result.mode}\n- Rounds: ${result.rounds}\n- Cancelled: ${result.cancelled}\n- Cleanup: ${result.cleanup?.ok ? 'passed' : 'failed'}\n- Observations: ${result.observations?.count ?? 0} (${observationTypes})\n\n## Skipped Scenarios\n\n${skipped}\n\n## Scenario Results\n\n| Scenario | Case/Round | Status | Attempts | Category | Duration (ms) | Detail |\n|---|---|---|---:|---|---:|---|\n${rows}\n\n## Findings\n\n| Scenario | Case | Severity | Category | Observation refs |\n|---|---|---|---|---|\n${findings}\n`;
}

function junit(result) {
  const cases = (result.scenarios || []).map((item) => {
    const status = item.status || (item.ok ? 'passed' : 'failed');
    const body = status === 'skipped' ? '<skipped/>' : item.ok === false ? `<failure type="${escapeXml(item.category || item.contract?.category || 'script')}" message="${escapeXml(item.error || item.contract?.status || 'failed')}"/>` : '';
    return `<testcase name="${escapeXml(`${item.id} round ${item.round}`)}" time="${Number(item.durationMs || 0) / 1000}">${body}</testcase>`;
  }).join('');
  const failures = (result.scenarios || []).filter((item) => item.ok === false).length;
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="agent-soak" tests="${result.scenarios?.length || 0}" failures="${failures}">${cases}</testsuite>`;
}

function html(result) {
  const rows = (result.scenarios || []).map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${escapeHtml(item.caseId || item.round)}</td><td>${escapeHtml(statusOf(item))}</td><td>${item.attempts ?? ''}</td><td>${escapeHtml(categoryOf(item))}</td><td>${item.durationMs ?? ''} ms</td><td>${escapeHtml((item.observation_refs || []).join(', '))}</td></tr>`).join('');
  const types = Object.entries(result.observations?.types || {}).map(([type, count]) => `<li>${escapeHtml(type)}: ${count}</li>`).join('') || '<li>none</li>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>agent-soak ${escapeHtml(result.runId)}</title><style>body{font:15px system-ui;margin:32px;color:#18202a}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #d9dee5;text-align:left}th{background:#f4f6f8}section{margin:24px 0}</style></head><body><h1>Soak Run ${escapeHtml(result.runId)}</h1><p>Mode: ${escapeHtml(result.mode)}; rounds: ${result.rounds}; cleanup: ${result.cleanup?.ok ? 'passed' : 'failed'}; observations: ${result.observations?.count ?? 0}</p><section><h2>Observation Types</h2><ul>${types}</ul></section><section><h2>Scenario Results</h2><table><tr><th>Scenario</th><th>Case/Round</th><th>Status</th><th>Attempts</th><th>Category</th><th>Duration</th><th>Observation refs</th></tr>${rows}</table></section></body></html>`;
}

function statusOf(item) { return item.status || (item.ok ? 'passed' : 'failed'); }
function categoryOf(item) { return item.category || item.contract?.category || ''; }
function cell(value) { return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' '); }
function escapeXml(value) { return String(value).replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char])); }
function escapeHtml(value) { return escapeXml(value); }
