import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { openDb, DB } from '../src/db.js';
import { createApp } from '../src/app.js';
import { sweepExpired } from '../src/attempts.js';
import { zonedToUtc } from '../src/time.js';

const TZ = 'Africa/Lagos';
const MIN = 60_000;
let db: DB;
let clock: { t: number; now(): number };
let app: ReturnType<typeof createApp>;

const L = () => ({ 'x-user-id': 'lec' });
const S = (n: number) => ({ 'x-user-id': `s${n}` });

beforeEach(() => {
  db = openDb();
  clock = { t: zonedToUtc('2026-12-01', '08:00', TZ), now() { return this.t; } };
  app = createApp(db, clock);
  db.prepare("INSERT INTO users VALUES ('lec','Dr Lec','l@x','lecturer'), ('lec2','Dr Other','o@x','lecturer')").run();
  for (let i = 1; i <= 6; i++) db.prepare("INSERT INTO users VALUES (?,?,?,'student')").run(`s${i}`, `Student ${i}`, `s${i}@x`);
});

async function makeTest(over: Record<string, unknown> = {}) {
  const r = await request(app).post('/api/lecturer/tests').set(L()).send({
    title: 'CA TEST', timezone: TZ, date: '2026-12-01', startTime: '09:00', endTime: '11:00',
    durationMinutes: 45, numberOfBatches: 2, studentIds: ['s1', 's2', 's3', 's4'],
    questions: [{ id: 'q1', type: 'mcq', text: 'Q?', options: ['a', 'b'], answer: 1 }], ...over,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
const publish = (id: string) => request(app).post(`/api/lecturer/tests/${id}/publish`).set(L());
const get = async (id: string) => (await request(app).get(`/api/lecturer/tests/${id}`).set(L())).body.test;
const preview = (id: string, body: object) => request(app).post(`/api/lecturer/tests/${id}/schedule/preview`).set(L()).send(body);
async function apply(id: string, body: object) {
  const v = (await get(id)).version;
  return request(app).post(`/api/lecturer/tests/${id}/schedule/apply`).set(L()).send({ ...body, expectedVersion: v, confirm: true });
}

test('creation splits the window into batches and distributes students', async () => {
  const t = await makeTest();
  assert.equal(t.status, 'draft');
  assert.equal(t.date, '2026-12-01');
  assert.equal(t.startTime, '09:00');
  assert.equal(t.batches.length, 2);
  assert.deepEqual(t.batches.map((b: any) => [b.startTime, b.endTime]), [['09:00', '10:00'], ['10:00', '11:00']]);
  assert.deepEqual(t.batches[0].studentIds, ['s1', 's2']);
  assert.equal(t.batches[0].durationMinutes, 45);
});

test('preview shows old vs new; apply requires confirm and matching version', async () => {
  const t = await makeTest();
  const p = await preview(t.id, { test: { date: '2026-12-03' } });
  assert.equal(p.status, 200);
  assert.ok(p.body.ok);
  const dateRow = p.body.changes.find((c: any) => c.field === 'TEST Date');
  assert.deepEqual([dateRow.old, dateRow.new], ['2026-12-01', '2026-12-03']);
  assert.equal(p.body.after.batches[0].date, '2026-12-03', 'batches move with the TEST');

  const noConfirm = await request(app).post(`/api/lecturer/tests/${t.id}/schedule/apply`).set(L()).send({ test: { date: '2026-12-03' }, expectedVersion: t.version });
  assert.equal(noConfirm.status, 400);
  const stale = await request(app).post(`/api/lecturer/tests/${t.id}/schedule/apply`).set(L()).send({ test: { date: '2026-12-03' }, expectedVersion: t.version - 1, confirm: true });
  assert.equal(stale.status, 409);

  const ok = await apply(t.id, { test: { date: '2026-12-03' }, reason: 'Clash with another departmental paper' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.test.date, '2026-12-03');

  const log = (await request(app).get(`/api/lecturer/tests/${t.id}/audit`).set(L())).body;
  assert.equal(log[0].action, 'schedule_updated');
  assert.equal(log[0].actorName, 'Dr Lec');
  assert.equal(log[0].reason, 'Clash with another departmental paper');
  assert.ok(log[0].changes.some((c: any) => c.field === 'TEST Date'));
});

test('duration change cascades to batches that inherited it', async () => {
  const t = await makeTest();
  const r = await apply(t.id, { test: { durationMinutes: 50 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.test.batches.map((b: any) => b.durationMinutes), [50, 50]);
  const tooLong = await preview(t.id, { test: { durationMinutes: 70 } });
  assert.equal(tooLong.body.ok, false);
  assert.ok(tooLong.body.errors.some((e: string) => e.includes('longer than its window')));
});

test('batches must stay inside the TEST window', async () => {
  const t = await makeTest();
  const r = await preview(t.id, { batches: [{ id: t.batches[1].id, startTime: '10:30', endTime: '11:30' }] });
  assert.equal(r.body.ok, false);
  assert.ok(r.body.errors.some((e: string) => e.includes('outside the TEST window')));
});

test('editable after publishing until a student starts; students notified', async () => {
  const t = await makeTest();
  assert.equal((await publish(t.id)).status, 200);
  const r = await apply(t.id, { test: { startTime: '09:30' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.test.endTime, '11:30', 'window length preserved');
  const notes = (await request(app).get('/api/me/notifications').set(S(1))).body;
  assert.ok(notes.some((n: any) => n.subject.startsWith('TEST schedule changed')));
});

test('server enforces the batch window when starting', async () => {
  const t = await makeTest();
  await publish(t.id);
  const early = await request(app).post(`/api/student/tests/${t.id}/start`).set(S(1));
  assert.equal(early.status, 403);
  assert.equal(early.body.error.code, 'NOT_OPEN');
  clock.t = zonedToUtc('2026-12-01', '09:05', TZ);
  const wrongBatch = await request(app).post(`/api/student/tests/${t.id}/start`).set(S(3)); // batch B at 10:00
  assert.equal(wrongBatch.body.error.code, 'NOT_OPEN');
  const unassigned = await request(app).post(`/api/student/tests/${t.id}/start`).set(S(6));
  assert.equal(unassigned.body.error.code, 'NOT_ASSIGNED');
  const ok = await request(app).post(`/api/student/tests/${t.id}/start`).set(S(1));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.attempt.remainingMs, 45 * MIN);
  assert.ok(!('answer' in ok.body.questions[0]), 'answers never sent to students');
});

test('once a student starts: TEST timing and that batch are frozen, other batches stay editable', async () => {
  const t = await makeTest();
  await publish(t.id);
  clock.t = zonedToUtc('2026-12-01', '09:10', TZ);
  const a = (await request(app).post(`/api/student/tests/${t.id}/start`).set(S(1))).body.attempt;

  const testLevel = await preview(t.id, { test: { durationMinutes: 50 } });
  assert.equal(testLevel.body.ok, false);
  assert.ok(testLevel.body.errors.some((e: string) => e.includes('TEST-level timing is locked')));

  const batchA = await preview(t.id, { batches: [{ id: t.batches[0].id, durationMinutes: 30 }] });
  assert.equal(batchA.body.ok, false);

  const moveStarted = await preview(t.id, { batches: [{ id: t.batches[1].id, studentIds: ['s1', 's3', 's4'] }] });
  assert.equal(moveStarted.body.ok, false);
  assert.ok(moveStarted.body.errors.some((e: string) => e.includes('already started')));

  const batchB = await apply(t.id, { batches: [{ id: t.batches[1].id, startTime: '10:15', endTime: '11:00', durationMinutes: 40 }] });
  assert.equal(batchB.status, 200, JSON.stringify(batchB.body));
  const b = batchB.body.test.batches.find((x: any) => x.id === t.batches[1].id);
  assert.deepEqual([b.startTime, b.endTime, b.durationMinutes], ['10:15', '11:00', 40]);

  // the running session is untouched
  const again = (await request(app).get(`/api/student/attempts/${a.id}`).set(S(1))).body.attempt;
  assert.equal(again.deadlineAt, a.deadlineAt);
  assert.equal(again.startedAt, a.startedAt);

  const editable = await get(t.id);
  assert.equal(editable.editable.timing, false);
  assert.equal(editable.batches[0].editable, false);
  assert.equal(editable.editable.canCancel, false);
});

test('refresh resumes the same session; deadline is capped at batch end', async () => {
  const t = await makeTest();
  await publish(t.id);
  clock.t = zonedToUtc('2026-12-01', '09:40', TZ); // 20 minutes before batch A closes
  const a = (await request(app).post(`/api/student/tests/${t.id}/start`).set(S(2))).body.attempt;
  assert.equal(a.remainingMs, 20 * MIN);
  clock.t += 5 * MIN;
  const again = (await request(app).post(`/api/student/tests/${t.id}/start`).set(S(2))).body.attempt;
  assert.equal(again.id, a.id);
  assert.equal(again.remainingMs, 15 * MIN);
});

test('answers rejected after deadline; sweeper auto-submits', async () => {
  const t = await makeTest();
  await publish(t.id);
  clock.t = zonedToUtc('2026-12-01', '09:00', TZ);
  const a = (await request(app).post(`/api/student/tests/${t.id}/start`).set(S(1))).body.attempt;
  const save = await request(app).put(`/api/student/attempts/${a.id}/answers`).set(S(1)).send({ answers: { q1: 1 } });
  assert.equal(save.status, 200);
  clock.t += 45 * MIN + 2_000; // inside grace: still accepted
  assert.equal((await request(app).put(`/api/student/attempts/${a.id}/answers`).set(S(1)).send({ answers: { q2: 1 } })).status, 200);
  clock.t += 10_000;
  const late = await request(app).put(`/api/student/attempts/${a.id}/answers`).set(S(1)).send({ answers: { q3: 0 } });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'TIME_UP');
  const done = (await request(app).get(`/api/student/attempts/${a.id}`).set(S(1))).body.attempt;
  assert.equal(done.submitReason, 'auto_expired');
  assert.deepEqual(done.answers, { q1: 1, q2: 1 });
});

test('sweeper closes sessions with no client', async () => {
  const t = await makeTest({ numberOfBatches: 1 });
  await publish(t.id);
  clock.t = zonedToUtc('2026-12-01', '09:00', TZ);
  await request(app).post(`/api/student/tests/${t.id}/start`).set(S(1));
  clock.t += 46 * MIN;
  assert.equal(sweepExpired(db, clock.t), 1);
});

test('lock blocks new starts but not active sessions; cancel needs no starts', async () => {
  const t = await makeTest({ numberOfBatches: 1 });
  await publish(t.id);
  clock.t = zonedToUtc('2026-12-01', '09:05', TZ);
  const a = (await request(app).post(`/api/student/tests/${t.id}/start`).set(S(1))).body.attempt;
  assert.equal((await request(app).post(`/api/lecturer/tests/${t.id}/lock`).set(L())).status, 200);
  const blocked = await request(app).post(`/api/student/tests/${t.id}/start`).set(S(2));
  assert.equal(blocked.body.error.code, 'LOCKED');
  assert.equal((await request(app).put(`/api/student/attempts/${a.id}/answers`).set(S(1)).send({ answers: { q1: 0 } })).status, 200);
  assert.equal((await request(app).post(`/api/lecturer/tests/${t.id}/cancel`).set(L())).status, 409);
  await request(app).post(`/api/lecturer/tests/${t.id}/unlock`).set(L());
  const log = (await request(app).get(`/api/lecturer/tests/${t.id}/audit`).set(L())).body.map((x: any) => x.action);
  assert.deepEqual(log.slice(0, 3), ['unlocked', 'locked', 'published']);
});

test('postpone must move later; cancel before start notifies students', async () => {
  const t = await makeTest();
  await publish(t.id);
  const back = await preview(t.id, { action: 'postpone', test: { date: '2026-11-30' } });
  assert.equal(back.body.ok, false);
  const ok = await apply(t.id, { action: 'postpone', test: { date: '2026-12-08' }, reason: 'Public holiday' });
  assert.equal(ok.status, 200);
  const c = await request(app).post(`/api/lecturer/tests/${t.id}/cancel`).set(L()).send({ reason: 'Course merged' });
  assert.equal(c.status, 200);
  assert.equal(c.body.status, 'cancelled');
  const n = (await request(app).get('/api/me/notifications').set(S(4))).body;
  assert.ok(n.some((x: any) => x.subject === 'TEST cancelled: CA TEST'));
  const r = await preview(t.id, { test: { date: '2026-12-09' } });
  assert.equal(r.body.ok, false);
});

test('published TEST cannot be moved into the past', async () => {
  const t = await makeTest();
  await publish(t.id);
  clock.t = zonedToUtc('2026-12-01', '08:50', TZ);
  const r = await preview(t.id, { test: { startTime: '08:30' } });
  assert.equal(r.body.ok, false);
  assert.ok(r.body.errors.some((e: string) => e.includes('cannot be in the past')));
});

test('other lecturers and students cannot manage the TEST', async () => {
  const t = await makeTest();
  assert.equal((await request(app).get(`/api/lecturer/tests/${t.id}`).set({ 'x-user-id': 'lec2' })).status, 404);
  assert.equal((await request(app).post(`/api/lecturer/tests/${t.id}/schedule/preview`).set(S(1)).send({})).status, 403);
});

test('windows may cross midnight', async () => {
  const t = await makeTest({ startTime: '22:00', endTime: '01:00', numberOfBatches: 1, durationMinutes: 60 });
  assert.equal(t.endsNextDay, true);
  const r = await preview(t.id, { batches: [{ id: t.batches[0].id, startTime: '23:30', endTime: '00:45' }] });
  assert.ok(r.body.ok, JSON.stringify(r.body.errors));
});
