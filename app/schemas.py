from datetime import datetime
from pydantic import BaseModel, EmailStr, Field, ConfigDict, field_validator
from app.models import Role

class RegisterIn(BaseModel):
    full_name: str = Field(min_length=2, max_length=160)
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    role: Role = Role.STUDENT
    matric_number: str | None = None

class LoginIn(BaseModel):
    email: EmailStr
    password: str

class QuestionIn(BaseModel):
    prompt: str = Field(min_length=5)
    option_a: str
    option_b: str
    option_c: str
    option_d: str
    correct_option: str = Field(pattern="^[ABCD]$")
    marks: int = Field(default=1, ge=1, le=100)

class TestCreateIn(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    course_code: str | None = None
    instructions: str | None = None
    scheduled_start: datetime
    scheduled_end: datetime
    duration_minutes: int = Field(ge=1, le=600)
    number_of_batches: int = Field(default=1, ge=1, le=100)
    questions: list[QuestionIn] = []

    @field_validator("scheduled_start", "scheduled_end")
    @classmethod
    def require_timezone(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Provide a timezone-aware date and time")
        return value

class ScheduleUpdateIn(BaseModel):
    scheduled_start: datetime
    scheduled_end: datetime
    duration_minutes: int = Field(ge=1, le=600)
    reason: str | None = None

    @field_validator("scheduled_start", "scheduled_end")
    @classmethod
    def require_timezone(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Provide a timezone-aware date and time")
        return value

class BatchScheduleUpdateIn(BaseModel):
    starts_at: datetime
    ends_at: datetime
    duration_minutes: int = Field(ge=1, le=600)
    reason: str | None = None

    @field_validator("starts_at", "ends_at")
    @classmethod
    def require_timezone(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Provide a timezone-aware date and time")
        return value

class BatchAssignIn(BaseModel):
    student_ids: list[int]

class AnswerIn(BaseModel):
    question_id: int
    selected_option: str = Field(pattern="^[ABCD]$")
