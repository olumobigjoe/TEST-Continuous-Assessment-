"""Version 2 institution administration, roster import and reporting API."""
import csv
import io
import re
import secrets
import hashlib
from datetime import timedelta
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.orm import Session
from app.database import get_db
from app.dependencies import require_roles
from app.models import (User, Role, Institution, Department, InstitutionSubscription,
                        Test, TestSession, TestResult, BatchStudent, Batch, StudentInvitation)
from app.security import hash_password

router = APIRouter(prefix="/api/v2", tags=["V2 Institution & Reporting"])

class InstitutionCreate(BaseModel):
    name: str = Field(min_length=3, max_length=180)
    code: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    email_domain: str | None = Field(default=None, max_length=180)

class DepartmentCreate(BaseModel):
    name: str = Field(min_length=2, max_length=140)
    code: str | None = Field(default=None, max_length=32)

class InstitutionUserCreate(BaseModel):
    full_name: str = Field(min_length=2, max_length=160)
    email: str = Field(min_length=5, max_length=255)
    password: str = Field(min_length=10, max_length=128)
    role: str = Field(pattern=r"^(institution_admin|lecturer)$")

class DepartmentAssignment(BaseModel):
    department_id: int | None = None

class InvitationAccept(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    password: str = Field(min_length=10, max_length=128)

class SubscriptionUpdate(BaseModel):
    plan: str = Field(pattern=r"^(starter|department|institution|enterprise)$")
    status: str = Field(pattern=r"^(trial|active|past_due|suspended|cancelled)$")
    seat_limit: int = Field(ge=1, le=100000)


def tenant_required(user: User):
    if not user.institution_id:
        raise HTTPException(409, "Your account is not linked to an institution. Ask an administrator to configure your institution first.")
    return user.institution_id


def owned_test(db: Session, test_id: int, user: User):
    test = db.get(Test, test_id)
    if not test or (user.role not in (Role.ADMIN, Role.INSTITUTION_ADMIN) and test.lecturer_id != user.id):
        raise HTTPException(404, "TEST not found")
    if user.role != Role.ADMIN and test.institution_id != user.institution_id:
        raise HTTPException(404, "TEST not found")
    return test

@router.post("/institutions", status_code=201)
def create_institution(payload: InstitutionCreate, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.ADMIN))):
    code = payload.code.strip().upper()
    if db.scalar(select(Institution).where((Institution.code == code) | (Institution.name == payload.name.strip()))):
        raise HTTPException(409, "An institution with this name or code already exists")
    institution = Institution(name=payload.name.strip(), code=code, email_domain=(payload.email_domain or None))
    db.add(institution); db.flush()
    db.add(InstitutionSubscription(institution_id=institution.id))
    if user.institution_id is None:
        user.institution_id = institution.id
    db.commit(); db.refresh(institution)
    return {"id": institution.id, "name": institution.name, "code": institution.code}

@router.post("/institutions/{institution_id}/users", status_code=201)
def provision_institution_user(institution_id: int, payload: InstitutionUserCreate, db: Session = Depends(get_db), actor: User = Depends(require_roles(Role.ADMIN))):
    institution = db.get(Institution, institution_id)
    if not institution or not institution.is_active:
        raise HTTPException(404, "Institution not found")
    email = payload.email.strip().lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "Email is already registered")
    account = User(full_name=payload.full_name.strip(), email=email, password_hash=hash_password(payload.password), role=Role(payload.role), institution_id=institution_id)
    db.add(account); db.commit(); db.refresh(account)
    return {"id": account.id, "full_name": account.full_name, "email": account.email, "role": account.role.value, "institution_id": institution_id}

@router.get("/institution")
def institution_profile(db: Session = Depends(get_db), user: User = Depends(require_roles(Role.ADMIN, Role.INSTITUTION_ADMIN, Role.LECTURER, Role.STUDENT))):
    iid = tenant_required(user)
    institution = db.get(Institution, iid)
    if not institution or not institution.is_active:
        raise HTTPException(404, "Institution not found or inactive")
    counts = {
        "students": db.scalar(select(func.count(User.id)).where(User.institution_id == iid, User.role == Role.STUDENT)) or 0,
        "lecturers": db.scalar(select(func.count(User.id)).where(User.institution_id == iid, User.role == Role.LECTURER)) or 0,
        "departments": db.scalar(select(func.count(Department.id)).where(Department.institution_id == iid)) or 0,
        "tests": db.scalar(select(func.count(Test.id)).where(Test.institution_id == iid)) or 0,
    }
    return {"id": institution.id, "name": institution.name, "code": institution.code, "counts": counts}

