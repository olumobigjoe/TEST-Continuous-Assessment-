from datetime import datetime, timezone, timedelta
import random
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from fastapi import HTTPException
from app.models import Test, Batch, BatchStudent, TestSession, TestResponse, TestResult, TestStatus, BatchStatus, SessionStatus, Question, TestSessionQuestion
from app.services.scheduling import as_utc

def now_utc():
    return datetime.now(timezone.utc)

def finalize_session(db: Session, session: TestSession, expired: bool = False):
    if session.status != SessionStatus.IN_PROGRESS:
        result = db.scalar(select(TestResult).where(TestResult.session_id == session.id))
        return result
    session_questions = list(db.scalars(select(TestSessionQuestion).where(TestSessionQuestion.session_id == session.id)))
    question_ids = [sq.question_id for sq in session_questions] if session_questions else None
    questions = list(db.scalars(select(Question).where(Question.id.in_(question_ids)))) if question_ids else list(db.scalars(select(Question).where(Question.test_id == session.test_id)))
    responses = {r.question_id: r.selected_option for r in db.scalars(select(TestResponse).where(TestResponse.session_id == session.id))}
    total = sum(q.marks for q in questions)
    score = sum(q.marks for q in questions if responses.get(q.id) == q.correct_option)
    submitted = now_utc()
    session.status = SessionStatus.EXPIRED if expired else SessionStatus.SUBMITTED
    session.submitted_at = submitted
    result = TestResult(session_id=session.id, score=score, total_marks=total, percentage=round(score * 100 / total) if total else 0, submitted_at=submitted)
    db.add(result)
    batch = db.get(Batch, session.batch_id)
    if batch:
        assigned_count = db.scalar(select(func.count(BatchStudent.id)).where(BatchStudent.batch_id == batch.id)) or 0
        pending_count = db.scalar(select(func.count(BatchStudent.id)).where(BatchStudent.batch_id == batch.id, ~BatchStudent.student_id.in_(select(TestSession.student_id).where(TestSession.batch_id == batch.id)))) or 0
        active_count = db.scalar(select(TestSession.id).where(TestSession.batch_id == batch.id, TestSession.status == SessionStatus.IN_PROGRESS).limit(1))
        if assigned_count > 0 and pending_count == 0 and active_count is None:
            batch.status = BatchStatus.COMPLETED
    if batch and batch.status == BatchStatus.COMPLETED:
        test = db.get(Test, session.test_id)
        if test and all(b.status in (BatchStatus.COMPLETED, BatchStatus.CANCELLED) for b in test.batches):
            test.status = TestStatus.COMPLETED
    db.commit()
    db.refresh(result)
    return result

def require_live_session(db: Session, session_id: int, student_id: int):
    session = db.scalar(select(TestSession).where(TestSession.id == session_id).with_for_update())
    if not session or session.student_id != student_id:
        raise HTTPException(404, "TEST session not found")
    if session.status != SessionStatus.IN_PROGRESS:
        raise HTTPException(409, "This TEST session has already ended")
    if now_utc() >= as_utc(session.expires_at):
        finalize_session(db, session, expired=True)
        raise HTTPException(410, "TEST time has expired; your answers have been submitted")
    return session

def start_session(db: Session, test_id: int, student_id: int):
    test = db.scalar(select(Test).where(Test.id == test_id).with_for_update())
    if not test or test.status not in (TestStatus.PUBLISHED, TestStatus.SCHEDULED, TestStatus.ACTIVE):
        raise HTTPException(404, "TEST is not available")
    assigned = db.scalar(select(BatchStudent).join(Batch).where(Batch.test_id == test_id, BatchStudent.student_id == student_id))
    if not assigned:
        raise HTTPException(403, "You are not assigned to a TEST batch")
    batch = db.scalar(select(Batch).where(Batch.id == assigned.batch_id).with_for_update())
    if batch.is_locked or batch.status not in (BatchStatus.SCHEDULED, BatchStatus.ACTIVE):
        raise HTTPException(423, "This TEST batch is locked or no longer available")
    now = now_utc()
    if now < as_utc(batch.starts_at) or now > as_utc(batch.ends_at):
        raise HTTPException(403, "This TEST is outside your assigned batch access window")
    existing = db.scalar(select(TestSession).where(TestSession.test_id == test_id, TestSession.student_id == student_id))
    if existing:
        if existing.status == SessionStatus.IN_PROGRESS and now < as_utc(existing.expires_at):
            return existing
        raise HTTPException(409, "You have already used your attempt for this TEST")
    session = TestSession(test_id=test.id, batch_id=batch.id, student_id=student_id, test_version=test.version, started_at=now, allocated_minutes=batch.duration_minutes, expires_at=now + timedelta(minutes=batch.duration_minutes), status=SessionStatus.IN_PROGRESS)
    batch.status = BatchStatus.ACTIVE
    test.status = TestStatus.ACTIVE
    db.add(session)
    db.flush()
    question_ids = list(db.scalars(select(Question.id).where(Question.test_id == test.id)))
    random.shuffle(question_ids)
    db.add_all([TestSessionQuestion(session_id=session.id, question_id=qid, order_index=index) for index, qid in enumerate(question_ids)])
    db.commit()
    db.refresh(session)
    return session
