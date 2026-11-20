/**
 * Student TEST sessions. The server owns the clock:
 *  - deadline = min(start + batch duration, batch end), fixed at start and never changed afterwards
 *  - answers are rejected after the deadline (+ a small network grace)
 *  - expired sessions are auto-submitted by a sweeper and lazily on every read
 */
import { DB, newId, tx } from './db.js';
import { MINUTE } from './time.js';
import { RuleError, getTest, loadState, batchPhase } from './schedule.js';

export const SUBMIT_GRACE_MS = 5_000; // tolerates network latency on the final autosave/submit

interface AttemptRow {
  id: string; test_id: string; batch_id: string; student_id: string; started_at: number; deadline_at: number;
  allocated_minutes: number; submitted_at: number | null; submit_reason: string | null; answers_json: string;
}

function finalizeIfExpired(db: DB, a: AttemptRow, now: number): AttemptRow {
  if (a.submitted_at == null && now >= a.deadline_at) {
    db.prepare("UPDATE attempts SET submitted_at = deadline_at, submit_reason = 'auto_expired' WHERE id = ? AND submitted_at IS NULL").run(a.id);
    return { ...a, submitted_at: a.deadline_at, submit_reason: 'auto_expired' };
  }
  return a;
}

/** Auto-submits every expired session. Run on an interval. */
export function sweepExpired(db: DB, now: number): number {
  const r = db.prepare("UPDATE attempts SET submitted_at = deadline_at, submit_reason = 'auto_expired' WHERE submitted_at IS NULL AND deadline_at <= ?").run(now);
  return Number(r.changes);
}

export function attemptView(a: AttemptRow, now: number) {
  return {
    id: a.id, testId: a.test_id, batchId: a.batch_id,
    serverNow: new Date(now).toISOString(),
    startedAt: new Date(a.started_at).toISOString(),
    deadlineAt: new Date(a.deadline_at).toISOString(),
    allocatedMinutes: a.allocated_minutes,
    remainingMs: a.submitted_at == null ? Math.max(0, a.deadline_at - now) : 0,
    submittedAt: a.submitted_at ? new Date(a.submitted_at).toISOString() : null,
    submitReason: a.submit_reason,
    answers: JSON.parse(a.answers_json),
  };
}

function own(db: DB, attemptId: string, studentId: string): AttemptRow {
  const a = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as AttemptRow | undefined;
  if (!a || a.student_id !== studentId) throw new RuleError(404, 'NOT_FOUND', 'TEST session not found.');
  return a;
}

export function startAttempt(db: DB, testId: string, studentId: string, now: number) {
  return tx(db, () => {
    const existing = db.prepare('SELECT * FROM attempts WHERE test_id = ? AND student_id = ?').get(testId, studentId) as AttemptRow | undefined;
    if (existing) return attemptView(finalizeIfExpired(db, existing, now), now); // resume — never restarts the clock

    const t = getTest(db, testId);
    if (t.status === 'cancelled') throw new RuleError(403, 'CANCELLED', 'This TEST has been cancelled.');
    if (t.status !== 'published') throw new RuleError(404, 'NOT_FOUND', 'TEST not found.');
    if (t.locked) throw new RuleError(403, 'LOCKED', 'This TEST is locked by your lecturer. Please wait.');
    const s = loadState(db, t);
    const b = s.batches.find((x) => x.studentIds.includes(studentId));
    if (!b) throw new RuleError(403, 'NOT_ASSIGNED', 'You are not assigned to a batch for this TEST.');
    const phase = batchPhase(t, b, now);
    if (phase === 'scheduled') throw new RuleError(403, 'NOT_OPEN', `Your batch (${b.name}) has not opened yet.`, { opensAt: new Date(b.startAt).toISOString() });
    if (phase === 'closed') throw new RuleError(403, 'CLOSED', `Your batch (${b.name}) has closed.`);

    const deadline = Math.min(now + b.durationMinutes * MINUTE, b.endAt);
    const id = newId('att');
    db.prepare(`INSERT INTO attempts (id, test_id, batch_id, student_id, started_at, deadline_at, allocated_minutes) VALUES (?,?,?,?,?,?,?)`)
      .run(id, t.id, b.id, studentId, now, deadline, b.durationMinutes);
    return attemptView(db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as unknown as AttemptRow, now);
  });
}

export function getAttempt(db: DB, attemptId: string, studentId: string, now: number) {
  return attemptView(finalizeIfExpired(db, own(db, attemptId, studentId), now), now);
}

export function saveAnswers(db: DB, attemptId: string, studentId: string, answers: Record<string, unknown>, now: number) {
  return tx(db, () => {
    const a = own(db, attemptId, studentId);
    if (a.submitted_at != null) throw new RuleError(409, 'ALREADY_SUBMITTED', 'This TEST has already been submitted.', attemptView(a, now));
    if (now > a.deadline_at + SUBMIT_GRACE_MS) {
      const f = finalizeIfExpired(db, a, now);
      throw new RuleError(409, 'TIME_UP', 'Time is up. Your TEST was submitted automatically.', attemptView(f, now));
    }
    const merged = { ...JSON.parse(a.answers_json), ...answers };
    db.prepare('UPDATE attempts SET answers_json = ? WHERE id = ?').run(JSON.stringify(merged), a.id);
    return attemptView({ ...a, answers_json: JSON.stringify(merged) }, now);
  });
}

export function submitAttempt(db: DB, attemptId: string, studentId: string, answers: Record<string, unknown> | undefined, now: number) {
  return tx(db, () => {
    const a = own(db, attemptId, studentId);
    if (a.submitted_at != null) return attemptView(a, now); // idempotent
    if (now > a.deadline_at + SUBMIT_GRACE_MS) return attemptView(finalizeIfExpired(db, a, now), now); // late answers discarded
    const merged = JSON.stringify({ ...JSON.parse(a.answers_json), ...(answers ?? {}) });
    const at = Math.min(now, a.deadline_at);
    const reason = now >= a.deadline_at ? 'auto_expired' : 'student';
    db.prepare('UPDATE attempts SET answers_json = ?, submitted_at = ?, submit_reason = ? WHERE id = ?').run(merged, at, reason, a.id);
    return attemptView({ ...a, answers_json: merged, submitted_at: at, submit_reason: reason }, now);
  });
}
