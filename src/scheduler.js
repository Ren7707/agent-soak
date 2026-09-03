export async function runSchedule({ run, rounds, durationMs, signal, onRound }) {
  if (!Number.isInteger(rounds) && !Number.isFinite(durationMs)) throw new Error('schedule_requires_rounds_or_duration');
  if (Number.isInteger(rounds) && rounds < 1) throw new Error('schedule_invalid_rounds');
  if (Number.isFinite(durationMs) && durationMs < 1) throw new Error('schedule_invalid_duration');
  const started = Date.now();
  let completed = 0;
  while (!signal?.aborted && (rounds ? completed < rounds : Date.now() - started < durationMs)) {
    completed += 1;
    await onRound(completed);
    if (rounds && completed >= rounds) break;
    if (!rounds && Date.now() - started >= durationMs) break;
  }
  return { completed, cancelled: Boolean(signal?.aborted), durationMs: Date.now() - started };
}

export function parseDuration(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!match) throw new Error(`duration_invalid: ${value}`);
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}
