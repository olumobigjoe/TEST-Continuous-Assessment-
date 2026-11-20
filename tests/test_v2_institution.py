import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.database import Base, get_db
from app.main import app
from app.models import User, Role
from app.security import hash_password


def test_institution_onboarding_departments_and_student_invitation():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    def override_db():
        db = Session()
        try: yield db
        finally: db.close()
    app.dependency_overrides[get_db] = override_db
    try:
        with Session() as db:
            db.add(User(full_name="Platform Admin", email="platform@example.com", password_hash=hash_password("PlatformPass123!"), role=Role.ADMIN))
            db.commit()
        with TestClient(app) as client:
            assert client.post("/api/auth/login", json={"email":"platform@example.com", "password":"PlatformPass123!"}).status_code == 200
            inst = client.post("/api/v2/institutions", json={"name":"Example College", "code":"EXCOL"})
            assert inst.status_code == 201, inst.text
            iid = inst.json()["id"]
            provision = client.post(f"/api/v2/institutions/{iid}/users", json={"full_name":"College Admin", "email":"college-admin@example.com", "password":"CollegePass123!", "role":"institution_admin"})
            assert provision.status_code == 201, provision.text
            client.post("/api/auth/logout")
            assert client.post("/api/auth/login", json={"email":"college-admin@example.com", "password":"CollegePass123!"}).status_code == 200
            dept = client.post("/api/v2/departments", json={"name":"Biochemistry", "code":"BCH"})
            assert dept.status_code == 201, dept.text
            profile = client.get("/api/v2/institution")
            assert profile.status_code == 200 and profile.json()["counts"]["departments"] == 1
            csv_data = "full_name,email,matric_number\nTest Student,student-v2@example.com,EX-001\n"
            imported = client.post("/api/v2/students/import", files={"file":("students.csv", csv_data, "text/csv")})
            assert imported.status_code == 200, imported.text
            payload = imported.json()
            assert payload["created_count"] == 1 and len(payload["invitations"]) == 1
            invite = payload["invitations"][0]["setup_token"]
            accepted = client.post("/api/v2/auth/accept-invitation", json={"token":invite, "password":"StudentNewPass123!"})
            assert accepted.status_code == 200, accepted.text
            assert client.post("/api/v2/auth/accept-invitation", json={"token":invite, "password":"AnotherPass123!"}).status_code == 400
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()
