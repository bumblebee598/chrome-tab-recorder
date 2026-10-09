import base64
import json
import time

import jwt
from cryptography.fernet import Fernet

SESSION_TTL_SECONDS = 30 * 24 * 3600


def issue_session_token(sub: str, email: str, secret: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "email": email, "iat": now, "exp": now + SESSION_TTL_SECONDS},
        secret,
        algorithm="HS256",
    )


def verify_session_token(token: str, secret: str) -> dict:
    """Raises jwt.PyJWTError on anything invalid/expired."""
    return jwt.decode(token, secret, algorithms=["HS256"])


def encrypt_refresh_token(token: str, fernet_key: str) -> str:
    return Fernet(fernet_key.encode()).encrypt(token.encode()).decode()


def decrypt_refresh_token(ciphertext: str, fernet_key: str) -> str:
    return Fernet(fernet_key.encode()).decrypt(ciphertext.encode()).decode()


def decode_id_token_payload(id_token: str) -> dict:
    """Payload of Google's id_token without signature verification.

    The token arrives over TLS directly from Google's token endpoint in the
    same request that returned it, so signature verification adds no trust
    here; the caller still must check `aud` against our client ID.
    """
    payload_b64 = id_token.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)
    return json.loads(base64.urlsafe_b64decode(payload_b64))
