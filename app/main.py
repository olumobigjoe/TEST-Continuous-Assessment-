from datetime import datetime, timezone
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException, Request, Response, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from app.config import settings
from app.database import Base, engine, get_db
from app.models import User, Role, Test, Question, Batch, BatchStudent, TestSession, TestResponse, TestResult, ScheduleAuditLog, TestSessionQuestion, TestStatus, BatchStatus, SessionStatus, Institution, InstitutionSubscription
from app.schemas import RegisterIn, LoginIn, TestCreateIn, ScheduleUpdateIn, BatchScheduleUpdateIn, BatchAssignIn, QuestionIn, AnswerIn
from app.security import hash_password, verify_password, create_access_token
from app.dependencies import current_user, require_roles
from app.services.scheduling import update_test_schedule, update_batch_schedule, as_utc
from app.services.sessions import start_session, require_live_session, finalize_session, now_utc

Base.metadata.create_all(bind=engine)
app = FastAPI(title=settings.app_name, version="2.0.0")
BASE = Path(__file__).resolve().parent
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
templates = Jinja2Templates(directory=BASE / "templates")
from app.v2 import router as v2_router
app.include_router(v2_router)

@app.get("/health")
def health(): return {"status": "ok", "service": settings.app_name}

@app.post("/api/auth/register", status_code=201)
def register(payload: RegisterIn, db: Session = Depends(get_db)):
    if payload.role != Role.STUDENT:
        raise HTTPException(403, "Lecturer and administrator accounts must be provisioned by an administrator")
    if db.scalar(select(User).where(User.email == payload.email)):
        raise HTTPException(409, "Email is already registered")
    institution = None
    if payload.institution_code:
        institution = db.scalar(select(Institution).where(Institution.code == payload.institution_code.strip().upper(), Institution.is_active.is_(True)))
        if not institution: raise HTTPException(422, "Institution code is invalid or inactive")
        subscription = db.scalar(select(InstitutionSubscription).where(InstitutionSubscription.institution_id == institution.id))
        student_count = db.scalar(select(func.count(User.id)).where(User.institution_id == institution.id, User.role == Role.STUDENT)) or 0
        if subscription and subscription.status in {"suspended", "cancelled"}:
            raise HTTPException(403, "Institution registration is currently unavailable")
        if subscription and student_count >= subscription.seat_limit:
            raise HTTPException(409, "Institution student seat limit has been reached")
    user = User(full_name=payload.full_name, email=payload.email, password_hash=hash_password(payload.password), role=Role.STUDENT, matric_number=payload.matric_number, institution_id=institution.id if institution else None)
    db.add(user); db.commit(); db.refresh(user)
    return {"id": user.id, "full_name": user.full_name, "email": user.email, "role": user.role.value}

@app.post("/api/auth/login")
def login(payload: LoginIn, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == payload.email))
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(401, "Incorrect email or password")
    if getattr(user, "password_setup_required", False):
        raise HTTPException(403, "Complete your student account setup using your invitation token before signing in")
    token = create_access_token(str(user.id))
    response.set_cookie("test_access", token, httponly=True, secure=settings.cookie_secure, samesite="lax", max_age=settings.access_token_expire_minutes * 60)
    return {"user": {"id": user.id, "name": user.full_name, "role": user.role.value}}

@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie("test_access")
    return {"message": "Signed out"}

@app.get("/api/me")
def me(user: User = Depends(current_user)):
    return {"id": user.id, "full_name": user.full_name, "email": user.email, "role": user.role.value}

