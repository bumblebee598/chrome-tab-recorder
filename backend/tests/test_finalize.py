import pytest
import respx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from httpx import Response

from app.adapters.google_oauth import TOKEN_URL
from app.adapters.users import InMemoryUserStore, UserRecord
from app.api.deps import (
    get_docs_client,
    get_email_sender,
    get_job_store,
    get_settings,
    get_task_queue,
    get_transcription_client,
    get_user_store,
)
from app.security import encrypt_refresh_token
from app.settings import Settings
from app.worker.main import app
from tests.fakes import (
    FakeDocsClient,
    FakeEmailSender,
    FakeTaskQueue,
    FakeTranscriber,
    InMemoryJobStore,
)

FERNET_KEY = Fernet.generate_key().decode()
SETTINGS = Settings(
    google_oauth_client_id="cid",
    google_oauth_client_secret="sec",
    session_jwt_secret="s",
    token_fernet_key=FERNET_KEY,
    webhook_secret="hook-secret",
)
DRIVE_META_URL = "https://www.googleapis.com/drive/v3/files/drive-file-1"


@pytest.fixture()
def ctx():
    store = InMemoryJobStore()
    queue = FakeTaskQueue()
    docs = FakeDocsClient()
    sender = FakeEmailSender()
    transcriber = FakeTranscriber(status="completed")
    users = InMemoryUserStore()
    app.dependency_overrides[get_settings] = lambda: SETTINGS
    app.dependency_overrides[get_job_store] = lambda: store
    app.dependency_overrides[get_task_queue] = lambda: queue
    app.dependency_overrides[get_docs_client] = lambda: docs
    app.dependency_overrides[get_email_sender] = lambda: sender
    app.dependency_overrides[get_transcription_client] = lambda: transcriber
    app.dependency_overrides[get_user_store] = lambda: users
    yield TestClient(app), store, docs, sender, transcriber
    app.dependency_overrides.clear()


def seed(store: InMemoryJobStore, users: InMemoryUserStore | None = None, **overrides) -> None:
    store.docs["job-1"] = {
        "jobId": "job-1",
        "userSub": "user-1",
        "userEmail": "a@b.test",
        "name": "Weekly sync",
        "createdAt": "2026-10-08T10:00:00Z",
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


async def seed_user(users: InMemoryUserStore) -> None:
    await users.upsert(
        UserRecord(
            sub="user-1",
            email="a@b.test",
            refresh_token_encrypted=encrypt_refresh_token("rt", FERNET_KEY),
            created_at="2026-10-08T00:00:00Z",
        )
    )


def mock_google() -> None:
    respx.post(TOKEN_URL).mock(
        return_value=Response(200, json={"access_token": "at", "expires_in": 3599})
    )
    respx.get(DRIVE_META_URL).mock(
        return_value=Response(
            200,
            json={"id": "drive-file-1", "parents": ["folder-1"], "appProperties": {"jobId": "job-1"}},
        )
    )


@respx.mock
def test_finalize_twice_yields_one_doc_and_one_email(ctx):
    import asyncio

    http, store, docs, sender, _ = ctx
    users = app.dependency_overrides[get_user_store]()
    asyncio.run(seed_user(users))
    seed(store)
    mock_google()

    first = http.post("/tasks/finalize", json={"jobId": "job-1"})
    second = http.post("/tasks/finalize", json={"jobId": "job-1"})

    assert first.status_code == 200 and second.status_code == 200
    assert len(docs.created) == 1
    assert docs.created[0]["folderId"] == "folder-1"
    assert docs.created[0]["name"] == "Transcript – Weekly sync"
    assert len(sender.sent) == 1
    assert "drive-file-1" in sender.sent[0]["text"]
    assert "doc-new-1" in sender.sent[0]["text"]
    job = store.docs["job-1"]
    assert job["remoteStatus"] == "completed"
    assert job["contentWritten"] is True
    assert job["emailSentAt"]


@respx.mock
def test_finalize_rewrites_half_written_doc(ctx):
    import asyncio

    http, store, docs, sender, _ = ctx
    users = app.dependency_overrides[get_user_store]()
    asyncio.run(seed_user(users))
    docs.existing = "doc-old-1"
    docs.end_index = 500
    seed(store, docId=None, contentWritten=False)
    mock_google()

    response = http.post("/tasks/finalize", json={"jobId": "job-1"})

    assert response.status_code == 200
    assert docs.created == []  # adopted, not duplicated
    first_request = docs.batches[0][0]
    assert "deleteContentRange" in first_request
    assert store.docs["job-1"]["docId"] == "doc-old-1"


def test_finalize_waits_for_transcript(ctx):
    http, store, docs, sender, transcriber = ctx
    transcriber.status = "processing"
    seed(store)

    response = http.post("/tasks/finalize", json={"jobId": "job-1"})

    assert response.status_code == 503
    assert sender.sent == []


@respx.mock
def test_poll_error_sends_failure_email_exactly_once(ctx):
    import asyncio

    http, store, docs, sender, transcriber = ctx
    users = app.dependency_overrides[get_user_store]()
    asyncio.run(seed_user(users))
    transcriber.status = "error"
    seed(store)
    mock_google()

    http.post("/tasks/poll", json={"jobId": "job-1", "attempt": 0})
    http.post("/tasks/poll", json={"jobId": "job-1", "attempt": 1})

    assert store.docs["job-1"]["remoteStatus"] == "failed"
    failure_emails = [e for e in sender.sent if "problem" in e["subject"]]
    assert len(failure_emails) == 1
