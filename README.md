# TEST Management: scheduling module

Node/Express (TypeScript) + React. This module lets lecturers fully control TEST timing (date, start and end times, duration, batches, batch timing and student assignment), with every rule **enforced on the server**. Students get a server-timed countdown that carries on through refreshes and dropped connections, and submits automatically when time runs out.

All user-facing wording says **TEST** (see `shared/terms.ts`). Internal names (tables, routes, variables) use `test` where they need a name at all.

## Run it

```bash
cd server && npm install && npm run dev        # API on :4000, seeds demo data
cd client && npm install && npm run dev        # UI on :5173 (proxies /api)
```

Production: `cd client && npm run build`, then `cd server && npm start` serves the API and the built UI on :4000.

The demo data is generated relative to "now", so there's always one Active, one Upcoming, one Draft and one Completed TEST. Use **Signed in as** in the top bar to switch between lecturer and student.

Tests: `cd server && npm test` runs 15 rule tests against a controllable clock.

## What lecturers can do

| Where | What |
|---|---|
| **TEST Schedule** (`/lecturer/schedule`) | Every TEST grouped as Active / Upcoming / Draft / Completed / Cancelled TESTS; live "closes in" / "opens in" per batch; active and submitted session counts; Edit, Postpone, Lock/Unlock, Publish, Cancel; copy the TEST Link |
| **Edit TEST Schedule** | TEST Date, Start Time, End Time, Duration; add, remove or rename batches; per-batch start, end and duration; move students between batches. Locked fields are disabled, and the reason is shown |
| **Confirmation** | Before anything is saved, the server returns an old → new comparison, plus any errors, warnings and how many students will be notified. Changes apply only on **Apply changes** |
| **TEST History** | Audit log of every scheduling action: who, when, what changed (old → new) and the reason |
| **Create TEST** | AI TEST Generation / Manual TEST Generation, schedule, number of batches (the window is split automatically), students |

## Scheduling rules (server-enforced, `server/src/schedule.ts`)

1. **TEST-level timing** (date, start, end, duration, time zone) can be edited while the TEST is a draft, or after publishing **until the first student starts**. After that it's locked.
2. **Each batch** can be edited independently until it has *started*: a student has begun in it, or (once published) its end time has passed. Active and completed batches are frozen; the others stay editable.
3. **Running sessions are never changed.** Each student's start time, deadline and allocated minutes are snapshotted when they press Start. Deadline = `min(start + batch duration, batch end)`.
4. Changing the TEST date or start time **moves the batches with it** (optional). Changing the TEST duration updates every batch that was using it. Access windows are read from the database on every request, so new times take effect immediately.
5. Batches must sit inside the TEST window. A duration can't be longer than its window. A published TEST can't be moved into the past, and its end must be in the future. A window can cross midnight (an end time earlier than the start time means the next day), up to 24 hours.
6. Students who have started can't be moved. Students can't be added to a batch that has ended.
7. **Optimistic locking**: an apply must carry the version the lecturer reviewed. If someone else changed the schedule in between, the server returns 409 and the lecturer reviews again.
8. **Lock** blocks new starts only; active sessions continue. **Cancel** is allowed only if no student has started. **Postpone** moves the whole TEST later, through the same review step.
9. Every applied change writes an audit row and, for published TESTS, an in-app notification plus a queued email row (`notifications` table) for each affected student.

## Student timer (`server/src/attempts.ts`, `client/src/pages/Student.tsx`)

- The server decides the deadline. The client only displays it, using a clock anchored to server time with `performance.now()`. Changing the device clock does nothing. The clock resyncs every 20s, when the connection returns, and when the tab regains focus.
- A refresh resumes the same session (`POST /start` is idempotent).
- Answers autosave and are also kept on the device while offline.
- At zero the client submits. The server also auto-submits independently: a sweeper runs every 5 seconds, and any read of an expired session closes it. Answers sent more than 5 seconds after the deadline are rejected.

## Plugging into your app

- **Auth**: `server/src/app.ts` uses a demo `x-user-id` header. Replace that middleware with your session/JWT so it sets `req.user = { id, name, email, role }`.
- **Email**: rows with `channel = 'email'` in `notifications` are the outbox. Point your mailer at them and set `sent_at`.
- **Questions / results**: the `questions_json` column is a placeholder for your AI or manual question bank.
- **Multiple server instances**: the rules depend on SQLite's single-writer transactions. On Postgres/MySQL, wrap `applySchedule`/`startAttempt` in a transaction and lock the TEST row (`SELECT … FOR UPDATE`).

## Renaming "Examination" → "TEST" in other code

```bash
node scripts/rename-terminology.mjs ../your-app                 # dry run, prints every change
node scripts/rename-terminology.mjs ../your-app --apply --report changes.csv
node scripts/rename-terminology.mjs ../your-app --include-exam  # also convert Exam/Exams
```

It changes only text people read: string literals, JSX text, template text and JSON values. Identifiers, routes, database names, object keys, URLs and class names are left alone.

## API (lecturer)

`GET /api/lecturer/tests` · `POST /api/lecturer/tests` · `GET /api/lecturer/tests/:id` ·
`POST …/:id/schedule/preview` · `POST …/:id/schedule/apply` (`expectedVersion`, `confirm: true`) ·
`POST …/:id/publish|lock|unlock|cancel` · `GET …/:id/audit` · `GET /api/lecturer/audit`

Student: `GET /api/student/tests` · `POST /api/student/tests/:id/start` · `GET /api/student/attempts/:id` ·
`PUT …/answers` · `POST …/submit` · `GET /api/time`
