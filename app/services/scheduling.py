import json
from datetime import datetime, timezone, timedelta
from sqlalchemy import select
from sqlalchemy.orm import Session
from fastapi import HTTPException
from app.models import Test, Batch, BatchStatus, TestStatus, ScheduleAuditLog, TestSession, SessionStatus

def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)

def schedule_dict(start, end, duration):
    return {"start": as_utc(start).isoformat(), "end": as_utc(end).isoformat(), "duration_minutes": duration}

def update_test_schedule(db: Session, test: Test, actor_id: int, start: datetime, end: datetime, duration: int, reason: str | None):
    start, end = as_utc(start), as_utc(end)
    if end <= start or duration <= 0:
        raise HTTPException(422, "TEST end time must be after its start time and duration must be positive")
    if test.status in (TestStatus.COMPLETED, TestStatus.CANCELLED):
        raise HTTPException(409, "A completed or cancelled TEST cannot be rescheduled")
    old_start = as_utc(test.scheduled_start)
    old = schedule_dict(test.scheduled_start, test.scheduled_end, test.duration_minutes)
    delta = start - old_start
    # Only scheduled batches are changed. Active/completed batches remain immutable.
    for batch in test.batches:
        if batch.status == BatchStatus.SCHEDULED:
            batch.starts_at = as_utc(batch.starts_at) + delta
            batch.duration_minutes = duration
            batch.ends_at = batch.starts_at + timedelta(minutes=duration)
    test.scheduled_start, test.scheduled_end = start, end
    test.duration_minutes = duration
    test.version += 1
    db.add(ScheduleAuditLog(test_id=test.id, actor_id=actor_id, action="test_schedule_updated", old_schedule=json.dumps(old), new_schedule=json.dumps(schedule_dict(start, end, duration)), reason=reason))
    db.commit()
    db.refresh(test)
    return test

def update_batch_schedule(db: Session, test: Test, batch: Batch, actor_id: int, start: datetime, end: datetime, duration: int, reason: str | None):
    start, end = as_utc(start), as_utc(end)
    if batch.test_id != test.id:
        raise HTTPException(404, "Batch not found")
    if batch.status != BatchStatus.SCHEDULED or batch.is_locked:
        raise HTTPException(409, "Only unlocked batches that have not started can be rescheduled")
    if end <= start or duration <= 0:
        raise HTTPException(422, "Batch end time must be after its start time")
    old = schedule_dict(batch.starts_at, batch.ends_at, batch.duration_minutes)
    batch.starts_at, batch.ends_at, batch.duration_minutes = start, end, duration
    db.add(ScheduleAuditLog(test_id=test.id, batch_id=batch.id, actor_id=actor_id, action="batch_schedule_updated", old_schedule=json.dumps(old), new_schedule=json.dumps(schedule_dict(start, end, duration)), reason=reason))
    db.commit()
    db.refresh(batch)
    return batch
