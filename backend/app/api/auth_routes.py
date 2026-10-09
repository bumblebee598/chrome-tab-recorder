from datetime import datetime, timezone

import jwt as pyjwt
from fastapi import APIRouter, Depends, Header, HTTPException

from app.adapters.google_oauth import GoogleOAuthClient, InvalidGrantError, OAuthError
from app.adapters.users import UserRecord, UserStore
from app.api.deps import get_oauth_client, get_settings, get_user_store
from app.domain.model import CamelModel
from app.security import (
    decode_id_token_payload,
    decrypt_refresh_token,
    encrypt_refresh_token,
    issue_session_token,
    verify_session_token,
)
from app.settings import Settings

router = APIRouter(prefix="/auth", tags=["auth"])


class ExchangeRequest(CamelModel):
    code: str
    code_verifier: str
    redirect_uri: str


class ExchangeResponse(CamelModel):
    session_token: str
    email: str


class AccessTokenResponse(CamelModel):
    access_token: str
    expires_in: int
    email: str


@router.post("/exchange", response_model=ExchangeResponse, response_model_by_alias=True)
async def exchange(
    body: ExchangeRequest,
    settings: Settings = Depends(get_settings),
    oauth: GoogleOAuthClient = Depends(get_oauth_client),
    users: UserStore = Depends(get_user_store),
) -> ExchangeResponse:
    try:
        tokens = await oauth.exchange_code(body.code, body.code_verifier, body.redirect_uri)
    except OAuthError as error:
        raise HTTPException(status_code=400, detail=f"Code exchange failed: {error}") from error

    claims = decode_id_token_payload(tokens["id_token"])
    if claims.get("aud") != settings.google_oauth_client_id:
        raise HTTPException(status_code=401, detail="id_token audience mismatch")
    sub = claims["sub"]
    email = claims.get("email", "")

    refresh_token = tokens.get("refresh_token")
    if refresh_token:
        await users.upsert(
            UserRecord(
                sub=sub,
                email=email,
                refresh_token_encrypted=encrypt_refresh_token(
                    refresh_token, settings.token_fernet_key
                ),
                created_at=datetime.now(timezone.utc).isoformat(),
            )
        )
    elif await users.get(sub) is None:
        # prompt=consent should always yield one; without it we cannot act offline
        raise HTTPException(status_code=400, detail="Google returned no refresh token")

    return ExchangeResponse(
        session_token=issue_session_token(sub, email, settings.session_jwt_secret),
        email=email,
    )


@router.get("/access-token", response_model=AccessTokenResponse, response_model_by_alias=True)
async def access_token(
    authorization: str = Header(default=""),
    settings: Settings = Depends(get_settings),
    oauth: GoogleOAuthClient = Depends(get_oauth_client),
    users: UserStore = Depends(get_user_store),
) -> AccessTokenResponse:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing session token")
    try:
        claims = verify_session_token(token, settings.session_jwt_secret)
    except pyjwt.PyJWTError as error:
        raise HTTPException(status_code=401, detail="Invalid session token") from error

    user = await users.get(claims["sub"])
    if user is None:
        raise HTTPException(status_code=401, detail="Unknown user")

    try:
        tokens = await oauth.refresh_access_token(
            decrypt_refresh_token(user.refresh_token_encrypted, settings.token_fernet_key)
        )
    except InvalidGrantError as error:
        # Revoked or expired (7 days in Testing mode): the user must re-consent
        raise HTTPException(status_code=401, detail="invalid_grant") from error
    except OAuthError as error:
        raise HTTPException(status_code=502, detail=f"Token refresh failed: {error}") from error

    return AccessTokenResponse(
        access_token=tokens["access_token"],
        expires_in=int(tokens.get("expires_in", 3600)),
        email=user.email,
    )
