from datetime import datetime, timedelta, timezone
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.database import Base
from app.models import User, Role, Test as TestModel, Batch, BatchStatus, TestStatus
from app.services.scheduling import update_test_schedule, update_batch_schedule

TestModel.__test__ = False
TestStatus.__test__ = False

@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    session = Session()
    yield session
    session.close()
    Base.metadata.drop_all(engine)

def setup_test(db):
    now = datetime.now(timezone.utc)
    lecturer = User(full_name="Lecturer", email="lecturer@example.com", password_hash="x", role=Role.LECTURER)
    db.add(lecturer); db.flush()
    test = TestModel(lecturer_id=lecturer.id, title="Sample TEST", scheduled_start=now, scheduled_end=now+timedelta(hours=2), duration_minutes=30, number_of_batches=2, status=TestStatus.ACTIVE)
    db.add(test); db.flush()
    active = Batch(test_id=test.id, name="Batch 1", starts_at=now, ends_at=now+timedelta(minutes=30), duration_minutes=30, status=BatchStatus.ACTIVE)
    future = Batch(test_id=test.id, name="Batch 2", starts_at=now+timedelta(hours=1), ends_at=now+timedelta(hours=1, minutes=30), duration_minutes=30, status=BatchStatus.SCHEDULED)
    db.add_all([active, future]); db.commit(); db.refresh(test)
    return lecturer, test, active, future

def test_global_schedule_does_not_change_active_batch(db):
    lecturer, test, active, future = setup_test(db)
    original_active_start = active.starts_at
    new_start = test.scheduled_start + timedelta(days=1)
    update_test_schedule(db, test, lecturer.id, new_start, new_start+timedelta(hours=3), 45, "Reschedule future batch")
    db.refresh(active); db.refresh(future)
    assert active.starts_at.replace(tzinfo=timezone.utc) == original_active_start
    assert future.duration_minutes == 45
    assert future.starts_at.replace(tzinfo=timezone.utc) > original_active_start

def test_active_batch_cannot_be_rescheduled(db):
    lecturer, test, active, future = setup_test(db)
    with pytest.raises(HTTPException) as err:
        update_batch_schedule(db, test, active, lecturer.id, active.starts_at+timedelta(days=1), active.ends_at+timedelta(days=1), 45, None)
    assert err.value.status_code == 409

def test_upcoming_batch_can_be_rescheduled(db):
    lecturer, test, active, future = setup_test(db)
    new_start = future.starts_at + timedelta(days=1)
    update_batch_schedule(db, test, future, lecturer.id, new_start, new_start+timedelta(minutes=40), 40, "Room conflict")
    db.refresh(future)
    assert future.starts_at.replace(tzinfo=timezone.utc) == new_start
    assert future.duration_minutes == 40
