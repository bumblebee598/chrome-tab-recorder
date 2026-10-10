import pytest
import respx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from httpx import Response

from app.adapters.google_oauth import TOKEN_URL
from app.adapters.users import InMemoryUserStore, UserRecord
from app.api.deps import (
    get_job_store,
    get_settings,
    get_task_queue,
    get_user_store,
)
from app.api.main import app
from app.security import encrypt_refresh_token, issue_session_token
from app.settings import Settings
from tests.fakes import FakeTaskQueue, InMemoryJobStore

FERNET_KEY = Fernet.generate_key().decode()
SETTINGS = Settings(
    google_oauth_client_id="cid",
    google_oauth_client_secret="sec",
    session_jwt_secret="session-secret",
    token_fernet_key=FERNET_KEY,
    webhook_secret="hook-secret",
)
DRIVE_FILE_URL = "https://www.googleapis.com/drive/v3/files/drive-file-1"


@pytest.fixture()
def ctx():
    store = InMemoryJobStore()
    queue = FakeTaskQueue()
    users = InMemoryUserStore()
    app.dependency_overrides[get_settings] = lambda: SETTINGS
    app.dependency_overrides[get_job_store] = lambda: store
    app.dependency_overrides[get_task_queue] = lambda: queue
    app.dependency_overrides[get_user_store] = lambda: users
    yield TestClient(app), store, queue, users
    app.dependency_overrides.clear()


def session_for(sub: str = "user-1") -> dict[str, str]:
    token = issue_session_token(sub, "a@b.test", SETTINGS.session_jwt_secret)
    return {"Authorization": f"Bearer {token}"}


async def seed_user(users: InMemoryUserStore, sub: str = "user-1") -> None:
    await users.upsert(
        UserRecord(
            sub=sub,
            email="a@b.test",
            refresh_token_encrypted=encrypt_refresh_token("rt", FERNET_KEY),
            created_at="2026-10-08T00:00:00Z",
        )
    )


def mock_google(job_id: str = "job-1") -> None:
    respx.post(TOKEN_URL).mock(
        return_value=Response(200, json={"access_token": "at", "expires_in": 3599})
    )
    respx.get(DRIVE_FILE_URL).mock(
        return_value=Response(
            200, json={"id": "drive-file-1", "appProperties": {"jobId": job_id}}
        )
    )


JOB_BODY = {
    "jobId": "job-1",
    "driveFileId": "drive-file-1",
    "name": "Weekly sync",
    "createdAt": "2026-10-08T10:00:00Z",
    "channels": 2,
}


@respx.mock
def test_create_job_twice_yields_one_doc_and_one_task(ctx, anyio_backend=None):
    http, store, queue, users = ctx
    import asyncio

    asyncio.run(seed_user(users))
    mock_google()

    first = http.post("/v1/jobs", json=JOB_BODY, headers=session_for())
    second = http.post("/v1/jobs", json=JOB_BODY, headers=session_for())

    assert first.status_code == 200
    assert second.status_code == 200
    assert len(store.docs) == 1
    assert len(queue.tasks) == 1
    assert queue.tasks[0]["path"] == "/tasks/extract"
    assert queue.tasks[0]["name"].startswith("extract-")


@respx.mock
def test_create_job_rejects_foreign_drive_file(ctx):
    http, store, queue, users = ctx
    import asyncio

    asyncio.run(seed_user(users))
    respx.post(TOKEN_URL).mock(
        return_value=Response(200, json={"access_token": "at", "expires_in": 3599})
    )
    respx.get(DRIVE_FILE_URL).mock(
        return_value=Response(200, json={"id": "drive-file-1", "appProperties": {"jobId": "other"}})
    )

    response = http.post("/v1/jobs", json=JOB_BODY, headers=session_for())

    assert response.status_code == 403
    assert len(store.docs) == 0


@respx.mock
def test_list_jobs_is_scoped_to_caller(ctx):
    http, store, queue, users = ctx
    import asyncio

    asyncio.run(seed_user(users))
    mock_google()
    http.post("/v1/jobs", json=JOB_BODY, headers=session_for())
    store.docs["job-1"]["remoteStatus"] = "transcribing"

    mine = http.get("/v1/jobs?ids=job-1", headers=session_for())
    theirs = http.get("/v1/jobs?ids=job-1", headers=session_for("intruder"))

    assert mine.json()["jobs"][0]["remoteStatus"] == "transcribing"
    assert theirs.json()["jobs"] == []


