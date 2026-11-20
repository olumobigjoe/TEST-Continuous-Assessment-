# TEST Management — Continuous Assessment Platform

A starter production-oriented web application for lecturers and students to create, schedule, deliver and analyse continuous assessment TESTS. All visible product terminology uses **TEST**.

## Technology

- Python 3.11+
- FastAPI REST API
- SQLAlchemy 2 ORM
- SQLite for local development; MySQL 8+ supported through PyMySQL
- JWT authentication in an HttpOnly cookie
- Argon2 password hashing
- Jinja2 templates and responsive vanilla JavaScript interface
- Alembic migration scaffolding

## Features implemented

- Lecturer/admin and student roles
- Student self-registration API (student role only)
- Lecturer/admin account bootstrap script
- Create draft TESTS and add manual questions
- Optional AI TEST question generation using an OpenAI API key
- Publish a TEST after questions have been added
- Create configurable batches and assign students by student IDs
- Edit the overall TEST schedule and independently edit upcoming batch schedules
- Confirmation preview in the lecturer interface before schedule changes
- Lock/unlock upcoming batches
- Cancel eligible TESTS and postpone TESTS without active batches
- Audit records for schedule edits, batch lock changes and cancellation/postponement
- Server-generated session start and expiry timestamps
- A student's allocated duration is snapshotted when the session starts
- Browser refresh restores the existing session and server expiry
- Per-student question ordering is randomized and stored for the session
- Answers are saved to the backend
- Expired sessions are finalized on the server when the student next reconnects or makes a request
- Automatic scoring and TEST results
- Lecturer dashboard, student portal, results, TEST analytics and active-session overview APIs
- Student account registration and lecturer-facing student directory
- Copyable TEST portal links and schedule audit history
- Tests for key scheduling invariants

## Important scheduling rules

1. A student's timer starts only when the backend creates their TEST session.
2. The backend stores `started_at`, `allocated_minutes` and `expires_at`. The frontend timer is display-only.
3. A student's active session is not changed by edits to the TEST or another batch.
4. An overall schedule edit shifts and updates only batches still in `scheduled` state. Active and completed batches are left unchanged.
5. A batch can be independently edited only while it is still scheduled and unlocked.
6. TEST questions are editable only while the TEST is a draft. The session stores the TEST version used at start.
7. The backend rejects answer saves after the server expiry timestamp and finalizes the session.

## Run locally

```bash
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# macOS/Linux:
source .venv/bin/activate

pip install -r requirements.txt
cp .env.example .env
python create_user.py
uvicorn app.main:app --reload
```

Open `http://127.0.0.1:8000`.

- Lecturer dashboard: `/dashboard`
- Student portal: `/student`
- API documentation: `/docs`
- Health check: `/health`

The database is created automatically for a new local SQLite database.

## Configure MySQL

Create a MySQL database and a least-privilege database user, then set `DATABASE_URL` in `.env`:

```env
DATABASE_URL=mysql+pymysql://test_app:YOUR_PASSWORD@127.0.0.1:3306/test_management?charset=utf8mb4
```

Use a strong unique `SECRET_KEY`, set `COOKIE_SECURE=true` behind HTTPS, and set `ENVIRONMENT=production` before deployment. Never commit `.env` or production secrets.

## Create lecturer/admin accounts

Run:

```bash
python create_user.py
```

Choose `lecturer` or `admin`. Public self-registration deliberately creates student accounts only.

## Student registration

The student registration API is `POST /api/auth/register`:

```json
{
  "full_name": "Student Name",
  "email": "student@example.com",
  "password": "a-long-unique-password",
  "role": "student",
  "matric_number": "FPA/BCH/25/3-0001"
}
```

Students must be assigned to a TEST batch by an authorized lecturer/admin using `POST /api/tests/{test_id}/batches/{batch_id}/assign` with `{ "student_ids": [1, 2] }`.

## API workflow

1. Lecturer signs in at `POST /api/auth/login`.
2. Create a TEST using `POST /api/tests` with a title, schedule, duration, batch count and optional question array.
3. Add questions using `POST /api/tests/{test_id}/questions`.
4. Assign student IDs to batches using `POST /api/tests/{test_id}/batches/{batch_id}/assign`.
5. Publish using `POST /api/tests/{test_id}/publish`.
6. Edit overall schedule using `GET /api/tests/{test_id}/schedule/preview` followed by `PATCH /api/tests/{test_id}/schedule`.
7. Edit an eligible batch using `PATCH /api/tests/{test_id}/batches/{batch_id}/schedule`.
8. Student signs in and starts using `POST /api/student/tests/{test_id}/start` during their assigned batch window.
9. Fetch session questions from `GET /api/student/sessions/{session_id}` and save answers using `POST /api/student/sessions/{session_id}/answer`.
10. Submit using `POST /api/student/sessions/{session_id}/submit`. Expired sessions are finalized by the backend.

## AI TEST generation

Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in the server environment. The lecturer UI can request draft questions by topic. Generated questions are inserted into the selected draft TEST; lecturers should review all generated content and correct answers before publishing.

AI generation is optional. Manual TEST creation and delivery do not require an AI API key.

## Run tests

```bash
pytest -q
```

## Database migrations

Alembic scaffolding is included. For an existing deployment, create and review migrations before applying schema changes:

```bash
alembic revision --autogenerate -m "describe schema change"
alembic upgrade head
```

Do not rely on `create_all()` to alter an existing production database schema.

## Before production deployment

This repository package is a runnable first implementation, not a claim of completed third-party security certification. Before real institutional use:

- Use HTTPS and secure cookies.
- Configure a strong secret and production MySQL credentials.
- Generate and review the first Alembic migration; deploy schema changes through migrations.
- Add institutional email verification, password reset, and account invitation workflows.
- Add rate limiting, CSRF protection appropriate to the deployment topology, security headers, and structured monitoring.
- Configure automated encrypted backups and a restore drill.
- Add load/concurrency testing for simultaneous session starts and submissions against the chosen MySQL isolation level.
- Review privacy, retention, accessibility, and institutional data-protection requirements.
- Validate AI-generated questions and answer keys before publishing.

## Repository upload

Extract this package into the root of `TEST-Continuous-Assessment-` so `README.md`, `requirements.txt`, `app/`, `tests/` and `create_user.py` are at the repository root. Commit the source files, but do not upload `.env`, database files, virtual environments or API keys.

## Current release scope

This package delivers the core single-institution TEST workflow and lecturer ownership boundaries. It is a foundation for the wider SaaS roadmap, not yet a complete multi-tenant commercial SaaS release. Institution/department tenant isolation, subscription billing, email/SMS delivery, bulk roster imports, downloadable report exports, advanced proctoring, and full institution-level user administration should be implemented and security-reviewed as subsequent modules before onboarding multiple institutions.

The current automated suite covers password/token helpers, schedule immutability rules, batch schedule edits, and an end-to-end student attempt. Run `python -m pytest -q` after installing the requirements.
