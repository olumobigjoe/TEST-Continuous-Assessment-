/**
 * TEST scheduling rules engine. Every rule is enforced here, on the server.
 * The client only mirrors the editability flags this module computes.
 *
 * Key definitions
 *  - A batch has STARTED once any student has begun an attempt in it, or (for a
 *    published TEST) once its end time has passed. Started batches are frozen.
 *  - TEST-level timing (date, start, end, duration, time zone) is frozen as soon
 *    as ANY student has started the TEST.
 *  - Attempts snapshot their own start/deadline, so no edit can alter a running session.
 */
import { DB, newId, tx } from './db.js';
import { DAY, MINUTE, fmt, fmtRange, isValidTimeZone, timeOnOrAfter, utcToZoned, zonedToUtc } from './time.js';
import { Messages, T } from '../../shared/terms.js';

export const PAST_TOLERANCE_MS = MINUTE; // a new start may be at most 1 minute in the past

export class RuleError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface TestRow {
  id: string; title: string; lecturer_id: string; generation_mode: 'ai' | 'manual';
  status: 'draft' | 'published' | 'cancelled'; locked: number; timezone: string;
  window_start: number; window_end: number; duration_minutes: number; questions_json: string;
  version: number; cancel_reason: string | null; created_at: number; updated_at: number;
}
interface BatchRow { id: string; test_id: string; name: string; position: number; start_at: number; end_at: number; duration_minutes: number }

export interface SBatch { id: string; name: string; startAt: number; endAt: number; durationMinutes: number; studentIds: string[]; isNew?: boolean }
export interface SchedState { timezone: string; windowStart: number; windowEnd: number; durationMinutes: number; batches: SBatch[] }

export interface BatchStats { started: number; active: number; submitted: number; nextDeadline: number | null; lastDeadline: number | null }
export interface Stats { byBatch: Map<string, BatchStats>; attemptBatchByStudent: Map<string, string>; anyStarted: boolean }

// ---------------------------------------------------------------- loading

export function getTest(db: DB, id: string): TestRow {
  const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id) as TestRow | undefined;
  if (!t) throw new RuleError(404, 'NOT_FOUND', 'TEST not found.');
  return t;
}

export function loadState(db: DB, t: TestRow): SchedState {
  const rows = db.prepare('SELECT * FROM batches WHERE test_id = ? ORDER BY position, start_at').all(t.id) as unknown as BatchRow[];
  const members = db.prepare('SELECT batch_id, student_id FROM batch_students WHERE test_id = ? ORDER BY student_id').all(t.id) as { batch_id: string; student_id: string }[];
  return {
    timezone: t.timezone, windowStart: t.window_start, windowEnd: t.window_end, durationMinutes: t.duration_minutes,
    batches: rows.map((b) => ({
      id: b.id, name: b.name, startAt: b.start_at, endAt: b.end_at, durationMinutes: b.duration_minutes,
      studentIds: members.filter((m) => m.batch_id === b.id).map((m) => m.student_id),
    })),
  };
}

export function loadStats(db: DB, testId: string, now: number): Stats {
  const rows = db.prepare('SELECT batch_id, student_id, deadline_at, submitted_at FROM attempts WHERE test_id = ?').all(testId) as { batch_id: string; student_id: string; deadline_at: number; submitted_at: number | null }[];
  const byBatch = new Map<string, BatchStats>();
  const attemptBatchByStudent = new Map<string, string>();
  for (const r of rows) {
    const s = byBatch.get(r.batch_id) ?? { started: 0, active: 0, submitted: 0, nextDeadline: null, lastDeadline: null };
    s.started++;
    const isActive = r.submitted_at == null && r.deadline_at > now;
    if (isActive) {
      s.active++;
      s.nextDeadline = s.nextDeadline == null ? r.deadline_at : Math.min(s.nextDeadline, r.deadline_at);
      s.lastDeadline = Math.max(s.lastDeadline ?? 0, r.deadline_at);
    } else s.submitted++;
    byBatch.set(r.batch_id, s);
    attemptBatchByStudent.set(r.student_id, r.batch_id);
  }
  return { byBatch, attemptBatchByStudent, anyStarted: rows.length > 0 };
}

const emptyStats: BatchStats = { started: 0, active: 0, submitted: 0, nextDeadline: null, lastDeadline: null };

// ---------------------------------------------------------------- editability