@respx.mock
def test_retry_increments_generation_and_enqueues_next_missing_stage(ctx):
    http, store, queue, users = ctx
    import asyncio

    asyncio.run(seed_user(users))
    mock_google()
    http.post("/v1/jobs", json=JOB_BODY, headers=session_for())
    store.docs["job-1"].update(
        {"remoteStatus": "failed", "audioGcsUri": "gs://b/audio/job-1.ogg", "transcriptId": None}
    )

    response = http.post("/v1/jobs/job-1/retry", headers=session_for())

    assert response.status_code == 200
    assert store.docs["job-1"]["generation"] == 1
    retry_task = queue.tasks[-1]
    assert retry_task["path"] == "/tasks/transcribe-submit"
    assert retry_task["name"].endswith("-g1")


@respx.mock
def test_retry_recovers_a_stuck_nonfailed_job(ctx):
    http, store, queue, users = ctx
    import asyncio

    asyncio.run(seed_user(users))
    mock_google()
    http.post("/v1/jobs", json=JOB_BODY, headers=session_for())
    # task attempts exhausted mid-extract: job wedged, not failed
    store.docs["job-1"].update({"remoteStatus": "extracting_audio", "audioGcsUri": None})

    response = http.post("/v1/jobs/job-1/retry", headers=session_for())

    assert response.status_code == 200
    assert store.docs["job-1"]["generation"] == 1
    assert queue.tasks[-1]["path"] == "/tasks/extract"
    assert queue.tasks[-1]["name"].endswith("-g1")


def test_webhook_rejects_bad_secret(ctx):
    http, *_ = ctx
    response = http.post(
        "/webhooks/assemblyai?job=job-1",
        json={"transcript_id": "tr-1", "status": "completed"},
        headers={"X-Tabrec-Webhook-Secret": "wrong"},
    )
    assert response.status_code == 401


def test_webhook_completed_enqueues_finalize_once(ctx):
    http, store, queue, _ = ctx
    store.docs["job-1"] = {
        "jobId": "job-1",
        "userSub": "user-1",
        "remoteStatus": "transcribing",
        "transcriptId": "tr-1",
        "generation": 0,
    }
    headers = {"X-Tabrec-Webhook-Secret": "hook-secret"}
    body = {"transcript_id": "tr-1", "status": "completed"}

    first = http.post("/webhooks/assemblyai?job=job-1", json=body, headers=headers)
    second = http.post("/webhooks/assemblyai?job=job-1", json=body, headers=headers)

    assert first.status_code == 200 and second.status_code == 200
    finalize_tasks = [t for t in queue.tasks if t["path"] == "/tasks/finalize"]
    assert len(finalize_tasks) == 1


def test_webhook_for_superseded_transcript_is_ignored(ctx):
    """A late webhook from an old generation must not touch the job."""
    http, store, queue, _ = ctx
    store.docs["job-1"] = {
        "jobId": "job-1",
        "userSub": "user-1",
        "remoteStatus": "transcribing",
        "transcriptId": "tr-2",  # retry already produced a newer transcript
        "generation": 1,
    }
    response = http.post(
        "/webhooks/assemblyai?job=job-1",
        json={"transcript_id": "tr-1", "status": "completed"},
        headers={"X-Tabrec-Webhook-Secret": "hook-secret"},
    )
    assert response.status_code == 200
    assert [t for t in queue.tasks if t["path"] == "/tasks/finalize"] == []


def test_advance_cas_has_exactly_one_winner():
    """Two competing stage completions: one CAS wins, the other is a no-op."""
    import asyncio

    from tests.fakes import InMemoryJobStore

    store = InMemoryJobStore()
    asyncio.run(store.create({"jobId": "j", "remoteStatus": "transcribing"}))
    first = asyncio.run(store.advance("j", ["transcribing"], "generating_doc", {}))
    second = asyncio.run(store.advance("j", ["transcribing"], "generating_doc", {}))
    assert first is True
    assert second is False


def test_webhook_error_marks_job_failed(ctx):
    http, store, queue, _ = ctx
    store.docs["job-1"] = {
        "jobId": "job-1",
        "userSub": "user-1",
        "remoteStatus": "transcribing",
        "transcriptId": "tr-1",
        "generation": 0,
    }
    response = http.post(
        "/webhooks/assemblyai?job=job-1",
        json={"transcript_id": "tr-1", "status": "error"},
        headers={"X-Tabrec-Webhook-Secret": "hook-secret"},
    )
    assert response.status_code == 200
    assert store.docs["job-1"]["remoteStatus"] == "failed"
