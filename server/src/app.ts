import express, { NextFunction, Request, Response } from 'express';
import { DB } from './db.js';
import {
  Actor, RuleError, applySchedule, cancelTest, createTest, getTest, loadState, previewSchedule,
  publishTest, setLocked, testView, batchPhase, TestRow,
} from './schedule.js';
import { getAttempt, saveAnswers, startAttempt, submitAttempt } from './attempts.js';

export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };

interface User { id: string; name: string; email: string; role: 'lecturer' | 'student' }
declare module 'express-serve-static-core' { interface Request { user?: User } }

type H = (req: Request, res: Response) => unknown;
const wrap = (fn: H) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) { next(e); }
};

export function createApp(db: DB, clock: Clock = systemClock, opts: { devTools?: boolean } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  /**
   * DEMO AUTH — replace with your real session/JWT middleware.
   * It must set req.user = { id, name, email, role }.
   */
  app.use('/api', (req, _res, next) => {
    const id = req.header('x-user-id');
    if (id) req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
    next();
  });
  const need = (role: User['role']) => (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new RuleError(401, 'UNAUTHENTICATED', 'Please sign in.'));
    if (req.user.role !== role) return next(new RuleError(403, 'FORBIDDEN', 'You do not have access to this page.'));
    next();
  };
  const actor = (req: Request): Actor => ({ id: req.user!.id, name: req.user!.name });
  const ownTest = (req: Request): TestRow => {
    const t = getTest(db, req.params.id);
    if (t.lecturer_id !== req.user!.id) throw new RuleError(404, 'NOT_FOUND', 'TEST not found.');
    return t;
  };

  // ------------------------------------------------------------ shared
  app.get('/api/time', wrap(() => ({ serverNow: new Date(clock.now()).toISOString() })));
  app.get('/api/users', wrap(() => db.prepare('SELECT id, name, role FROM users ORDER BY role, name').all()));
  app.get('/api/me', wrap((req) => req.user ?? null));
  app.get('/api/me/notifications', wrap((req) => {
    if (!req.user) throw new RuleError(401, 'UNAUTHENTICATED', 'Please sign in.');
    return db.prepare("SELECT id, test_id AS testId, subject, body, created_at AS createdAt FROM notifications WHERE user_id = ? AND channel = 'in_app' ORDER BY id DESC LIMIT 50").all(req.user.id)
      .map((n: any) => ({ ...n, createdAt: new Date(n.createdAt).toISOString() }));
  }));

  // ------------------------------------------------------------ lecturer
  const L = express.Router();
  L.use(need('lecturer'));
  L.get('/students', wrap(() => db.prepare("SELECT id, name, email FROM users WHERE role = 'student' ORDER BY name").all()));
  L.get('/tests', wrap((req) => {
    const now = clock.now();
    const rows = db.prepare('SELECT * FROM tests WHERE lecturer_id = ? ORDER BY window_start').all(req.user!.id) as unknown as TestRow[];
    return { serverNow: new Date(now).toISOString(), tests: rows.map((t) => testView(db, t, now)) };
  }));
  L.post('/tests', wrap((req, res) => {
    const t = createTest(db, req.body, actor(req), clock.now());
    res.status(201);
    return testView(db, t, clock.now());
  }));
  L.get('/tests/:id', wrap((req) => {
    const now = clock.now();
    return { serverNow: new Date(now).toISOString(), test: testView(db, ownTest(req), now) };
  }));
  L.post('/tests/:id/schedule/preview', wrap((req) => { ownTest(req); return previewSchedule(db, req.params.id, req.body ?? {}, clock.now()); }));
  L.post('/tests/:id/schedule/apply', wrap((req) => {
    ownTest(req);
    const plan = applySchedule(db, req.params.id, req.body ?? {}, actor(req), clock.now());
    return { plan, test: testView(db, getTest(db, req.params.id), clock.now()) };
  }));
  const lifecycle = (fn: (id: string, req: Request) => void) => wrap((req) => {
    ownTest(req);
    fn(req.params.id, req);
    return testView(db, getTest(db, req.params.id), clock.now());
  });
  L.post('/tests/:id/publish', lifecycle((id, req) => publishTest(db, id, actor(req), clock.now())));
  L.post('/tests/:id/lock', lifecycle((id, req) => setLocked(db, id, true, actor(req), clock.now(), req.body?.reason)));
  L.post('/tests/:id/unlock', lifecycle((id, req) => setLocked(db, id, false, actor(req), clock.now(), req.body?.reason)));
  L.post('/tests/:id/cancel', lifecycle((id, req) => cancelTest(db, id, actor(req), clock.now(), req.body?.reason)));
  L.get('/tests/:id/audit', wrap((req) => { ownTest(req); return auditRows(db, 'WHERE a.test_id = ?', [req.params.id]); }));
  L.get('/audit', wrap((req) => auditRows(db, 'WHERE t.lecturer_id = ?', [req.user!.id])));
  app.use('/api/lecturer', L);

  // ------------------------------------------------------------ student
  const S = express.Router();
  S.use(need('student'));
  S.get('/tests', wrap((req) => {
    const now = clock.now();
    const rows = db.prepare(`SELECT t.* FROM tests t JOIN batch_students bs ON bs.test_id = t.id
                             WHERE bs.student_id = ? AND t.status != 'draft' ORDER BY t.window_start`).all(req.user!.id) as unknown as TestRow[];
    return { serverNow: new Date(now).toISOString(), tests: rows.map((t) => studentTestView(db, t, req.user!.id, now)) };
  }));
  S.get('/tests/:id', wrap((req) => {
    const now = clock.now();
    const t = getTest(db, req.params.id);
    const v = t.status === 'draft' ? null : studentTestView(db, t, req.user!.id, now);
    if (!v) throw new RuleError(404, 'NOT_FOUND', 'TEST not found.');
    return { serverNow: new Date(now).toISOString(), test: v };
  }));
  S.post('/tests/:id/start', wrap((req) => {
    const a = startAttempt(db, req.params.id, req.user!.id, clock.now());
    return { attempt: a, questions: publicQuestions(getTest(db, req.params.id)) };
  }));
  S.get('/attempts/:id', wrap((req) => {
    const a = getAttempt(db, req.params.id, req.user!.id, clock.now());
    return { attempt: a, questions: publicQuestions(getTest(db, a.testId)) };
  }));
  S.put('/attempts/:id/answers', wrap((req) => ({ attempt: saveAnswers(db, req.params.id, req.user!.id, req.body?.answers ?? {}, clock.now()) })));
  S.post('/attempts/:id/submit', wrap((req) => ({ attempt: submitAttempt(db, req.params.id, req.user!.id, req.body?.answers, clock.now()) })));
  app.use('/api/student', S);

  // ------------------------------------------------------------ dev clock (demo only)
  if (opts.devTools) {
    app.post('/api/dev/clock', wrap((req) => {
      const c = clock as Clock & { offset?: number };
      if (typeof c.offset !== 'number') throw new RuleError(400, 'NO_DEV_CLOCK', 'Dev clock not enabled.');
      c.offset += Number(req.body?.addMinutes ?? 0) * 60_000;
      if (req.body?.reset) c.offset = 0;
      return { serverNow: new Date(clock.now()).toISOString(), offsetMinutes: c.offset / 60_000 };
    }));
  }

  app.use('/api', (_req, _res, next) => next(new RuleError(404, 'NOT_FOUND', 'Not found.')));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof RuleError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof SyntaxError) return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid request body.' } });
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });
  return app;
}

