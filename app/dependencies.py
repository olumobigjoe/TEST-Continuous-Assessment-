from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, Role
from app.security import decode_access_token

def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get("test_access") or request.headers.get("Authorization", "").removeprefix("Bearer ")
    user_id = decode_access_token(token) if token else None
    user = db.get(User, int(user_id)) if user_id and user_id.isdigit() else None
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Please sign in to continue")
    return user

def require_roles(*roles: Role):
    def checker(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="You do not have permission to perform this action")
        return user
    return checker