export function testTimingLock(t: TestRow, stats: Stats, now: number): string | null {
  if (t.status === 'cancelled') return 'This TEST has been cancelled.';
  if (stats.anyStarted) return 'A student has already started this TEST, so TEST-level timing is locked. Batches that have not started can still be edited.';
  if (t.status === 'published' && now >= t.window_end) return 'This TEST has ended.';
  return null;
}

export function batchLock(t: TestRow, b: { id: string; endAt: number }, stats: Stats, now: number): string | null {
  if (t.status === 'cancelled') return 'This TEST has been cancelled.';
  const s = stats.byBatch.get(b.id) ?? emptyStats;
  if (s.started > 0) return `${s.started} student(s) have started in this batch, so its timing is locked.`;
  if (t.status === 'published' && now >= b.endAt) return 'This batch has already ended.';
  return null;
}

export type BatchPhase = 'draft' | 'scheduled' | 'open' | 'closed' | 'cancelled';
export function batchPhase(t: TestRow, b: { startAt: number; endAt: number }, now: number): BatchPhase {
  if (t.status === 'cancelled') return 'cancelled';
  if (t.status === 'draft') return 'draft';
  if (now < b.startAt) return 'scheduled';
  if (now < b.endAt) return 'open';
  return 'closed';
}

export type TestGroup = 'draft' | 'upcoming' | 'active' | 'completed' | 'cancelled';
export function testGroup(t: TestRow, state: SchedState, stats: Stats, now: number): TestGroup {
  if (t.status === 'cancelled') return 'cancelled';
  if (t.status === 'draft') return 'draft';
  const anyActiveAttempt = [...stats.byBatch.values()].some((s) => s.active > 0);
  if (now >= t.window_end && !anyActiveAttempt) return 'completed';
  if (anyActiveAttempt || state.batches.some((b) => now >= b.startAt && now < b.endAt)) return 'active';
  if (state.batches.length && state.batches.every((b) => now >= b.endAt)) return 'completed';
  return 'upcoming';
}

// ---------------------------------------------------------------- proposals

export interface TestTimingInput { date?: string; startTime?: string; endTime?: string; durationMinutes?: number; timezone?: string }
export interface BatchInput { id?: string; name?: string; startTime?: string; endTime?: string; durationMinutes?: number; studentIds?: string[]; remove?: boolean }
export interface ScheduleChangeInput {
  test?: TestTimingInput;
  batches?: BatchInput[];
  /** When the TEST start moves, move every batch by the same amount (default true). */
  shiftBatches?: boolean;
  reason?: string;
  action?: 'reschedule' | 'postpone';
}

function bad(msg: string): never { throw new RuleError(400, 'BAD_INPUT', msg); }

const isInt = (n: unknown) => typeof n === 'number' && Number.isInteger(n);

