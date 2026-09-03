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
  const rows = (result.scenarios || []).map((item) => `| ${item.id} | ${item.round} | ${item.status || (item.ok ? 'passed' : 'failed')} | ${item.category || ''} | ${item.durationMs ?? ''} | ${item.error || item.skipReason || ''} |`).join('\n');
  const skipped = (result.skipped || []).map((item) => `- ${item.id}: ${item.reason}`).join('\n') || '- none';
  return `# Soak Run ${result.runId}\n\n- Mode: ${result.mode}\n- Rounds: ${result.rounds}\n- Cancelled: ${result.cancelled}\n- Cleanup: ${result.cleanup?.ok ? 'passed' : 'failed'}\n\n## Skipped Scenarios\n\n${skipped}\n\n## Scenario Results\n\n| Scenario | Round | Status | Category | Duration (ms) | Detail |\n|---|---:|---|---|---:|---|\n${rows}\n`;
}

function junit(result) {
  const cases = (result.scenarios || []).map((item) => {
    const status = item.status || (item.ok ? 'passed' : 'failed');
    const body = status === 'skipped' ? '<skipped/>' : status === 'failed' ? `<failure type="${escapeXml(item.category || 'script')}" message="${escapeXml(item.error || 'failed')}"/>` : '';
    return `<testcase name="${escapeXml(`${item.id} round ${item.round}`)}" time="${Number(item.durationMs || 0) / 1000}">${body}</testcase>`;
  }).join('');
  const failures = (result.scenarios || []).filter((item) => (item.status || (item.ok ? 'passed' : 'failed')) === 'failed').length;
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="agent-soak" tests="${result.scenarios?.length || 0}" failures="${failures}">${cases}</testsuite>`;
}

function html(result) {
  const rows = (result.scenarios || []).map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${item.round}</td><td>${escapeHtml(item.status || (item.ok ? 'passed' : 'failed'))}</td><td>${escapeHtml(item.category || '')}</td><td>${item.durationMs ?? ''} ms</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>agent-soak ${escapeHtml(result.runId)}</title><style>body{font:15px system-ui;margin:32px;color:#18202a}table{border-collapse:collapse;width:100%}th,td{padding:10px;border-bottom:1px solid #d9dee5;text-align:left}th{background:#f4f6f8}</style></head><body><h1>Soak Run ${escapeHtml(result.runId)}</h1><p>Mode: ${escapeHtml(result.mode)}; rounds: ${result.rounds}; cleanup: ${result.cleanup?.ok ? 'passed' : 'failed'}</p><table><tr><th>Scenario</th><th>Round</th><th>Status</th><th>Category</th><th>Duration</th></tr>${rows}</table></body></html>`;
}

function escapeXml(value) { return String(value).replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char])); }
function escapeHtml(value) { return escapeXml(value); }
