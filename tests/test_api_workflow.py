from datetime import datetime, timedelta, timezone
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.database import Base, get_db
from app.main import app
from app.models import User, Role
from app.security import hash_password


def test_complete_student_attempt_and_server_session_snapshot():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)

    def override_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    try:
        with Session() as db:
            db.add(User(full_name="API Lecturer", email="api-lecturer@example.com", password_hash=hash_password("LecturerPass123!"), role=Role.LECTURER))
            db.commit()

        with TestClient(app) as client:
            response = client.post("/api/auth/login", json={"email": "api-lecturer@example.com", "password": "LecturerPass123!"})
            assert response.status_code == 200
            start = datetime.now(timezone.utc) - timedelta(minutes=1)
            end = datetime.now(timezone.utc) + timedelta(hours=1)
            response = client.post("/api/tests", json={
                "title": "Workflow TEST", "course_code": "TST 101",
                "scheduled_start": start.isoformat(), "scheduled_end": end.isoformat(),
                "duration_minutes": 15, "number_of_batches": 1,
                "questions": [{"prompt": "What is 2 + 2?", "option_a": "3", "option_b": "4", "option_c": "5", "option_d": "6", "correct_option": "B", "marks": 2}],
            })
            assert response.status_code == 201, response.text
            test_id = response.json()["id"]

            response = client.post("/api/auth/register", json={"full_name": "API Student", "email": "api-student@example.com", "password": "StudentPass123!", "role": "student", "matric_number": "API-001"})
            assert response.status_code == 201, response.text
            student_id = response.json()["id"]
            batch_id = client.get("/api/tests").json()[0]["batches"][0]["id"]
            assert client.post(f"/api/tests/{test_id}/batches/{batch_id}/assign", json={"student_ids": [student_id]}).status_code == 200
            assert client.post(f"/api/tests/{test_id}/publish").status_code == 200

            client.post("/api/auth/logout")
            assert client.post("/api/auth/login", json={"email": "api-student@example.com", "password": "StudentPass123!"}).status_code == 200
            response = client.post(f"/api/student/tests/{test_id}/start")
            assert response.status_code == 200, response.text
            session_id = response.json()["session_id"]
            original_expiry = response.json()["expires_at"]
            detail = client.get(f"/api/student/sessions/{session_id}").json()
            question_id = detail["questions"][0]["id"]
            assert detail["server_time"]
            assert client.post(f"/api/student/sessions/{session_id}/answer", json={"question_id": question_id, "selected_option": "B"}).status_code == 200
            result = client.post(f"/api/student/sessions/{session_id}/submit")
            assert result.status_code == 200, result.text
            assert result.json()["score"] == 2
            assert result.json()["percentage"] == 100
            assert original_expiry
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()