/** Apply an input to the current state, producing the proposed state. Throws only on malformed input. */
export function propose(cur: SchedState, input: ScheduleChangeInput): SchedState {
  const ti = input.test ?? {};
  const tz = ti.timezone ?? cur.timezone;
  if (!isValidTimeZone(tz)) bad(`Unknown time zone "${tz}".`);
  if (ti.durationMinutes !== undefined && !isInt(ti.durationMinutes)) bad(`${T.duration} must be a whole number of minutes.`);

  const s0 = utcToZoned(cur.windowStart, cur.timezone);
  const date = ti.date ?? s0.date;
  const startTime = ti.startTime ?? s0.time;
  let ws: number, we: number;
  try {
    ws = zonedToUtc(date, startTime, tz);
    we = ti.endTime ? timeOnOrAfter(date, ti.endTime, tz, ws + MINUTE) : ws + (cur.windowEnd - cur.windowStart);
  } catch (e) { bad((e as Error).message); }
  const duration = ti.durationMinutes ?? cur.durationMinutes;
  const delta = ws - cur.windowStart;
  const shift = input.shiftBatches !== false;

  let batches: SBatch[] = cur.batches.map((b) => ({
    ...b,
    studentIds: [...b.studentIds],
    startAt: shift ? b.startAt + delta : b.startAt,
    endAt: shift ? b.endAt + delta : b.endAt,
    // batches that inherited the TEST duration follow it
    durationMinutes: b.durationMinutes === cur.durationMinutes ? duration : b.durationMinutes,
  }));

  const explicitMembership = new Map<string, string>(); // student -> batch id from this input
  const removed = new Set<string>();
  for (const bi of input.batches ?? []) {
    if (bi.remove) {
      if (!bi.id || !batches.find((b) => b.id === bi.id)) bad('Cannot remove an unknown batch.');
      removed.add(bi.id);
      continue;
    }
    let b = bi.id ? batches.find((x) => x.id === bi.id) : undefined;
    if (bi.id && !b) bad(`Unknown batch "${bi.id}".`);
    if (!b) {
      b = { id: newId('bat'), name: bi.name ?? `${T.batch} ${batches.length + 1}`, startAt: ws, endAt: we, durationMinutes: duration, studentIds: [], isNew: true };
      batches.push(b);
    }
    if (bi.name !== undefined) {
      if (!bi.name.trim()) bad('Batch name cannot be empty.');
      b.name = bi.name.trim();
    }
    if (bi.durationMinutes !== undefined) {
      if (!isInt(bi.durationMinutes)) bad(`${T.batchDuration} must be a whole number.`);
      b.durationMinutes = bi.durationMinutes;
    }
    try {
      if (bi.startTime) {
        const len = b.endAt - b.startAt;
        b.startAt = timeOnOrAfter(date, bi.startTime, tz, ws);
        b.endAt = bi.endTime ? timeOnOrAfter(date, bi.endTime, tz, b.startAt + MINUTE) : b.startAt + len;
      } else if (bi.endTime) {
        b.endAt = timeOnOrAfter(date, bi.endTime, tz, b.startAt + MINUTE);
      }
    } catch (e) { bad((e as Error).message); }
    if (bi.studentIds) {
      if (!Array.isArray(bi.studentIds)) bad('studentIds must be a list.');
      for (const sid of bi.studentIds) {
        const prev = explicitMembership.get(sid);
        if (prev && prev !== b.id) bad(`Student ${sid} is listed in two batches.`);
        explicitMembership.set(sid, b.id);
      }
      b.studentIds = [...new Set(bi.studentIds)];
    }
  }
  // a student explicitly placed in one batch leaves every other batch
  for (const b of batches) b.studentIds = b.studentIds.filter((sid) => (explicitMembership.get(sid) ?? b.id) === b.id);
  batches = batches.filter((b) => !removed.has(b.id));
  batches.sort((a, b) => a.startAt - b.startAt || a.name.localeCompare(b.name));
  for (const b of batches) b.studentIds.sort();
  return { timezone: tz, windowStart: ws, windowEnd: we, durationMinutes: duration, batches };
}

export interface Problems { errors: string[]; warnings: string[] }

