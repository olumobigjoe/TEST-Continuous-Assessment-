"""Create the first lecturer or administrator account interactively."""
import getpass
from sqlalchemy import select
from app.database import Base, engine, SessionLocal
from app.models import User, Role
from app.security import hash_password

Base.metadata.create_all(bind=engine)
name = input("Full name: ").strip()
email = input("Email: ").strip().lower()
role_value = input("Role [lecturer/admin] (default lecturer): ").strip().lower() or "lecturer"
if role_value not in {"lecturer", "admin"}:
    raise SystemExit("Role must be lecturer or admin")
password = getpass.getpass("Password (minimum 10 characters): ")
if len(password) < 10:
    raise SystemExit("Password must contain at least 10 characters")
with SessionLocal() as db:
    if db.scalar(select(User).where(User.email == email)):
        raise SystemExit("That email already exists")
    user = User(full_name=name, email=email, password_hash=hash_password(password), role=Role(role_value))
    db.add(user)
    db.commit()
    print(f"Created {role_value} account for {email}")
