import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeReports({ artifactDir, runId, result }) {
  const dir = path.join(artifactDir, runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(dir, 'summary.md'), markdown(result));
  await fs.writeFile(path.join(dir, 'junit.xml'), junit(result));
  await fs.writeFile(path.join(dir, 'report.html'), html(result));
  return dir;
}

function markdown(result) {
  const rows = result.scenarios.map((item) => `| ${item.id} | ${item.ok ? 'passed' : 'failed'} | ${item.durationMs} | ${item.error || ''} |`).join('\n');
  return `# Soak Run ${result.runId}\n\n- Mode: ${result.mode}\n- Rounds: ${result.rounds}\n- Cancelled: ${result.cancelled}\n- Cleanup: ${result.cleanup?.ok ? 'passed' : 'failed'}\n\n| Scenario | Status | Duration (ms) | Error |\n|---|---|---:|---|\n${rows}\n`;
}

function junit(result) {
  const failures = result.scenarios.filter((item) => !item.ok).map((item) => `<testcase name="${escapeXml(item.id)}" time="${item.durationMs / 1000}"><failure message="${escapeXml(item.error || 'failed')}"/></testcase>`).join('');
  const passed = result.scenarios.filter((item) => item.ok).map((item) => `<testcase name="${escapeXml(item.id)}" time="${item.durationMs / 1000}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="agent-soak" tests="${result.scenarios.length}" failures="${result.scenarios.length - result.scenarios.filter((item) => item.ok).length}">${passed}${failures}</testsuite>`;
}

function html(result) {
  return `<!doctype html><meta charset="utf-8"><title>agent-soak ${result.runId}</title><h1>Soak Run ${result.runId}</h1><p>Mode: ${result.mode}; rounds: ${result.rounds}; cleanup: ${result.cleanup?.ok ? 'passed' : 'failed'}</p><table><tr><th>Scenario</th><th>Status</th><th>Duration</th></tr>${result.scenarios.map((item) => `<tr><td>${escapeXml(item.id)}</td><td>${item.ok ? 'passed' : 'failed'}</td><td>${item.durationMs} ms</td></tr>`).join('')}</table>`;
}
function escapeXml(value) { return String(value).replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[char])); }
