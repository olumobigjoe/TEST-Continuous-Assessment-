"""Password hashing and compact HS256 JWT helpers using Python's standard library."""
import base64
import hashlib
import hmac
import json
import secrets
import time
from app.config import settings

PBKDF2_ITERATIONS = 600_000

def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${_b64encode(salt)}${_b64encode(digest)}"

def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt_text, digest_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        expected = _b64decode(digest_text)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), _b64decode(salt_text), int(iterations))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False

def create_access_token(subject: str) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"sub": subject, "exp": int(time.time()) + settings.access_token_expire_minutes * 60}
    signing_input = f"{_b64encode(json.dumps(header, separators=(',', ':')).encode())}.{_b64encode(json.dumps(payload, separators=(',', ':')).encode())}"
    signature = hmac.new(settings.secret_key.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64encode(signature)}"

def decode_access_token(token: str) -> str | None:
    try:
        header_part, payload_part, signature_part = token.split(".")
        header = json.loads(_b64decode(header_part))
        if header.get("alg") != "HS256":
            return None
        signing_input = f"{header_part}.{payload_part}"
        expected = hmac.new(settings.secret_key.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64decode(signature_part)):
            return None
        payload = json.loads(_b64decode(payload_part))
        if int(payload.get("exp", 0)) <= int(time.time()):
            return None
        subject = payload.get("sub")
        return str(subject) if subject is not None else None
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        return None
