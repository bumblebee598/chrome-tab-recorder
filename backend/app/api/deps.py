from dataclasses import dataclass
from functools import lru_cache

import jwt as pyjwt
from fastapi import Depends, Header, HTTPException

from app.adapters.google_oauth import GoogleOAuthClient, InvalidGrantError, OAuthError
from app.adapters.store import FirestoreJobStore, JobStore
from app.adapters.tasks import CloudTasksQueue, TaskQueue
from app.adapters.users import FirestoreUserStore, UserStore
from app.security import decrypt_refresh_token, verify_session_token
from app.settings import Settings


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def _firestore_user_store() -> FirestoreUserStore:
    return FirestoreUserStore(project=get_settings().google_cloud_project)


def get_user_store() -> UserStore:
    return _firestore_user_store()


@lru_cache
def _firestore_job_store() -> FirestoreJobStore:
    return FirestoreJobStore(project=get_settings().google_cloud_project)


def get_job_store() -> JobStore:
    return _firestore_job_store()


@lru_cache
def _cloud_tasks() -> CloudTasksQueue:
    settings = get_settings()
    return CloudTasksQueue(
        project=settings.google_cloud_project,
        location=settings.tasks_location,
        worker_base_url=settings.worker_base_url,
        emulator_host=settings.cloud_tasks_emulator_host or None,
        invoker_service_account=settings.tasks_invoker_service_account or None,
    )


def get_task_queue() -> TaskQueue:
    return _cloud_tasks()


@lru_cache
def _gcs_storage():
    from app.adapters.gcs import GcsAudioStorage

    return GcsAudioStorage(bucket=get_settings().gcs_bucket)


def get_audio_storage():
    return _gcs_storage()


@lru_cache
def _assemblyai():
    from app.adapters.assemblyai import AssemblyAIClient

    return AssemblyAIClient(api_key=get_settings().assemblyai_api_key)


def get_transcription_client():
    return _assemblyai()


@lru_cache
def _docs_client():
    from app.adapters.docs import GoogleDocsClient

    return GoogleDocsClient()


def get_docs_client():
    return _docs_client()


def get_email_sender():
    from app.adapters.gmail import GmailSender, ResendSender

    settings = get_settings()
    if settings.email_provider == "resend" and settings.resend_api_key:
        return ResendSender(api_key=settings.resend_api_key)
    return GmailSender()


def get_oauth_client() -> GoogleOAuthClient:
    settings = get_settings()
    return GoogleOAuthClient(
        client_id=settings.google_oauth_client_id,
        client_secret=settings.google_oauth_client_secret,
    )


@dataclass
class CurrentUser:
    sub: str
    email: str


def get_current_user(
    authorization: str = Header(default=""),
    settings: Settings = Depends(get_settings),
) -> CurrentUser:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing session token")
    try:
        claims = verify_session_token(token, settings.session_jwt_secret)
    except pyjwt.PyJWTError as error:
        raise HTTPException(status_code=401, detail="Invalid session token") from error
    return CurrentUser(sub=claims["sub"], email=claims.get("email", ""))


async def mint_user_access_token(
    sub: str,
    users: UserStore,
    oauth: GoogleOAuthClient,
    settings: Settings,
) -> str:
    """Fresh Drive access token from the stored (encrypted) refresh token."""
    user = await users.get(sub)
    if user is None:
        raise HTTPException(status_code=401, detail="Unknown user")
    try:
        tokens = await oauth.refresh_access_token(
            decrypt_refresh_token(user.refresh_token_encrypted, settings.token_fernet_key)
        )
    except InvalidGrantError as error:
        raise HTTPException(status_code=401, detail="invalid_grant") from error
    except OAuthError as error:
        raise HTTPException(status_code=502, detail=f"Token refresh failed: {error}") from error
    return tokens["access_token"]
