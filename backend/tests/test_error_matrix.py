"""Step 11: every failure mode has a state, a recovery path, and a test."""

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app.adapters.users import InMemoryUserStore
from app.api.deps import (
    get_docs_client,
    get_email_sender,
    get_job_store,
    get_settings,
    get_task_queue,
    get_transcription_client,
    get_user_store,
)
from app.settings import Settings
from app.worker.main import app as worker_app
from app.worker import task_routes
from tests.fakes import (
    FakeDocsClient,
    FakeEmailSender,
    FakeTaskQueue,
    FakeTranscriber,
    InMemoryJobStore,
)

SETTINGS = Settings(
    session_jwt_secret="s",
    token_fernet_key=Fernet.generate_key().decode(),
    webhook_secret="hook",
)


class FailingDocs(FakeDocsClient):
    async def create_doc(self, *args, **kwargs):
        from app.adapters.docs import DocsError

        raise DocsError("batchUpdate failed: HTTP 403")


class FailingEmail(FakeEmailSender):
    async def send(self, **kwargs):
        from app.adapters.gmail import EmailError

        raise EmailError("Gmail send failed: HTTP 429")


@pytest.fixture()
def ctx():
    store = InMemoryJobStore()
    overrides = {
        get_settings: lambda: SETTINGS,
        get_job_store: lambda: store,
        get_task_queue: lambda: FakeTaskQueue(),
        get_docs_client: lambda: FakeDocsClient(),
        get_email_sender: lambda: FakeEmailSender(),
        get_transcription_client: lambda: FakeTranscriber(status="completed"),
        get_user_store: lambda: InMemoryUserStore(),
    }
    worker_app.dependency_overrides.update(overrides)
    task_routes._INJECTED_FAILURES.clear()
    yield TestClient(worker_app), store
    worker_app.dependency_overrides.clear()
    task_routes._INJECTED_FAILURES.clear()


def transcribing_job(**overrides) -> dict:
    return {
        "jobId": "job-1",
        "userSub": "user-1",
        "userEmail": "a@b.test",
        "name": "Weekly sync",
        "createdAt": "2026-10-09T10:00:00Z",
        "driveFileId": "drive-file-1",
        "channels": 2,
        "remoteStatus": "transcribing",
        "generation": 0,
        "transcriptId": "tr-1",
        "audioGcsUri": "gs://b/audio/job-1.ogg",
        "docId": None,
        "error": None,
        **overrides,
    }


def test_docs_failure_marks_doc_failed(ctx, monkeypatch):
    http, store = ctx
    worker_app.dependency_overrides[get_docs_client] = lambda: FailingDocs()

    async def ok_mint(*args, **kwargs):
        return "user-token"

    import app.worker.task_routes as routes

    monkeypatch.setattr(routes, "mint_user_access_token", ok_mint)
    monkeypatch.setattr(routes.drive, "get_file_metadata", ok_metadata)
    store.docs["job-1"] = transcribing_job()

    response = http.post("/tasks/finalize", json={"jobId": "job-1"})

    assert response.status_code == 200
    job = store.docs["job-1"]
    assert job["remoteStatus"] == "failed"
    assert job["error"]["code"] == "DOC_FAILED"


async def ok_metadata(token, file_id):
    return {"id": file_id, "parents": ["folder-1"]}


def test_extract_with_revoked_google_access_fails_cleanly(ctx):
    """No user record -> token mint fails -> USER_AUTH, no crash loop."""
    http, store = ctx
    store.docs["job-1"] = transcribing_job(
        remoteStatus="queued", transcriptId=None, audioGcsUri=None
    )

    response = http.post("/tasks/extract", json={"jobId": "job-1"})

    assert response.status_code == 200  # 200 = stop retrying, the job is marked
    job = store.docs["job-1"]
    assert job["remoteStatus"] == "failed"
    assert job["error"]["code"] == "USER_AUTH"


def test_fault_injection_fails_then_recovers(ctx):
    http, store = ctx
    worker_app.dependency_overrides[get_settings] = lambda: Settings(
        session_jwt_secret="s",
        token_fernet_key=SETTINGS.token_fernet_key,
        webhook_secret="hook",
        fail_stage="extract:2",
    )
    store.docs["job-1"] = transcribing_job(
        remoteStatus="queued", transcriptId=None, audioGcsUri="gs://b/audio/job-1.ogg"
    )

    first = http.post("/tasks/extract", json={"jobId": "job-1"})
    second = http.post("/tasks/extract", json={"jobId": "job-1"})
    third = http.post("/tasks/extract", json={"jobId": "job-1"})

    assert first.status_code == 503
    assert second.status_code == 503
    assert third.status_code == 200  # audio already exists -> skips ahead


def test_email_failure_marks_email_failed(ctx, monkeypatch):
    http, store = ctx

    async def ok_mint(*args, **kwargs):
        return "user-token"

    worker_app.dependency_overrides[get_email_sender] = lambda: FailingEmail()
    import app.worker.task_routes as routes

    monkeypatch.setattr(routes, "mint_user_access_token", ok_mint)
    store.docs["job-1"] = transcribing_job(docId="doc-1", contentWritten=True)
    response = http.post("/tasks/finalize", json={"jobId": "job-1"})

    assert response.status_code == 200
    job = store.docs["job-1"]
    assert job["remoteStatus"] == "failed"
    assert job["error"]["code"] == "EMAIL_FAILED"