@app.post("/api/tests", status_code=201)
def create_test(payload: TestCreateIn, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    start, end = as_utc(payload.scheduled_start), as_utc(payload.scheduled_end)
    if end <= start: raise HTTPException(422, "TEST end time must be after start time")
    if user.institution_id:
        subscription = db.scalar(select(InstitutionSubscription).where(InstitutionSubscription.institution_id == user.institution_id))
        if subscription and subscription.status in {"suspended", "cancelled"}:
            raise HTTPException(403, "Institution subscription does not permit new TEST creation")
    test = Test(lecturer_id=user.id, institution_id=user.institution_id, title=payload.title, course_code=payload.course_code, instructions=payload.instructions, scheduled_start=start, scheduled_end=end, duration_minutes=payload.duration_minutes, number_of_batches=payload.number_of_batches, status=TestStatus.DRAFT)
    db.add(test); db.flush()
    for q in payload.questions:
        db.add(Question(test_id=test.id, **q.model_dump()))
    # Default batches are created with equal start offsets; lecturers can edit each independently.
    from datetime import timedelta
    span = max(1, int((end - start).total_seconds() // 60))
    for i in range(payload.number_of_batches):
        batch_start = start + timedelta(minutes=(span * i // payload.number_of_batches))
        batch_end = min(end, batch_start + timedelta(minutes=payload.duration_minutes))
        db.add(Batch(test_id=test.id, name=f"Batch {i+1}", starts_at=batch_start, ends_at=batch_end, duration_minutes=payload.duration_minutes))
    db.commit(); db.refresh(test)
    return {"id": test.id, "title": test.title, "status": test.status.value, "version": test.version, "batch_count": len(test.batches), "test_link": f"/student?test_id={test.id}"}

@app.post("/api/tests/{test_id}/questions", status_code=201)
def add_question(test_id: int, payload: QuestionIn, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id)
    if not test or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST not found")
    if test.status != TestStatus.DRAFT: raise HTTPException(409, "Questions can only be edited while the TEST is a draft")
    q = Question(test_id=test.id, **payload.model_dump()); db.add(q); db.commit(); db.refresh(q)
    return {"id": q.id}

@app.post("/api/ai/generate-questions")
async def ai_generate_questions(payload: dict, user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    import httpx, json
    if not settings.openai_api_key:
        raise HTTPException(503, "AI TEST generation is not configured. Add OPENAI_API_KEY to the server environment.")
    topic = str(payload.get("topic", "")).strip()
    count = int(payload.get("count", 5))
    level = str(payload.get("level", "intermediate"))
    if not topic or not 1 <= count <= 30: raise HTTPException(422, "Provide a topic and a question count from 1 to 30")
    prompt = f"Create {count} original multiple-choice TEST questions about {topic} at {level} level. Return only JSON: {{\"questions\":[{{\"prompt\":string,\"option_a\":string,\"option_b\":string,\"option_c\":string,\"option_d\":string,\"correct_option\":\"A|B|C|D\",\"marks\":1}}]}}. Ensure one unambiguous correct answer per question."
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post("https://api.openai.com/v1/chat/completions", headers={"Authorization": f"Bearer {settings.openai_api_key}"}, json={"model": settings.openai_model, "messages": [{"role": "user", "content": prompt}], "response_format": {"type": "json_object"}})
    if response.status_code >= 400: raise HTTPException(502, "AI question generation service returned an error")
    try: data = json.loads(response.json()["choices"][0]["message"]["content"])
    except Exception: raise HTTPException(502, "AI returned an invalid question format")
    return {"questions": data.get("questions", [])}

@app.post("/api/tests/{test_id}/publish")
def publish_test(test_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id)
    if not test or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST not found")
    if not test.questions: raise HTTPException(409, "Add at least one TEST question before publishing")
    test.status = TestStatus.PUBLISHED; db.commit()
    return {"id": test.id, "status": test.status.value}

@app.get("/api/tests/{test_id}/schedule/preview")
def preview_test_schedule(test_id: int, scheduled_start: datetime, scheduled_end: datetime, duration_minutes: int, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id)
    if not test or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST not found")
    if scheduled_start.tzinfo is None or scheduled_end.tzinfo is None: raise HTTPException(422, "Provide timezone-aware TEST dates and times")
    if as_utc(scheduled_end) <= as_utc(scheduled_start): raise HTTPException(422, "TEST end time must be after start time")
    return {"previous": {"start": as_utc(test.scheduled_start).isoformat(), "end": as_utc(test.scheduled_end).isoformat(), "duration_minutes": test.duration_minutes}, "proposed": {"start": as_utc(scheduled_start).isoformat(), "end": as_utc(scheduled_end).isoformat(), "duration_minutes": duration_minutes}, "active_batches_unchanged": True}

@app.patch("/api/tests/{test_id}/schedule")
def edit_test_schedule(test_id: int, payload: ScheduleUpdateIn, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id)
    if not test or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST not found")
    update_test_schedule(db, test, user.id, payload.scheduled_start, payload.scheduled_end, payload.duration_minutes, payload.reason)
    return {"message": "TEST schedule updated", "version": test.version, "status": test.status.value}

@app.patch("/api/tests/{test_id}/batches/{batch_id}/schedule")
def edit_batch_schedule(test_id: int, batch_id: int, payload: BatchScheduleUpdateIn, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id); batch = db.get(Batch, batch_id)
    if not test or not batch or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST or batch not found")
    update_batch_schedule(db, test, batch, user.id, payload.starts_at, payload.ends_at, payload.duration_minutes, payload.reason)
    return {"message": "Batch schedule updated", "batch_id": batch.id}

@app.post("/api/tests/{test_id}/batches/{batch_id}/assign")
def assign_students(test_id: int, batch_id: int, payload: BatchAssignIn, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id); batch = db.get(Batch, batch_id)
    if not test or not batch or batch.test_id != test_id or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST or batch not found")
    if batch.status != BatchStatus.SCHEDULED: raise HTTPException(409, "Students cannot be reassigned after a batch starts")
    assigned_now = 0
    for sid in set(payload.student_ids):
        student = db.get(User, sid)
        if not student or student.role != Role.STUDENT: raise HTTPException(422, f"User {sid} is not a student")
        if test.institution_id is not None and student.institution_id != test.institution_id: raise HTTPException(422, f"Student {sid} does not belong to this institution")
        existing = db.scalar(select(BatchStudent).join(Batch).where(Batch.test_id == test_id, BatchStudent.student_id == sid))
        if existing:
            if existing.batch_id != batch.id:
                raise HTTPException(409, f"Student {sid} is already assigned to another batch for this TEST")
            continue
        db.add(BatchStudent(batch_id=batch.id, student_id=sid))
        assigned_now += 1
    db.commit(); return {"message": "Students assigned", "count": assigned_now}

@app.post("/api/tests/{test_id}/batches/{batch_id}/lock")
def lock_batch(test_id: int, batch_id: int, locked: bool = True, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id); batch = db.get(Batch, batch_id)
    if not test or not batch or batch.test_id != test_id or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST or batch not found")
    if batch.status != BatchStatus.SCHEDULED: raise HTTPException(409, "Only upcoming batches can be locked or unlocked")
    batch.is_locked = locked
    db.add(ScheduleAuditLog(test_id=test.id, batch_id=batch.id, actor_id=user.id, action="batch_locked" if locked else "batch_unlocked", old_schedule=None, new_schedule=None, reason="Lecturer changed batch access lock"))
    db.commit(); return {"batch_id": batch.id, "locked": locked}

@app.get("/api/students")
def list_students(db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    stmt = select(User).where(User.role == Role.STUDENT, User.is_active == True)
    if user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and user.institution_id is not None: stmt = stmt.where(User.institution_id == user.institution_id)
    rows = db.scalars(stmt.order_by(User.full_name)).all()
    return [{"id": u.id, "full_name": u.full_name, "email": u.email, "matric_number": u.matric_number} for u in rows]

@app.post("/api/tests/{test_id}/lock")
def lock_test(test_id: int, locked: bool = True, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id)
    if not test or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST not found")
    eligible = [batch for batch in test.batches if batch.status == BatchStatus.SCHEDULED]
    if not eligible: raise HTTPException(409, "There are no upcoming batches to lock or unlock")
    for batch in eligible:
        batch.is_locked = locked
    db.add(ScheduleAuditLog(test_id=test.id, actor_id=user.id, action="test_locked" if locked else "test_unlocked", reason="Lecturer changed TEST access lock"))
    db.commit()
    return {"test_id": test.id, "locked_batches": len(eligible), "locked": locked}

@app.get("/api/tests")
def list_tests(db: Session = Depends(get_db), user: User = Depends(current_user)):
    if user.role == Role.STUDENT:
        rows = db.scalars(select(Test).join(Batch).join(BatchStudent).where(BatchStudent.student_id == user.id).where((Test.institution_id == user.institution_id) | (Test.institution_id.is_(None)))).unique().all()
    elif user.role == Role.ADMIN:
        rows = db.scalars(select(Test)).all()
    elif user.role == Role.INSTITUTION_ADMIN:
        rows = db.scalars(select(Test).where(Test.institution_id == user.institution_id)).all()
    else:
        rows = db.scalars(select(Test).where(Test.lecturer_id == user.id)).all()
    return [{"id": t.id, "title": t.title, "course_code": t.course_code, "status": t.status.value, "scheduled_start": as_utc(t.scheduled_start).isoformat(), "scheduled_end": as_utc(t.scheduled_end).isoformat(), "duration_minutes": t.duration_minutes, "version": t.version, "locked": bool([b for b in t.batches if b.status == BatchStatus.SCHEDULED]) and all(b.is_locked for b in t.batches if b.status == BatchStatus.SCHEDULED), "test_link": f"/student?test_id={t.id}", "batches": [{"id": b.id, "name": b.name, "starts_at": as_utc(b.starts_at).isoformat(), "ends_at": as_utc(b.ends_at).isoformat(), "duration_minutes": b.duration_minutes, "status": b.status.value, "locked": b.is_locked} for b in t.batches]} for t in rows]

@app.get("/api/tests/{test_id}/audit")
def schedule_audit(test_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id)
    if not test or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST not found")
    rows = db.scalars(select(ScheduleAuditLog).where(ScheduleAuditLog.test_id == test_id).order_by(ScheduleAuditLog.created_at.desc())).all()
    return [{"actor_id": x.actor_id, "batch_id": x.batch_id, "action": x.action, "old_schedule": x.old_schedule, "new_schedule": x.new_schedule, "reason": x.reason, "created_at": as_utc(x.created_at).isoformat()} for x in rows]

@app.post("/api/student/tests/{test_id}/start")
def begin_test(test_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.STUDENT))):
    candidate = db.get(Test, test_id)
    if candidate and candidate.institution_id is not None and candidate.institution_id != user.institution_id: raise HTTPException(404, "TEST not found")
    s = start_session(db, test_id, user.id)
    return {"session_id": s.id, "started_at": as_utc(s.started_at).isoformat(), "expires_at": as_utc(s.expires_at).isoformat(), "allocated_minutes": s.allocated_minutes, "status": s.status.value}

@app.get("/api/student/sessions")
def my_sessions(db: Session = Depends(get_db), user: User = Depends(require_roles(Role.STUDENT))):
    sessions = db.scalars(select(TestSession).where(TestSession.student_id == user.id).order_by(TestSession.started_at.desc())).all()
    output = []
    for s in sessions:
        test = db.get(Test, s.test_id)
        result = db.scalar(select(TestResult).where(TestResult.session_id == s.id))
        output.append({"session_id": s.id, "test_id": s.test_id, "title": test.title if test else "TEST", "status": s.status.value, "expires_at": as_utc(s.expires_at).isoformat(), "result": {"score": result.score, "total_marks": result.total_marks, "percentage": result.percentage} if result else None})
    return output

@app.get("/api/student/sessions/{session_id}")
def session_detail(session_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.STUDENT))):
    s = db.scalar(select(TestSession).where(TestSession.id == session_id).with_for_update())
    if not s or s.student_id != user.id: raise HTTPException(404, "TEST session not found")
    if s.status == SessionStatus.IN_PROGRESS and now_utc() >= as_utc(s.expires_at):
        finalize_session(db, s, expired=True); raise HTTPException(410, "TEST time expired and responses were submitted")
    session_questions = db.scalars(select(TestSessionQuestion).where(TestSessionQuestion.session_id == s.id).order_by(TestSessionQuestion.order_index)).all()
    if session_questions:
        qs = [db.get(Question, sq.question_id) for sq in session_questions]
    else:
        qs = db.scalars(select(Question).where(Question.test_id == s.test_id).order_by(Question.id)).all()
    saved = {r.question_id: r.selected_option for r in db.scalars(select(TestResponse).where(TestResponse.session_id == s.id))}
    return {"session_id": s.id, "expires_at": as_utc(s.expires_at).isoformat(), "status": s.status.value, "server_time": now_utc().isoformat(), "questions": [{"id": q.id, "prompt": q.prompt, "options": {"A": q.option_a, "B": q.option_b, "C": q.option_c, "D": q.option_d}, "saved_answer": saved.get(q.id)} for q in qs]}

@app.post("/api/student/sessions/{session_id}/answer")
def save_answer(session_id: int, payload: AnswerIn, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.STUDENT))):
    s = require_live_session(db, session_id, user.id)
    q = db.get(Question, payload.question_id)
    if not q or q.test_id != s.test_id: raise HTTPException(404, "Question not found in this TEST")
    response = db.scalar(select(TestResponse).where(TestResponse.session_id == s.id, TestResponse.question_id == q.id))
    if response: response.selected_option = payload.selected_option; response.saved_at = now_utc()
    else: db.add(TestResponse(session_id=s.id, question_id=q.id, selected_option=payload.selected_option))
    db.commit(); return {"saved": True, "server_time": now_utc().isoformat()}

@app.post("/api/student/sessions/{session_id}/submit")
def submit_test(session_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.STUDENT))):
    s = db.scalar(select(TestSession).where(TestSession.id == session_id).with_for_update())
    if not s or s.student_id != user.id: raise HTTPException(404, "TEST session not found")
    if s.status == SessionStatus.IN_PROGRESS and now_utc() >= as_utc(s.expires_at):
        result = finalize_session(db, s, expired=True)
    elif s.status == SessionStatus.IN_PROGRESS:
        result = finalize_session(db, s)
    else:
        result = db.scalar(select(TestResult).where(TestResult.session_id == s.id))
    return {"submitted": True, "score": result.score if result else 0, "total_marks": result.total_marks if result else 0, "percentage": result.percentage if result else 0}