function auditRows(db: DB, where: string, params: string[]) {
  return (db.prepare(`SELECT a.*, t.title FROM schedule_audit a JOIN tests t ON t.id = a.test_id ${where} ORDER BY a.id DESC LIMIT 500`).all(...params) as any[])
    .map((r) => ({
      id: r.id, testId: r.test_id, testTitle: r.title, actorId: r.actor_id, actorName: r.actor_name, action: r.action,
      summary: r.summary, reason: r.reason, changes: JSON.parse(r.changes_json), createdAt: new Date(r.created_at).toISOString(),
    }));
}

function publicQuestions(t: TestRow) {
  return (JSON.parse(t.questions_json) as any[]).map(({ answer: _hidden, ...q }) => q);
}

function studentTestView(db: DB, t: TestRow, studentId: string, now: number) {
  const s = loadState(db, t);
  const b = s.batches.find((x) => x.studentIds.includes(studentId));
  if (!b) return null;
  const a = db.prepare('SELECT id, submitted_at, deadline_at, submit_reason FROM attempts WHERE test_id = ? AND student_id = ?').get(t.id, studentId) as any;
  const phase = batchPhase(t, b, now);
  const attemptState = !a ? 'not_started' : a.submitted_at != null || a.deadline_at <= now ? 'submitted' : 'in_progress';
  return {
    id: t.id, title: t.title, status: t.status, locked: !!t.locked, timezone: s.timezone, cancelReason: t.cancel_reason,
    batch: { name: b.name, startAt: new Date(b.startAt).toISOString(), endAt: new Date(b.endAt).toISOString(), durationMinutes: b.durationMinutes, phase },
    attempt: a ? { id: a.id, state: attemptState, submitReason: a.submit_reason } : null,
    canStart: t.status === 'published' && !t.locked && phase === 'open' && !a,
    canResume: attemptState === 'in_progress',
    testLink: `/student/tests/${t.id}`,
  };
}
