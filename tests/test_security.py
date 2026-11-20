from app.security import hash_password, verify_password, create_access_token, decode_access_token

def test_password_hash_round_trip():
    stored = hash_password("a-strong-example-password")
    assert stored != "a-strong-example-password"
    assert verify_password("a-strong-example-password", stored)
    assert not verify_password("wrong-password", stored)

def test_signed_token_round_trip_and_tamper_rejection():
    token = create_access_token("42")
    assert decode_access_token(token) == "42"
    header, payload, signature = token.split(".")
    assert decode_access_token(f"{header}.{payload}x.{signature}") is None