@router.post("/departments", status_code=201)
def create_department(payload: DepartmentCreate, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.ADMIN, Role.INSTITUTION_ADMIN, Role.LECTURER))):
    iid = tenant_required(user)
    name = payload.name.strip()
    if db.scalar(select(Department).where(Department.institution_id == iid, Department.name == name)):
        raise HTTPException(409, "Department already exists")
    row = Department(institution_id=iid, name=name, code=(payload.code or None))
    db.add(row); db.commit(); db.refresh(row)
    return {"id": row.id, "name": row.name, "code": row.code}

@router.get("/departments")
def list_departments(db: Session = Depends(get_db), user: User = Depends(require_roles(Role.ADMIN, Role.INSTITUTION_ADMIN, Role.LECTURER, Role.STUDENT))):
    iid = tenant_required(user)
    rows = db.scalars(select(Department).where(Department.institution_id == iid, Department.is_active.is_(True)).order_by(Department.name)).all()
    return [{"id": d.id, "name": d.name, "code": d.code} for d in rows]

@router.patch("/users/{user_id}/department")
def set_user_department(user_id: int, payload: DepartmentAssignment, db: Session = Depends(get_db), actor: User = Depends(require_roles(Role.ADMIN, Role.INSTITUTION_ADMIN))):
    iid = tenant_required(actor)
    target = db.get(User, user_id)
    if not target or target.institution_id != iid:
        raise HTTPException(404, "Institution user not found")
    if payload.department_id is not None:
        department = db.get(Department, payload.department_id)
        if not department or department.institution_id != iid:
            raise HTTPException(422, "Department does not belong to your institution")
    target.department_id = payload.department_id
    db.commit()
    return {"user_id": target.id, "department_id": target.department_id}

@router.post("/students/import")
async def import_students(file: UploadFile = File(...), db: Session = Depends(get_db), actor: User = Depends(require_roles(Role.ADMIN, Role.INSTITUTION_ADMIN, Role.LECTURER))):
    iid = tenant_required(actor)
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(415, "Upload a CSV file")
    raw = await file.read(2_000_001)
    if len(raw) > 2_000_000:
        raise HTTPException(413, "CSV file must be 2 MB or smaller")
    try:
        text = raw.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text))
    except (UnicodeDecodeError, csv.Error):
        raise HTTPException(422, "CSV must be valid UTF-8")
    required = {"full_name", "email", "matric_number"}
    if not reader.fieldnames or not required.issubset({h.strip().lower() for h in reader.fieldnames}):
        raise HTTPException(422, "CSV headers must include full_name,email,matric_number")
    sub = db.scalar(select(InstitutionSubscription).where(InstitutionSubscription.institution_id == iid))
    current_students = db.scalar(select(func.count(User.id)).where(User.institution_id == iid, User.role == Role.STUDENT)) or 0
    if sub and sub.status in {"suspended", "cancelled"}:
        raise HTTPException(403, "Institution subscription is not active")
    created, skipped, errors, invitations = [], [], [], []
    for line, row in enumerate(reader, start=2):
        row = {str(k).strip().lower(): (v or "").strip() for k, v in row.items() if k}
        name, email, matric = row.get("full_name", ""), row.get("email", "").lower(), row.get("matric_number", "")
        if not name or "@" not in email or not matric:
            errors.append({"line": line, "error": "full_name, valid email and matric_number are required"}); continue
        if db.scalar(select(User).where((User.email == email) | (User.matric_number == matric))):
            skipped.append({"line": line, "email": email, "reason": "Email or matric number already exists"}); continue
        # Imported accounts receive a random initial password; administrator must issue a secure reset/invitation before use.
        if sub and current_students + len(created) >= sub.seat_limit:
            errors.append({"line": line, "error": "Institution student seat limit reached"}); continue
        temp_password = secrets.token_urlsafe(32)
        student = User(full_name=name[:160], email=email, matric_number=matric[:80], password_hash=hash_password(temp_password), role=Role.STUDENT, institution_id=iid, password_setup_required=True)
        db.add(student); db.flush()
        raw_token = secrets.token_urlsafe(36)
        token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
        expiry = datetime.now(timezone.utc) + timedelta(hours=72)
        db.add(StudentInvitation(user_id=student.id, token_hash=token_hash, expires_at=expiry))
        created.append({"line": line, "email": email, "matric_number": matric})
        invitations.append({"email": email, "setup_token": raw_token, "expires_at": expiry.isoformat()})
    db.commit()
    return {"created_count": len(created), "skipped_count": len(skipped), "error_count": len(errors), "created": created, "skipped": skipped, "errors": errors, "invitations": invitations,
            "next_step": "Share each one-time setup token securely with its student. Tokens expire after 72 hours."}

