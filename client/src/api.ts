// ---------------------------------------------------------------- types (mirror server views)
export interface BatchView {
  id: string; name: string; date: string; startTime: string; endTime: string; startAt: string; endAt: string;
  durationMinutes: number; studentIds: string[]; phase: 'draft' | 'scheduled' | 'open' | 'closed' | 'cancelled';
  editable: boolean; lockReason: string | null; attemptsStarted: number; activeSessions: number; submitted: number;
  startedStudentIds: string[]; windowRemainingMs: number | null; startsInMs: number | null;
  nextSessionEndsAt: string | null; lastSessionEndsAt: string | null;
}
export interface TestView {
  id: string; title: string; generationMode: 'ai' | 'manual'; status: 'draft' | 'published' | 'cancelled'; locked: boolean;
  group: 'draft' | 'upcoming' | 'active' | 'completed' | 'cancelled'; version: number; cancelReason: string | null;
  timezone: string; date: string; startTime: string; endTime: string; endsNextDay: boolean; windowStart: string; windowEnd: string;
  durationMinutes: number; testLink: string; batches: BatchView[];
  editable: { timing: boolean; timingReason: string | null; canPublish: boolean; canLock: boolean; canUnlock: boolean; canCancel: boolean; canPostpone: boolean };
}
export interface DiffRow { scope: string; field: string; old: string; new: string }
export interface Plan { ok: boolean; version: number; changes: DiffRow[]; affectedStudents: number; errors: string[]; warnings: string[] }
export interface ScheduleChange {
  test?: { date?: string; startTime?: string; endTime?: string; durationMinutes?: number; timezone?: string };
  batches?: { id?: string; name?: string; startTime?: string; endTime?: string; durationMinutes?: number; studentIds?: string[]; remove?: boolean }[];
  shiftBatches?: boolean; reason?: string; action?: 'reschedule' | 'postpone';
}
export interface User { id: string; name: string; role: 'lecturer' | 'student' }
export interface Student { id: string; name: string; email: string }
export interface AuditRow { id: number; testId: string; testTitle: string; actorName: string; action: string; summary: string; reason: string | null; changes: DiffRow[]; createdAt: string }
export interface Attempt { id: string; testId: string; serverNow: string; startedAt: string; deadlineAt: string; allocatedMinutes: number; remainingMs: number; submittedAt: string | null; submitReason: string | null; answers: Record<string, unknown> }
export interface Question { id: string; type: 'mcq' | 'text'; text: string; options?: string[] }

// ---------------------------------------------------------------- demo auth
const KEY = 'tm.userId';
export function currentUserId(): string {
  try { return localStorage.getItem(KEY) ?? 'lec_ada'; } catch { return memUser; }
}
let memUser = 'lec_ada';
export function setCurrentUserId(id: string) {
  memUser = id;
  try { localStorage.setItem(KEY, id); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- fetch
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers: { 'content-type': 'application/json', 'x-user-id': currentUserId(), ...(rest.headers ?? {}) },
      body: json === undefined ? rest.body : JSON.stringify(json),
    });
  } catch {
    throw new ApiError(0, 'OFFLINE', 'You appear to be offline. Retrying…');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? res.statusText, body?.error?.details);
  return body as T;
}

// ---------------------------------------------------------------- server clock
/**
 * Server-anchored clock. We record (serverTime, performance.now()) at each sync and extrapolate
 * with the monotonic performance clock, so changing the device clock has no effect and the
 * estimate is corrected on every resync (interval, reconnect, tab focus).
 */
let anchorServer = Date.now();
let anchorPerf = performance.now();
export function syncFrom(serverNowIso: string, rttMs = 0) {
  anchorServer = new Date(serverNowIso).getTime() + rttMs / 2;
  anchorPerf = performance.now();
}
export function serverNow(): number {
  return anchorServer + (performance.now() - anchorPerf);
}
export async function resyncClock() {
  const t0 = performance.now();
  const r = await api<{ serverNow: string }>('/api/time');
  syncFrom(r.serverNow, performance.now() - t0);
}

// ---------------------------------------------------------------- formatting
export function fmtDuration(ms: number): string {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
export function fmtWhen(iso: string, tz: string, withDate = true): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
    ...(withDate ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' } : {}),
  }).format(new Date(iso));
}
export function fmtDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}
