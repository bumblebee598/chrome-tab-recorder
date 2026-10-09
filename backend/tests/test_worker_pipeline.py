import shutil
import subprocess
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app.api.deps import (
    get_audio_storage,
    get_job_store,
    get_settings,
    get_task_queue,
    get_transcription_client,
)
from app.settings import Settings
from app.worker.main import app
from app.worker.pipeline import extract_audio_to_ogg
from tests.fakes import FakeAudioStorage, FakeTaskQueue, FakeTranscriber, InMemoryJobStore

SETTINGS = Settings(
    session_jwt_secret="s",
    token_fernet_key=Fernet.generate_key().decode(),
    webhook_secret="hook-secret",
    assemblyai_api_key="aai-key",
    api_base_url="https://api.example.test",
)

ffmpeg_missing = shutil.which("ffmpeg") is None


@pytest.fixture()
def ctx():
    store = InMemoryJobStore()
    queue = FakeTaskQueue()
    storage = FakeAudioStorage()
    transcriber = FakeTranscriber()
    app.dependency_overrides[get_settings] = lambda: SETTINGS
    app.dependency_overrides[get_job_store] = lambda: store
    app.dependency_overrides[get_task_queue] = lambda: queue
    app.dependency_overrides[get_audio_storage] = lambda: storage
    app.dependency_overrides[get_transcription_client] = lambda: transcriber
    yield TestClient(app), store, queue, storage, transcriber
    app.dependency_overrides.clear()


def job_doc(**overrides) -> dict:
    return {
        "jobId": "job-1",
        "userSub": "user-1",
        "name": "Weekly sync",
        "driveFileId": "drive-file-1",
        "channels": 2,
        "remoteStatus": "queued",
        "generation": 0,
        "transcriptId": None,
        "audioGcsUri": None,
        "docId": None,
        "error": None,
        **overrides,
    }


@pytest.mark.skipif(ffmpeg_missing, reason="ffmpeg not installed")
@pytest.mark.anyio
async def test_extract_audio_produces_playable_ogg(tmp_path: Path):
    source = tmp_path / "in.webm"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=880:duration=2",
            "-filter_complex", "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]",
            "-map", "[a]", "-c:a", "libopus", str(source),
        ],
        check=True,
    )
    out = tmp_path / "out.ogg"

    async def chunks():
        data = source.read_bytes()
        for i in range(0, len(data), 64 * 1024):
            yield data[i : i + 64 * 1024]

    await extract_audio_to_ogg(chunks(), channels=2, out_path=str(out))

    assert out.stat().st_size > 1000
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,channels",
         "-of", "csv=p=0", str(out)],
        capture_output=True, text=True, check=True,
    )
    assert "opus" in probe.stdout
    assert "2" in probe.stdout


def test_extract_skips_when_audio_already_in_gcs(ctx):
    http, store, queue, *_ = ctx
    store.docs["job-1"] = job_doc(audioGcsUri="gs://b/audio/job-1.ogg")

    response = http.post("/tasks/extract", json={"jobId": "job-1"})

    assert response.status_code == 200
    assert response.json().get("skipped") is True
    assert queue.tasks[0]["path"] == "/tasks/transcribe-submit"


def test_extract_for_unknown_job_acks_and_stops(ctx):
    http, *_ = ctx
    assert http.post("/tasks/extract", json={"jobId": "ghost"}).status_code == 200


def test_submit_sets_transcript_once_and_schedules_poll(ctx):
    http, store, queue, storage, transcriber = ctx
    store.docs["job-1"] = job_doc(
        remoteStatus="extracting_audio", audioGcsUri="gs://b/audio/job-1.ogg"
    )

    first = http.post("/tasks/transcribe-submit", json={"jobId": "job-1"})
    second = http.post("/tasks/transcribe-submit", json={"jobId": "job-1"})

    assert first.status_code == 200 and second.status_code == 200
    assert len(transcriber.submissions) == 1  # second delivery skipped
    submission = transcriber.submissions[0]
    assert submission["channels"] == 2
    assert submission["webhook_url"].endswith("/webhooks/assemblyai?job=job-1")
    assert submission["webhook_header_value"] == "hook-secret"
    assert store.docs["job-1"]["transcriptId"] == "tr-fake-1"
    assert store.docs["job-1"]["remoteStatus"] == "transcribing"
    polls = [t for t in queue.tasks if t["path"] == "/tasks/poll"]
    assert len(polls) == 1 and polls[0]["delay"] == 900


def test_poll_completed_enqueues_finalize(ctx):
    http, store, queue, _, transcriber = ctx
    transcriber.status = "completed"
    store.docs["job-1"] = job_doc(remoteStatus="transcribing", transcriptId="tr-1")

    response = http.post("/tasks/poll", json={"jobId": "job-1", "attempt": 0})

    assert response.status_code == 200
    assert [t for t in queue.tasks if t["path"] == "/tasks/finalize"]


def test_poll_still_processing_reschedules_with_backoff(ctx):
    http, store, queue, _, transcriber = ctx
    transcriber.status = "processing"
    store.docs["job-1"] = job_doc(remoteStatus="transcribing", transcriptId="tr-1")

    http.post("/tasks/poll", json={"jobId": "job-1", "attempt": 0})

    polls = [t for t in queue.tasks if t["path"] == "/tasks/poll"]
    assert len(polls) == 1
    assert polls[0]["payload"]["attempt"] == 1
    assert polls[0]["delay"] == 1800


def test_poll_error_marks_failed(ctx):
    http, store, queue, _, transcriber = ctx
    transcriber.status = "error"
    store.docs["job-1"] = job_doc(remoteStatus="transcribing", transcriptId="tr-1")

    http.post("/tasks/poll", json={"jobId": "job-1", "attempt": 0})

    assert store.docs["job-1"]["remoteStatus"] == "failed"
    assert store.docs["job-1"]["error"]["code"] == "TRANSCRIPT_ERROR"