@router.post("/auth/accept-invitation")
def accept_student_invitation(payload: InvitationAccept, db: Session = Depends(get_db)):
    token_hash = hashlib.sha256(payload.token.encode()).hexdigest()
    invitation = db.scalar(select(StudentInvitation).where(StudentInvitation.token_hash == token_hash))
    now = datetime.now(timezone.utc)
    if not invitation or invitation.used_at is not None or invitation.expires_at.replace(tzinfo=timezone.utc) <= now:
        raise HTTPException(400, "Invitation token is invalid, expired or already used")
    student = db.get(User, invitation.user_id)
    if not student or student.role != Role.STUDENT or not student.is_active:
        raise HTTPException(400, "Student account is unavailable")
    student.password_hash = hash_password(payload.password)
    student.password_setup_required = False
    invitation.used_at = now
    db.commit()
    return {"message": "Student account password configured. You can now sign in."}

@router.get("/tests/{test_id}/results.csv")
def export_test_results(test_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.ADMIN, Role.INSTITUTION_ADMIN, Role.LECTURER))):
    test = owned_test(db, test_id, user)
    rows = db.execute(select(User.full_name, User.email, User.matric_number, TestResult.score, TestResult.total_marks, TestResult.percentage, TestSession.submitted_at)
        .join(TestSession, TestSession.student_id == User.id).join(TestResult, TestResult.session_id == TestSession.id)
        .where(TestSession.test_id == test.id).order_by(User.full_name)).all()
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["TEST", "Student Name", "Email", "Matric Number", "Score", "Total Marks", "Percentage", "Submitted At"])
    for row in rows:
        writer.writerow([test.title, *row])
    stream.seek(0)
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", test.title).strip("_") or f"test_{test.id}"
    return StreamingResponse(iter([stream.getvalue()]), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{safe}_results.csv"'})

@router.get("/subscription")
def get_subscription(db: Session = Depends(get_db), user: User = Depends(require_roles(Role.ADMIN, Role.INSTITUTION_ADMIN, Role.LECTURER))):
    iid = tenant_required(user)
    sub = db.scalar(select(InstitutionSubscription).where(InstitutionSubscription.institution_id == iid))
    if not sub:
        raise HTTPException(404, "Subscription record not found")
    return {"plan": sub.plan, "status": sub.status, "seat_limit": sub.seat_limit, "starts_at": sub.starts_at.isoformat(), "ends_at": sub.ends_at.isoformat() if sub.ends_at else None,
            "billing_integration": "Not connected; payment provider integration is a future deployment step"}

@router.patch("/subscription")
def update_subscription(payload: SubscriptionUpdate, db: Session = Depends(get_db), user: User = Depends(require_roles(Role.ADMIN))):
    iid = tenant_required(user)
    sub = db.scalar(select(InstitutionSubscription).where(InstitutionSubscription.institution_id == iid))
    if not sub:
        raise HTTPException(404, "Subscription record not found")
    sub.plan, sub.status, sub.seat_limit = payload.plan, payload.status, payload.seat_limit
    sub.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"plan": sub.plan, "status": sub.status, "seat_limit": sub.seat_limit, "note": "Administrative subscription metadata only; no payment has been charged."}
