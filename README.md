# TEST Management — Continuous Assessment Platform

A starter production-oriented web application for lecturers and students to create, schedule, deliver and analyse continuous assessment TESTS. All visible product terminology uses **TEST**.

## Technology

- Python 3.11+
- FastAPI REST API
- SQLAlchemy 2 ORM
- SQLite for local development; MySQL 8+ supported through PyMySQL
- JWT authentication in an HttpOnly cookie
- PBKDF2-HMAC-SHA256 password hashing (600,000 iterations)
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

# Version 2 — Institution-ready administration

V2 adds an institution tenancy foundation while retaining the V1 TEST delivery and scheduling engine.

## V2 additions

- Institution records with unique institution codes and active/inactive state.
- Institution administrator role, provisioned by a platform administrator.
- Tenant association for users and TESTS; institution administrators see TESTS within their institution, while lecturers retain ownership restrictions.
- Department creation and institution-scoped department listing/assignment.
- CSV student import (UTF-8, maximum 2 MB) with duplicate checks and institution seat-limit enforcement.
- One-time student account setup invitations. Imported accounts cannot sign in until the student accepts the invitation and sets a password. Tokens are stored hashed and expire after 72 hours; share returned tokens with students through a secure channel.
- Institution overview counts and subscription metadata.
- CSV export of TEST results.
- Institution administration page at `/institution-admin`.
- Alembic migration `0002_institution_saas` for V1 database upgrades.

## V2 onboarding workflow

1. Create the platform administrator with `python create_user.py` and sign in.
2. Create an institution using `POST /api/v2/institutions`:

```json
{"name":"Example College","code":"EXCOL","email_domain":"example.edu.ng"}
```

3. Provision an institution administrator using `POST /api/v2/institutions/{institution_id}/users`:

```json
{"full_name":"Institution Administrator","email":"admin@example.edu.ng","password":"Use-A-Strong-Password","role":"institution_admin"}
```

4. Sign in as the institution administrator and open `/institution-admin`.
5. Create departments and import a CSV with these exact columns:

```csv
full_name,email,matric_number
Ada Student,ada@example.edu.ng,EXCOL/001
Tunde Student,tunde@example.edu.ng,EXCOL/002
```

6. Securely distribute each returned one-time setup token. Students configure their own passwords at `POST /api/v2/auth/accept-invitation`:

```json
{"token":"ONE_TIME_TOKEN_FROM_IMPORT","password":"Student-Chooses-A-Strong-Password"}
```

7. Create TESTS as usual. New TESTS inherit the lecturer's institution. Student assignment checks institution membership.
8. Export a TEST result sheet from `GET /api/v2/tests/{test_id}/results.csv`.

## V2 API summary

| Endpoint | Purpose |
|---|---|
| `POST /api/v2/institutions` | Create an institution (platform admin) |
| `POST /api/v2/institutions/{id}/users` | Provision institution admin or lecturer |
| `GET /api/v2/institution` | Institution profile and counts |
| `POST /api/v2/departments` | Create a department |
| `GET /api/v2/departments` | List institution departments |
| `PATCH /api/v2/users/{id}/department` | Assign a user to a department |
| `POST /api/v2/students/import` | Import student roster CSV |
| `POST /api/v2/auth/accept-invitation` | Set password using one-time invitation |
| `GET /api/v2/tests/{id}/results.csv` | Download TEST results CSV |
| `GET /api/v2/subscription` | Read subscription metadata |
| `PATCH /api/v2/subscription` | Update plan metadata (platform admin) |

## Upgrade an existing V1 database

Back up the database first. Set the production `DATABASE_URL`, then run:

```bash
alembic upgrade head
```

The V2 migration conditionally adds missing V2 columns and tables. Review it against a staging copy of your production database before applying it to live institutional data. Do not run `Base.metadata.create_all()` as a substitute for migrations on an existing database.

## Subscription and SaaS billing boundary

V2 includes subscription records, plan/status metadata and seat-limit enforcement during bulk import. It does **not** process payments, issue invoices, or connect to a payment provider. Those actions require a separately configured payment integration (for example Paystack or Flutterwave), verified webhook signatures, idempotent payment events, and reconciliation tests. Do not mark an institution as paid based solely on a browser request.

## V2 verification

Run:

```bash
pytest -q
node --check app/static/institution.js
python -m compileall -q app
```

The automated suite covers the existing TEST workflow and scheduling invariants plus institution onboarding, department creation, CSV import, invitation acceptance and single-use token enforcement.

## Production-readiness boundary

V2 is a tested development release, not a completed compliance/security certification. Before onboarding real institutions, add verified email delivery for invitations, password reset, CSRF protection for cookie-authenticated state-changing routes, rate limiting, structured audit trails for administrative membership changes, encrypted backups, monitoring, concurrency tests on MySQL, and a formal privacy/data-retention review. The current invitation tokens are returned to the authorized importing lecturer/admin; configure an email delivery service before large-scale deployment.