export function validate(
  db: DB, t: TestRow, before: SchedState, after: SchedState, stats: Stats, now: number,
  opts: { publishing?: boolean } = {},
): Problems {
  const errors: string[] = [];
  const warnings: string[] = [];
  const published = t.status === 'published' || !!opts.publishing;
  const tz = after.timezone;

  if (t.status === 'cancelled') return { errors: ['This TEST has been cancelled and cannot be rescheduled.'], warnings };

  const timingChanged = before.timezone !== after.timezone || before.windowStart !== after.windowStart ||
    before.windowEnd !== after.windowEnd || before.durationMinutes !== after.durationMinutes;
  if (timingChanged) {
    const lock = testTimingLock(t, stats, now);
    if (lock) errors.push(lock);
  }

  const winMin = (after.windowEnd - after.windowStart) / MINUTE;
  if (after.windowEnd <= after.windowStart) errors.push(`${T.endTime} must be after ${T.startTime}.`);
  if (after.windowEnd - after.windowStart > DAY) errors.push('A TEST window cannot be longer than 24 hours.');
  if (after.durationMinutes < 1) errors.push(`${T.duration} must be at least 1 minute.`);
  else if (after.durationMinutes > winMin) errors.push(`${T.duration} (${after.durationMinutes} min) is longer than the TEST window (${winMin} min).`);
  if (published) {
    if (after.windowStart !== before.windowStart && after.windowStart < now - PAST_TOLERANCE_MS) errors.push(`${T.startTime} cannot be in the past.`);
    if (after.windowEnd <= now) errors.push(`${T.endTime} must be in the future.`);
  }

  if (after.batches.length === 0) errors.push('A TEST needs at least one batch.');
  const names = new Set<string>();
  const beforeById = new Map(before.batches.map((b) => [b.id, b]));
  const afterById = new Map(after.batches.map((b) => [b.id, b]));

  for (const b of before.batches) {
    if (!afterById.has(b.id)) {
      const lock = batchLock(t, b, stats, now);
      if (lock) errors.push(`${b.name} cannot be removed: ${lock}`);
    }
  }

  for (const b of after.batches) {
    const label = b.name;
    if (names.has(label.toLowerCase())) errors.push(`Two batches are both called "${label}".`);
    names.add(label.toLowerCase());
    const len = (b.endAt - b.startAt) / MINUTE;
    if (b.endAt <= b.startAt) errors.push(`${label}: end time must be after start time.`);
    if (b.startAt < after.windowStart || b.endAt > after.windowEnd)
      errors.push(`${label} (${fmtRange(b.startAt, b.endAt, tz)}) falls outside the TEST window (${fmtRange(after.windowStart, after.windowEnd, tz)}).`);
    if (b.durationMinutes < 1) errors.push(`${label}: duration must be at least 1 minute.`);
    else if (b.durationMinutes > len) errors.push(`${label}: duration (${b.durationMinutes} min) is longer than its window (${len} min).`);

    const prev = beforeById.get(b.id);
    const timingDiff = !prev || prev.startAt !== b.startAt || prev.endAt !== b.endAt || prev.durationMinutes !== b.durationMinutes;
    if (prev && timingDiff) {
      const lock = batchLock(t, prev, stats, now);
      if (lock) errors.push(`${label}: ${lock}`);
    }
    if (published && timingDiff) {
      if ((!prev || prev.startAt !== b.startAt) && b.startAt < now - PAST_TOLERANCE_MS) errors.push(`${label}: start time cannot be in the past.`);
      if (b.endAt <= now) errors.push(`${label}: end time must be in the future.`);
    }
  }

  // Students
  const beforeBatchOf = new Map<string, string>();
  for (const b of before.batches) for (const s of b.studentIds) beforeBatchOf.set(s, b.id);
  const afterBatchOf = new Map<string, string>();
  for (const b of after.batches) for (const s of b.studentIds) afterBatchOf.set(s, b.id);

  const ids = [...new Set([...afterBatchOf.keys()])];
  if (ids.length) {
    const rows = db.prepare(`SELECT id, name, role FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; name: string; role: string }[];
    const ok = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) if (ok.get(id)?.role !== 'student') errors.push(`"${id}" is not a known student.`);
  }
  const nameOf = (id: string) => (db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;

  for (const [sid, attemptBatch] of stats.attemptBatchByStudent) {
    if (afterBatchOf.get(sid) !== attemptBatch) {
      const bn = before.batches.find((b) => b.id === attemptBatch)?.name ?? 'their batch';
      errors.push(`${nameOf(sid)} has already started the TEST in ${bn} and cannot be moved or removed.`);
    }
  }
  for (const [sid, bid] of afterBatchOf) {
    if (beforeBatchOf.get(sid) === bid) continue;
    const b = afterById.get(bid)!;
    if (published && b.endAt <= now) errors.push(`${nameOf(sid)} cannot be added to ${b.name} because it has ended.`);
  }

  const assigned = afterBatchOf.size;
  if (published && assigned === 0) errors.push('Assign at least one student before publishing.');
  const dropped = [...beforeBatchOf.keys()].filter((s) => !afterBatchOf.has(s));
  if (dropped.length) warnings.push(`${dropped.length} student(s) will no longer be assigned to any batch and will lose access: ${dropped.map(nameOf).join(', ')}.`);
  for (const b of after.batches) if (b.studentIds.length === 0) warnings.push(`${b.name} has no students.`);

  return { errors, warnings };
}

// ---------------------------------------------------------------- diff

export interface DiffRow { scope: string; field: string; old: string; new: string }

export function describeState(s: SchedState) {
  const z0 = utcToZoned(s.windowStart, s.timezone);
  const z1 = utcToZoned(s.windowEnd, s.timezone);
  return {
    timezone: s.timezone,
    date: z0.date, startTime: z0.time, endTime: z1.time, endsNextDay: z1.date !== z0.date,
    windowStart: new Date(s.windowStart).toISOString(), windowEnd: new Date(s.windowEnd).toISOString(),
    durationMinutes: s.durationMinutes,
    batches: s.batches.map((b) => {
      const a = utcToZoned(b.startAt, s.timezone), e = utcToZoned(b.endAt, s.timezone);
      return {
        id: b.id, name: b.name, date: a.date, startTime: a.time, endTime: e.time,
        startAt: new Date(b.startAt).toISOString(), endAt: new Date(b.endAt).toISOString(),
        durationMinutes: b.durationMinutes, studentIds: b.studentIds, isNew: !!b.isNew,
      };
    }),
  };
}

export function diffStates(db: DB, before: SchedState, after: SchedState): { rows: DiffRow[]; affectedStudents: string[] } {
  const rows: DiffRow[] = [];
  const add = (scope: string, field: string, o: string, n: string) => { if (o !== n) rows.push({ scope, field, old: o, new: n }); };
  const tz0 = before.timezone, tz1 = after.timezone;
  const b0 = utcToZoned(before.windowStart, tz0), b1 = utcToZoned(after.windowStart, tz1);
  const e0 = utcToZoned(before.windowEnd, tz0), e1 = utcToZoned(after.windowEnd, tz1);
  add('TEST', T.timezone, tz0, tz1);
  add('TEST', T.date, b0.date, b1.date);
  add('TEST', T.startTime, b0.time, b1.time);
  add('TEST', T.endTime, e0.time + (e0.date !== b0.date ? ' (+1 day)' : ''), e1.time + (e1.date !== b1.date ? ' (+1 day)' : ''));
  add('TEST', T.duration, `${before.durationMinutes} min`, `${after.durationMinutes} min`);

  const nameOf = (id: string) => (db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;
  const affected = new Set<string>();
  const beforeById = new Map(before.batches.map((b) => [b.id, b]));
  const afterIds = new Set(after.batches.map((b) => b.id));

  for (const b of after.batches) {
    const p = beforeById.get(b.id);
    const when = (x: SBatch, tz: string) => fmtRange(x.startAt, x.endAt, tz);
    if (!p) {
      rows.push({ scope: b.name, field: 'Batch', old: '—', new: `Added: ${when(b, tz1)}, ${b.durationMinutes} min, ${b.studentIds.length} student(s)` });
      b.studentIds.forEach((s) => affected.add(s));
      continue;
    }
    add(p.name, 'Batch name', p.name, b.name);
    const timingChanged = p.startAt !== b.startAt || p.endAt !== b.endAt;
    if (timingChanged) {
      add(b.name, T.batchStart, fmt(p.startAt, tz0), fmt(b.startAt, tz1));
      add(b.name, T.batchEnd, fmt(p.endAt, tz0), fmt(b.endAt, tz1));
    }
    add(b.name, T.batchDuration, `${p.durationMinutes} min`, `${b.durationMinutes} min`);
    if (timingChanged || p.durationMinutes !== b.durationMinutes) b.studentIds.forEach((s) => affected.add(s));
    const inn = b.studentIds.filter((s) => !p.studentIds.includes(s));
    const out = p.studentIds.filter((s) => !b.studentIds.includes(s));
    if (inn.length || out.length) {
      rows.push({
        scope: b.name, field: T.batchStudents,
        old: `${p.studentIds.length} student(s)`,
        new: `${b.studentIds.length} student(s)` + (inn.length ? ` · added ${inn.map(nameOf).join(', ')}` : '') + (out.length ? ` · removed ${out.map(nameOf).join(', ')}` : ''),
      });
      inn.forEach((s) => affected.add(s));
      out.forEach((s) => affected.add(s));
    }
  }
  for (const p of before.batches) if (!afterIds.has(p.id)) {
    rows.push({ scope: p.name, field: 'Batch', old: `${fmtRange(p.startAt, p.endAt, tz0)}, ${p.studentIds.length} student(s)`, new: 'Removed' });
    p.studentIds.forEach((s) => affected.add(s));
  }
  return { rows, affectedStudents: [...affected] };
}

// ---------------------------------------------------------------- plan / apply

export interface Plan {
  ok: boolean; version: number;
  before: ReturnType<typeof describeState>; after: ReturnType<typeof describeState>;
  changes: DiffRow[]; affectedStudents: number; errors: string[]; warnings: string[];
}

function computePlan(db: DB, t: TestRow, input: ScheduleChangeInput, now: number) {
  const before = loadState(db, t);
  const after = propose(before, input);
  const stats = loadStats(db, t.id, now);
  const problems = validate(db, t, before, after, stats, now);
  const { rows, affectedStudents } = diffStates(db, before, after);
  if (input.action === 'postpone' && !(after.windowStart > before.windowStart)) problems.errors.push('A postponed TEST must move to a later time.');
  if (input.reason && input.reason.length > 500) problems.errors.push('Reason must be 500 characters or fewer.');
  const plan: Plan = {
    ok: problems.errors.length === 0 && rows.length > 0, version: t.version,
    before: describeState(before), after: describeState(after),
    changes: rows, affectedStudents: affectedStudents.length, ...problems,
  };
  if (rows.length === 0) plan.errors.push('Nothing has changed.');
  return { plan, before, after, affectedStudents };
}

export function previewSchedule(db: DB, testId: string, input: ScheduleChangeInput, now: number): Plan {
  return computePlan(db, getTest(db, testId), input, now).plan;
}

export interface Actor { id: string; name: string }

export function audit(db: DB, testId: string, actor: Actor, action: string, summary: string, now: number, extra: { reason?: string; changes?: DiffRow[]; before?: unknown; after?: unknown } = {}) {
  db.prepare(`INSERT INTO schedule_audit (test_id, actor_id, actor_name, action, summary, reason, changes_json, before_json, after_json, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    testId, actor.id, actor.name, action, summary, extra.reason ?? null, JSON.stringify(extra.changes ?? []),
    extra.before === undefined ? null : JSON.stringify(extra.before), extra.after === undefined ? null : JSON.stringify(extra.after), now);
}

export function notify(db: DB, userIds: string[], testId: string, subject: (n: string) => string, body: (n: string) => string, now: number) {
  const ins = db.prepare('INSERT INTO notifications (user_id, test_id, channel, subject, body, created_at) VALUES (?,?,?,?,?,?)');
  for (const uid of userIds) {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(uid) as { name: string } | undefined;
    if (!u) continue;
    for (const ch of ['in_app', 'email'] as const) ins.run(uid, testId, ch, subject(u.name), body(u.name), now);
  }
}

function writeState(db: DB, t: TestRow, before: SchedState, after: SchedState, now: number) {
  const keep = new Set(after.batches.map((b) => b.id));
  for (const b of before.batches) if (!keep.has(b.id)) db.prepare('DELETE FROM batches WHERE id = ?').run(b.id);
  db.prepare('DELETE FROM batch_students WHERE test_id = ?').run(t.id);
  after.batches.forEach((b, i) => {
    db.prepare(`INSERT INTO batches (id, test_id, name, position, start_at, end_at, duration_minutes) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET name=excluded.name, position=excluded.position, start_at=excluded.start_at,
                end_at=excluded.end_at, duration_minutes=excluded.duration_minutes`).run(b.id, t.id, b.name, i, b.startAt, b.endAt, b.durationMinutes);
    for (const s of b.studentIds) db.prepare('INSERT INTO batch_students (test_id, batch_id, student_id) VALUES (?,?,?)').run(t.id, b.id, s);
  });
  db.prepare(`UPDATE tests SET timezone=?, window_start=?, window_end=?, duration_minutes=?, version=version+1, updated_at=? WHERE id=?`)
    .run(after.timezone, after.windowStart, after.windowEnd, after.durationMinutes, now, t.id);
}

export function applySchedule(db: DB, testId: string, input: ScheduleChangeInput & { expectedVersion: number; confirm: boolean }, actor: Actor, now: number): Plan {
  if (input.confirm !== true) throw new RuleError(400, 'CONFIRM_REQUIRED', 'Review the old and new schedule and confirm before applying.');
  return tx(db, () => {
    const t = getTest(db, testId);
    if (t.version !== input.expectedVersion)
      throw new RuleError(409, 'VERSION_CONFLICT', 'This TEST schedule was changed by someone else since you reviewed it. Reload and review again.');
    const { plan, before, after, affectedStudents } = computePlan(db, t, input, now);
    if (!plan.ok) throw new RuleError(422, 'RULES_FAILED', plan.errors[0] ?? 'Schedule change not allowed.', plan);
    writeState(db, t, before, after, now);
    const action = input.action === 'postpone' ? 'postponed' : 'schedule_updated';
    audit(db, t.id, actor, action, `${plan.changes.length} change(s): ` + plan.changes.slice(0, 3).map((c) => `${c.scope} ${c.field}`).join('; ') + (plan.changes.length > 3 ? '…' : ''), now,
      { reason: input.reason, changes: plan.changes, before: plan.before, after: plan.after });
    if (t.status === 'published' && affectedStudents.length) {
      const where = (s: SchedState, sid: string) => {
        const b = s.batches.find((x) => x.studentIds.includes(sid));
        return b ? `${b.name}, ${fmtRange(b.startAt, b.endAt, s.timezone)}` : 'not assigned';
      };
      for (const sid of affectedStudents)
        notify(db, [sid], t.id, () => Messages.scheduleChangedSubject(t.title), (n) => Messages.scheduleChangedBody(n, t.title, where(before, sid), where(after, sid), input.reason), now);
    }
    return { ...plan, version: t.version + 1 };
  });
}

// ---------------------------------------------------------------- creation & lifecycle

export interface CreateInput {
  title: string; generationMode?: 'ai' | 'manual'; timezone: string; date: string; startTime: string; endTime: string;
  durationMinutes: number; numberOfBatches?: number; gapMinutes?: number; studentIds?: string[]; questions?: unknown[];
}

/** Creates a draft TEST. With N batches, the window is split into N equal consecutive slots and students are spread evenly. */
export function createTest(db: DB, input: CreateInput, actor: Actor, now: number) {
  if (!input.title?.trim()) bad(`${T.title} is required.`);
  if (!isValidTimeZone(input.timezone)) bad(`Unknown time zone "${input.timezone}".`);
  if (!isInt(input.durationMinutes)) bad(`${T.duration} must be a whole number of minutes.`);
  const n = input.numberOfBatches ?? 1;
  if (!isInt(n) || n < 1 || n > 50) bad(`${T.numberOfBatches} must be between 1 and 50.`);
  const gap = input.gapMinutes ?? 0;
  let ws: number, we: number;
  try {
    ws = zonedToUtc(input.date, input.startTime, input.timezone);
    we = timeOnOrAfter(input.date, input.endTime, input.timezone, ws + MINUTE);
  } catch (e) { bad((e as Error).message); }
  const slot = Math.floor(((we - ws) / MINUTE - gap * (n - 1)) / n);
  if (slot < 1) bad('The TEST window is too short for that many batches.');
  const dur = Math.min(input.durationMinutes, slot);
  const students = [...new Set(input.studentIds ?? [])];
  const batches: SBatch[] = Array.from({ length: n }, (_, i) => {
    const s = ws + i * (slot + gap) * MINUTE;
    return { id: newId('bat'), name: `${T.batch} ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`, startAt: s, endAt: s + slot * MINUTE, durationMinutes: n === 1 ? input.durationMinutes : dur, studentIds: [] };
  });
  students.forEach((s, i) => batches[Math.floor((i * n) / Math.max(students.length, 1))].studentIds.push(s));

  return tx(db, () => {
    const id = newId('tst');
    db.prepare(`INSERT INTO tests (id, title, lecturer_id, generation_mode, status, timezone, window_start, window_end, duration_minutes, questions_json, created_at, updated_at)
                VALUES (?,?,?,?, 'draft', ?,?,?,?,?,?,?)`).run(id, input.title.trim(), actor.id, input.generationMode ?? 'manual', input.timezone, ws, we, input.durationMinutes, JSON.stringify(input.questions ?? []), now, now);
    const t = getTest(db, id);
    const state: SchedState = { timezone: input.timezone, windowStart: ws, windowEnd: we, durationMinutes: input.durationMinutes, batches };
    const problems = validate(db, t, { ...state, batches: [] }, state, loadStats(db, id, now), now);
    const errs = problems.errors.filter((e) => !e.includes('cannot be in the past') && !e.includes('must be in the future'));
    if (errs.length) throw new RuleError(422, 'RULES_FAILED', errs[0], { errors: errs, warnings: problems.warnings });
    writeState(db, t, { ...state, batches: [] }, state, now);
    db.prepare('UPDATE tests SET version = 1 WHERE id = ?').run(id);
    audit(db, id, actor, 'created', `Created draft TEST "${t.title}" with ${n} batch(es)`, now, { after: describeState(state) });
    return getTest(db, id);
  });
}

export function publishTest(db: DB, testId: string, actor: Actor, now: number) {
  return tx(db, () => {
    const t = getTest(db, testId);
    if (t.status !== 'draft') throw new RuleError(409, 'NOT_DRAFT', 'Only a draft TEST can be published.');
    const s = loadState(db, t);
    const stats = loadStats(db, t.id, now);
    // A window that has already opened (but not ended) may be published: it opens immediately.
    const errors = validate(db, t, { ...s, windowStart: -1, batches: [] }, s, stats, now, { publishing: true }).errors
      .filter((e) => !e.includes('cannot be in the past'));
    if (errors.length) throw new RuleError(422, 'RULES_FAILED', errors[0], { errors });
    db.prepare("UPDATE tests SET status='published', version=version+1, updated_at=? WHERE id=?").run(now, t.id);
    audit(db, t.id, actor, 'published', `Published TEST "${t.title}"`, now, { after: describeState(s) });
    for (const b of s.batches)
      notify(db, b.studentIds, t.id, () => Messages.publishedSubject(t.title), (n) => Messages.publishedBody(n, t.title, `${b.name}, ${fmtRange(b.startAt, b.endAt, s.timezone)}`), now);
  });
}

export function setLocked(db: DB, testId: string, locked: boolean, actor: Actor, now: number, reason?: string) {
  return tx(db, () => {
    const t = getTest(db, testId);
    if (t.status !== 'published') throw new RuleError(409, 'NOT_ELIGIBLE', 'Only a published TEST can be locked or unlocked.');
    if (now >= t.window_end) throw new RuleError(409, 'NOT_ELIGIBLE', 'This TEST has ended.');
    if (!!t.locked === locked) throw new RuleError(409, 'NO_CHANGE', locked ? 'This TEST is already locked.' : 'This TEST is not locked.');
    db.prepare('UPDATE tests SET locked=?, version=version+1, updated_at=? WHERE id=?').run(locked ? 1 : 0, now, t.id);
    audit(db, t.id, actor, locked ? 'locked' : 'unlocked',
      locked ? 'Locked TEST: students cannot start until it is unlocked (active sessions continue).' : 'Unlocked TEST: students can start during their batch window.', now, { reason });
  });
}

export function cancelTest(db: DB, testId: string, actor: Actor, now: number, reason?: string) {
  return tx(db, () => {
    const t = getTest(db, testId);
    if (t.status === 'cancelled') throw new RuleError(409, 'NO_CHANGE', 'This TEST is already cancelled.');
    const stats = loadStats(db, t.id, now);
    if (stats.anyStarted) throw new RuleError(409, 'NOT_ELIGIBLE', 'A student has already started this TEST, so it cannot be cancelled.');
    if (t.status === 'published' && now >= t.window_end) throw new RuleError(409, 'NOT_ELIGIBLE', 'This TEST has ended.');
    const s = loadState(db, t);
    db.prepare("UPDATE tests SET status='cancelled', cancel_reason=?, version=version+1, updated_at=? WHERE id=?").run(reason ?? null, now, t.id);
    audit(db, t.id, actor, 'cancelled', `Cancelled TEST "${t.title}"`, now, { reason, before: describeState(s) });
    if (t.status === 'published')
      notify(db, s.batches.flatMap((b) => b.studentIds), t.id, () => Messages.cancelledSubject(t.title), (n) => Messages.cancelledBody(n, t.title, reason), now);
  });
}

// ---------------------------------------------------------------- views

export function testView(db: DB, t: TestRow, now: number) {
  const state = loadState(db, t);
  const stats = loadStats(db, t.id, now);
  const timingLock = testTimingLock(t, stats, now);
  const d = describeState(state);
  const startedStudentIds = [...stats.attemptBatchByStudent.keys()];
  return {
    id: t.id, title: t.title, generationMode: t.generation_mode, status: t.status, locked: !!t.locked,
    group: testGroup(t, state, stats, now), version: t.version, cancelReason: t.cancel_reason,
    ...d,
    testLink: `/student/tests/${t.id}`,
    editable: {
      timing: !timingLock, timingReason: timingLock,
      canPublish: t.status === 'draft',
      canLock: t.status === 'published' && !t.locked && now < t.window_end,
      canUnlock: t.status === 'published' && !!t.locked && now < t.window_end,
      canCancel: t.status !== 'cancelled' && !stats.anyStarted && !(t.status === 'published' && now >= t.window_end),
      canPostpone: !timingLock,
    },
    batches: d.batches.map((bd, i) => {
      const b = state.batches[i];
      const s = stats.byBatch.get(b.id) ?? emptyStats;
      const lock = batchLock(t, b, stats, now);
      const phase = batchPhase(t, b, now);
      return {
        ...bd, phase, editable: !lock, lockReason: lock,
        attemptsStarted: s.started, activeSessions: s.active, submitted: s.submitted,
        startedStudentIds: startedStudentIds.filter((sid) => stats.attemptBatchByStudent.get(sid) === b.id),
        windowRemainingMs: phase === 'open' ? b.endAt - now : null,
        startsInMs: phase === 'scheduled' ? b.startAt - now : null,
        nextSessionEndsAt: s.nextDeadline ? new Date(s.nextDeadline).toISOString() : null,
        lastSessionEndsAt: s.lastDeadline ? new Date(s.lastDeadline).toISOString() : null,
      };
    }),
  };
}
