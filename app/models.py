import enum
from datetime import datetime, timezone
from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String, Text, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base

def utcnow():
    return datetime.now(timezone.utc)

class Role(str, enum.Enum):
    ADMIN = "admin"
    LECTURER = "lecturer"
    STUDENT = "student"

class TestStatus(str, enum.Enum):
    DRAFT = "draft"
    PUBLISHED = "published"
    SCHEDULED = "scheduled"
    ACTIVE = "active"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    POSTPONED = "postponed"

class BatchStatus(str, enum.Enum):
    SCHEDULED = "scheduled"
    ACTIVE = "active"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    LOCKED = "locked"

class SessionStatus(str, enum.Enum):
    IN_PROGRESS = "in_progress"
    SUBMITTED = "submitted"
    EXPIRED = "expired"

class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    full_name: Mapped[str] = mapped_column(String(160))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[Role] = mapped_column(Enum(Role), default=Role.STUDENT)
    matric_number: Mapped[str | None] = mapped_column(String(80), unique=True, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

class Test(Base):
    __tablename__ = "tests"
    id: Mapped[int] = mapped_column(primary_key=True)
    lecturer_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    course_code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    instructions: Mapped[str | None] = mapped_column(Text, nullable=True)
    scheduled_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    scheduled_end: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_minutes: Mapped[int] = mapped_column(Integer)
    number_of_batches: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[TestStatus] = mapped_column(Enum(TestStatus), default=TestStatus.DRAFT, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    questions: Mapped[list["Question"]] = relationship(back_populates="test", cascade="all, delete-orphan")
    batches: Mapped[list["Batch"]] = relationship(back_populates="test", cascade="all, delete-orphan")

class Question(Base):
    __tablename__ = "test_questions"
    id: Mapped[int] = mapped_column(primary_key=True)
    test_id: Mapped[int] = mapped_column(ForeignKey("tests.id", ondelete="CASCADE"), index=True)
    prompt: Mapped[str] = mapped_column(Text)
    option_a: Mapped[str] = mapped_column(Text)
    option_b: Mapped[str] = mapped_column(Text)
    option_c: Mapped[str] = mapped_column(Text)
    option_d: Mapped[str] = mapped_column(Text)
    correct_option: Mapped[str] = mapped_column(String(1))
    marks: Mapped[int] = mapped_column(Integer, default=1)
    test: Mapped[Test] = relationship(back_populates="questions")

class Batch(Base):
    __tablename__ = "test_batches"
    id: Mapped[int] = mapped_column(primary_key=True)
    test_id: Mapped[int] = mapped_column(ForeignKey("tests.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duration_minutes: Mapped[int] = mapped_column(Integer)
    status: Mapped[BatchStatus] = mapped_column(Enum(BatchStatus), default=BatchStatus.SCHEDULED)
    is_locked: Mapped[bool] = mapped_column(Boolean, default=False)
    test: Mapped[Test] = relationship(back_populates="batches")

class BatchStudent(Base):
    __tablename__ = "batch_students"
    __table_args__ = (UniqueConstraint("batch_id", "student_id", name="uq_batch_student"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("test_batches.id", ondelete="CASCADE"), index=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)

class TestSession(Base):
    __tablename__ = "test_sessions"
    __table_args__ = (UniqueConstraint("test_id", "student_id", name="uq_test_student_session"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    test_id: Mapped[int] = mapped_column(ForeignKey("tests.id"), index=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("test_batches.id"), index=True)
    student_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    test_version: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    allocated_minutes: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[SessionStatus] = mapped_column(Enum(SessionStatus), default=SessionStatus.IN_PROGRESS)

class TestSessionQuestion(Base):
    __tablename__ = "test_session_questions"
    __table_args__ = (UniqueConstraint("session_id", "question_id", name="uq_session_question_order"), UniqueConstraint("session_id", "order_index", name="uq_session_question_position"))
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("test_sessions.id", ondelete="CASCADE"), index=True)
    question_id: Mapped[int] = mapped_column(ForeignKey("test_questions.id"))
    order_index: Mapped[int] = mapped_column(Integer)

class TestResponse(Base):
    __tablename__ = "test_responses"
    __table_args__ = (UniqueConstraint("session_id", "question_id", name="uq_session_question"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("test_sessions.id", ondelete="CASCADE"), index=True)
    question_id: Mapped[int] = mapped_column(ForeignKey("test_questions.id"))
    selected_option: Mapped[str] = mapped_column(String(1))
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

class TestResult(Base):
    __tablename__ = "test_results"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("test_sessions.id"), unique=True)
    score: Mapped[int] = mapped_column(Integer, default=0)
    total_marks: Mapped[int] = mapped_column(Integer, default=0)
    percentage: Mapped[int] = mapped_column(Integer, default=0)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

class ScheduleAuditLog(Base):
    __tablename__ = "test_schedule_audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    test_id: Mapped[int] = mapped_column(ForeignKey("tests.id"), index=True)
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("test_batches.id"), nullable=True)
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(60))
    old_schedule: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_schedule: Mapped[str | None] = mapped_column(Text, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

Index("ix_sessions_student_status", TestSession.student_id, TestSession.status)
