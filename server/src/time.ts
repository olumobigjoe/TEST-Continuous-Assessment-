/** Time-zone helpers using only Intl (no dependencies). All instants are epoch ms (UTC). */

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parts(ms: number, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const m: Record<string, string> = {};
  for (const x of p) m[x.type] = x.value;
  return m;
}

function offsetMs(utcMs: number, tz: string): number {
  const m = parts(utcMs, tz);
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Wall-clock date + time in `tz` → epoch ms. */
export function zonedToUtc(date: string, time: string, tz: string): number {
  if (!DATE_RE.test(date)) throw new Error(`Invalid date "${date}" (expected YYYY-MM-DD)`);
  if (!TIME_RE.test(time)) throw new Error(`Invalid time "${time}" (expected HH:MM)`);
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = offsetMs(guess, tz);
  let utc = guess - off1;
  const off2 = offsetMs(utc, tz);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

export function utcToZoned(ms: number, tz: string): { date: string; time: string } {
  const m = parts(ms, tz);
  return { date: `${m.year}-${m.month}-${m.day}`, time: `${m.hour}:${m.minute}` };
}

/** First occurrence of wall-clock `time` at or after `notBefore`, anchored on `date`. */
export function timeOnOrAfter(date: string, time: string, tz: string, notBefore: number): number {
  let t = zonedToUtc(date, time, tz);
  while (t < notBefore) {
    const next = utcToZoned(t + DAY, tz).date;
    t = zonedToUtc(next, time, tz);
  }
  return t;
}

/** Human-readable, e.g. "Fri 20 Nov 2026, 14:00". */
export function fmt(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms));
}

export function fmtRange(start: number, end: number, tz: string): string {
  const s = utcToZoned(start, tz), e = utcToZoned(end, tz);
  return `${fmt(start, tz)} – ${s.date === e.date ? e.time : fmt(end, tz)} (${tz})`;
}
