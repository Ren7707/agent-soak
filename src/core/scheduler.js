export async function runSchedule({ rounds, durationMs, intervalMs = 0, signal, onRound }) {
  if ((rounds === undefined) === (durationMs === undefined)) throw new Error('schedule_requires_exactly_one_target');
  if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1)) throw new Error('schedule_invalid_rounds');
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs < 1)) throw new Error('schedule_invalid_duration');
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('schedule_invalid_interval');
  const started = Date.now();
  let completed = 0;
  while (!signal?.aborted && (rounds !== undefined ? completed < rounds : Date.now() - started < durationMs)) {
    completed += 1;
    await onRound(completed);
    if (signal?.aborted || (rounds !== undefined && completed >= rounds)) break;
    if (intervalMs > 0) await wait(intervalMs, signal);
  }
  return { completed, cancelled: Boolean(signal?.aborted), durationMs: Date.now() - started };
}

export function parseDuration(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) throw new Error(`duration_invalid: ${value}`);
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