@app.get("/api/tests/{test_id}/results")
def test_results(test_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id)
    if not test or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST not found")
    rows = db.execute(select(TestSession, User, TestResult).join(User, User.id == TestSession.student_id).outerjoin(TestResult, TestResult.session_id == TestSession.id).where(TestSession.test_id == test_id)).all()
    return [{"student_id": student.id, "student_name": student.full_name, "matric_number": student.matric_number, "session_status": session.status.value, "score": result.score if result else None, "total_marks": result.total_marks if result else None, "percentage": result.percentage if result else None, "submitted_at": as_utc(session.submitted_at).isoformat() if session.submitted_at else None} for session, student, result in rows]

@app.get("/api/lecturer/overview")
def lecturer_overview(db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    base = select(Test)
    if user.role == Role.INSTITUTION_ADMIN: base = base.where(Test.institution_id == user.institution_id)
    elif user.role != Role.ADMIN: base = base.where(Test.lecturer_id == user.id)
    tests = db.scalars(base).all(); ids = [t.id for t in tests]
    sessions = db.scalars(select(TestSession).where(TestSession.test_id.in_(ids))).all() if ids else []
    return {"total_tests": len(tests), "active_tests": sum(t.status == TestStatus.ACTIVE for t in tests), "upcoming_tests": sum(t.status in (TestStatus.PUBLISHED, TestStatus.SCHEDULED) for t in tests), "completed_tests": sum(t.status == TestStatus.COMPLETED for t in tests), "student_sessions": len(sessions), "active_sessions": sum(s.status == SessionStatus.IN_PROGRESS for s in sessions)}

@app.get("/api/tests/{test_id}/analytics")
def test_analytics(test_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id)
    if not test or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST not found")
    results = db.scalars(select(TestResult).join(TestSession).where(TestSession.test_id == test_id)).all()
    percentages = [r.percentage for r in results]
    return {"test_id": test_id, "attempts": len(results), "average_percentage": round(sum(percentages)/len(percentages), 1) if percentages else None, "highest_percentage": max(percentages) if percentages else None, "lowest_percentage": min(percentages) if percentages else None, "total_questions": db.scalar(select(func.count(Question.id)).where(Question.test_id == test_id)) or 0}

@app.post("/api/tests/{test_id}/cancel")
def cancel_test(test_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id)
    if not test or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST not found")
    if any(b.status == BatchStatus.ACTIVE for b in test.batches): raise HTTPException(409, "A TEST with an active batch cannot be cancelled")
    if test.status == TestStatus.COMPLETED: raise HTTPException(409, "Completed TEST cannot be cancelled")
    test.status = TestStatus.CANCELLED
    for b in test.batches:
        if b.status == BatchStatus.SCHEDULED: b.status = BatchStatus.CANCELLED
    db.add(ScheduleAuditLog(test_id=test.id, actor_id=user.id, action="test_cancelled", reason="Cancelled by lecturer"))
    db.commit(); return {"status": test.status.value}

@app.post("/api/tests/{test_id}/postpone")
def postpone_test(test_id: int, payload: ScheduleUpdateIn, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id)
    if not test or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST not found")
    if any(b.status == BatchStatus.ACTIVE for b in test.batches): raise HTTPException(409, "A TEST with an active batch cannot be postponed as a whole")
    update_test_schedule(db, test, user.id, payload.scheduled_start, payload.scheduled_end, payload.duration_minutes, payload.reason or "TEST postponed")
    test.status = TestStatus.POSTPONED
    db.add(ScheduleAuditLog(test_id=test.id, actor_id=user.id, action="test_postponed", reason=payload.reason))
    db.commit()
    return {"status": test.status.value, "version": test.version}

@app.get("/api/tests/{test_id}/batches/active")
def active_batch_times(test_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.LECTURER, Role.ADMIN, Role.INSTITUTION_ADMIN))):
    test = db.get(Test, test_id)
    if not test or (user.role == Role.INSTITUTION_ADMIN and test.institution_id != user.institution_id) or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id): raise HTTPException(404, "TEST not found")
    now = now_utc()
    active = db.scalars(select(TestSession).where(TestSession.test_id == test_id, TestSession.status == SessionStatus.IN_PROGRESS)).all()
    return [{"session_id": s.id, "student_id": s.student_id, "batch_id": s.batch_id, "expires_at": as_utc(s.expires_at).isoformat(), "remaining_seconds": max(0, int((as_utc(s.expires_at)-now).total_seconds()))} for s in active]

@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "app_name": settings.app_name})

@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request): return templates.TemplateResponse("login.html", {"request": request})

@app.get("/dashboard", response_class=HTMLResponse)
def dashboard_page(request: Request): return templates.TemplateResponse("dashboard.html", {"request": request})

@app.get("/institution-admin", response_class=HTMLResponse)
def institution_admin_page(request: Request): return templates.TemplateResponse("institution.html", {"request": request})

@app.get("/student", response_class=HTMLResponse)
def student_page(request: Request): return templates.TemplateResponse("student.html", {"request": request})

@app.get("/register", response_class=HTMLResponse)
def register_page(request: Request): return templates.TemplateResponse("register.html", {"request": request})
