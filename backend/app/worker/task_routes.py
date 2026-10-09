"""Cloud Tasks stage handlers. Contract: at-least-once delivery, so every
handler first reads the job and returns 200 when its stage is already done.
Non-2xx responses trigger a queue retry with backoff; permanent failures mark
the job failed and return 200 so the queue stops."""

import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.adapters import drive
from app.adapters.docs import DocsError
from app.adapters.gmail import EmailError
from app.adapters.google_oauth import GoogleOAuthClient
from app.adapters.store import JobDoc, JobStore, now_iso
from app.adapters.tasks import TaskQueue, task_name
from app.adapters.users import UserStore
from app.api.deps import (
    get_audio_storage,
    get_docs_client,
    get_email_sender,
    get_job_store,
    get_oauth_client,
    get_settings,
    get_task_queue,
    get_transcription_client,
    get_user_store,
    mint_user_access_token,
)
from app.domain.model import CamelModel
from app.settings import Settings
from app.worker import docgen
from app.worker.pipeline import ExtractionError, extract_audio_to_ogg

router = APIRouter(prefix="/tasks", tags=["tasks"])

POLL_FIRST_DELAY_S = 15 * 60
POLL_MAX_ATTEMPTS = 12
TERMINAL = ("completed", "failed")

_INJECTED_FAILURES: dict[str, int] = {}


def _maybe_inject_failure(settings: Settings, stage: str) -> JSONResponse | None:
    """FAIL_STAGE=extract:2 -> first two extract deliveries 503 (demo/test aid)."""
    if not settings.fail_stage:
        return None
    name, _, count = settings.fail_stage.partition(":")
    if name != stage:
        return None
    used = _INJECTED_FAILURES.get(stage, 0)
    if used >= int(count or 1):
        return None
    _INJECTED_FAILURES[stage] = used + 1
    return JSONResponse(
        status_code=503, content={"error": f"injected failure {used + 1} for {stage}"}
    )


class TaskPayload(CamelModel):
    job_id: str
    attempt: int = 0


async def _fail(
    store: JobStore,
    job_id: str,
    code: str,
    message: str,
    notify=None,
) -> dict:
    moved = await store.advance(
        job_id,
        ["queued", "extracting_audio", "transcribing", "generating_doc", "emailing"],
        "failed",
        {"error": {"code": code, "message": message[:500]}},
    )
    if moved and notify:
        # advance() succeeds exactly once per failure, so this is the
        # at-most-once gate for the failure email. Best effort only.
        try:
            await notify()
        except Exception:
            pass
    return {"ok": True, "failed": True}


def _drive_url(file_id: str) -> str:
    return f"https://drive.google.com/file/d/{file_id}/view"


def _doc_url(doc_id: str) -> str:
    return f"https://docs.google.com/document/d/{doc_id}/edit"


def _failure_notifier(job, users, oauth, settings, sender, reason: str):
    async def notify() -> None:
        to = job.get("userEmail")
        if not to:
            return
        token = await mint_user_access_token(job["userSub"], users, oauth, settings)
        name = job.get("name", "your recording")
        links = f"\nRecording: {_drive_url(job['driveFileId'])}" if job.get("driveFileId") else ""
        await sender.send(
            access_token=token,
            to=to,
            subject=f"“{name}” hit a problem",
            text=f"We couldn't finish processing “{name}”: {reason}.{links}\n"
            "Open the Tab Recorder dashboard to retry.",
            html=f"<p>We couldn't finish processing <b>{name}</b>: {reason}.</p>"
            "<p>Open the Tab Recorder dashboard to retry.</p>",
            job_id=job["jobId"],
        )

    return notify


@router.post("/extract")
async def extract(
    body: TaskPayload,
    store: JobStore = Depends(get_job_store),
    tasks: TaskQueue = Depends(get_task_queue),
    users: UserStore = Depends(get_user_store),
    oauth: GoogleOAuthClient = Depends(get_oauth_client),
    storage=Depends(get_audio_storage),
    sender=Depends(get_email_sender),
    settings: Settings = Depends(get_settings),
) -> dict:
    injected = _maybe_inject_failure(settings, "extract")
    if injected:
        return injected  # type: ignore[return-value]

    job = await store.get(body.job_id)
    if job is None or job.get("remoteStatus") in TERMINAL:
        return {"ok": True}

    generation = int(job.get("generation", 0))
    if job.get("audioGcsUri"):
        await _enqueue_submit(tasks, body.job_id, generation)
        return {"ok": True, "skipped": True}

    if int(job.get("channels", 0)) == 0:
        return await _fail(store, body.job_id, "NO_AUDIO", "Recording has no audio channels")

    await store.advance(body.job_id, ["queued"], "extracting_audio", {})

    try:
        access_token = await mint_user_access_token(job["userSub"], users, oauth, settings)
    except Exception as error:  # invalid_grant etc. — retrying will not help
        return await _fail(
            store,
            body.job_id,
            "USER_AUTH",
            str(error),
            notify=_failure_notifier(
                job, users, oauth, settings, sender, "Google access was revoked"
            ),
        )

    with tempfile.TemporaryDirectory() as tmp:
        out_path = str(Path(tmp) / f"{body.job_id}.ogg")
        try:
            await extract_audio_to_ogg(
                drive.stream_file(access_token, job["driveFileId"]),
                channels=int(job["channels"]),
                out_path=out_path,
            )
        except (ExtractionError, drive.DriveError) as error:
            # transient (network, 5xx): let Cloud Tasks retry with backoff
            return JSONResponse(status_code=503, content={"error": str(error)})

        gcs_uri = await storage.upload_file(
            out_path, f"audio/{body.job_id}.ogg", content_type="audio/ogg"
        )

    await store.update(body.job_id, {"audioGcsUri": gcs_uri})
    await _enqueue_submit(tasks, body.job_id, generation)
    return {"ok": True}


async def _enqueue_submit(tasks: TaskQueue, job_id: str, generation: int) -> None:
    await tasks.enqueue(
        queue="transcribe-submit",
        path="/tasks/transcribe-submit",
        payload={"jobId": job_id},
        name=task_name("transcribe-submit", job_id, generation),
    )


@router.post("/transcribe-submit")
async def transcribe_submit(
    body: TaskPayload,
    store: JobStore = Depends(get_job_store),
    tasks: TaskQueue = Depends(get_task_queue),
    storage=Depends(get_audio_storage),
    transcriber=Depends(get_transcription_client),
    settings: Settings = Depends(get_settings),
) -> dict:
    injected = _maybe_inject_failure(settings, "transcribe-submit")
    if injected:
        return injected  # type: ignore[return-value]

    job = await store.get(body.job_id)
    if job is None or job.get("remoteStatus") in TERMINAL:
        return {"ok": True}

    generation = int(job.get("generation", 0))
    if job.get("transcriptId"):
        await _schedule_poll(tasks, body.job_id, generation, attempt=0)
        return {"ok": True, "skipped": True}
    if not job.get("audioGcsUri"):
        return JSONResponse(status_code=503, content={"error": "audio not extracted yet"})

    audio_url = await storage.signed_url(f"audio/{body.job_id}.ogg", hours=24)
    transcript_id = await transcriber.submit(
        audio_url=audio_url,
        channels=int(job.get("channels", 1)),
        webhook_url=f"{settings.api_base_url}/webhooks/assemblyai?job={body.job_id}",
        webhook_header_name=settings.webhook_header_name,
        webhook_header_value=settings.webhook_secret,
    )

    saved = await store.set_transcript_once(body.job_id, transcript_id)
    if not saved:
        # Lost a race with another delivery. Accepted risk per the plan: the
        # duplicate transcript costs ~a dollar at most; the saved ID wins.
        pass
    await store.advance(body.job_id, ["extracting_audio", "queued"], "transcribing", {})
    await _schedule_poll(tasks, body.job_id, generation, attempt=0)
    return {"ok": True}


async def _schedule_poll(tasks: TaskQueue, job_id: str, generation: int, attempt: int) -> None:
    delay = min(POLL_FIRST_DELAY_S * (attempt + 1), 3600)
    await tasks.enqueue(
        queue="transcribe-submit",
        path="/tasks/poll",
        payload={"jobId": job_id, "attempt": attempt},
        name=task_name("poll", job_id, generation, suffix=f"-a{attempt}"),
        delay_seconds=delay,
    )


@router.post("/poll")
async def poll(
    body: TaskPayload,
    store: JobStore = Depends(get_job_store),
    tasks: TaskQueue = Depends(get_task_queue),
    transcriber=Depends(get_transcription_client),
    users: UserStore = Depends(get_user_store),
    oauth: GoogleOAuthClient = Depends(get_oauth_client),
    sender=Depends(get_email_sender),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Webhook backup: without a public URL (local dev) this is the only signal."""
    job = await store.get(body.job_id)
    if job is None or job.get("remoteStatus") in TERMINAL:
        return {"ok": True}
    transcript_id = job.get("transcriptId")
    if not transcript_id:
        return {"ok": True}

    generation = int(job.get("generation", 0))
    transcript = await transcriber.fetch(transcript_id)
    status = transcript.get("status", "")

    if status == "completed":
        await tasks.enqueue(
            queue="finalize",
            path="/tasks/finalize",
            payload={"jobId": body.job_id},
            name=task_name("finalize", body.job_id, generation),
        )
        return {"ok": True}
    if status == "error":
        reason = transcript.get("error", "transcription failed")
        return await _fail(
            store,
            body.job_id,
            "TRANSCRIPT_ERROR",
            reason,
            notify=_failure_notifier(job, users, oauth, settings, sender, reason),
        )

    if body.attempt + 1 >= POLL_MAX_ATTEMPTS:
        return await _fail(
            store,
            body.job_id,
            "TRANSCRIPT_TIMEOUT",
            "Transcription never finished",
            notify=_failure_notifier(
                job, users, oauth, settings, sender, "transcription never finished"
            ),
        )
    await _schedule_poll(tasks, body.job_id, generation, attempt=body.attempt + 1)
    return {"ok": True}


@router.post("/finalize")
async def finalize(
    body: TaskPayload,
    store: JobStore = Depends(get_job_store),
    transcriber=Depends(get_transcription_client),
    docs=Depends(get_docs_client),
    sender=Depends(get_email_sender),
    users: UserStore = Depends(get_user_store),
    oauth: GoogleOAuthClient = Depends(get_oauth_client),
    settings: Settings = Depends(get_settings),
):
    injected = _maybe_inject_failure(settings, "finalize")
    if injected:
        return injected

    job = await store.get(body.job_id)
    if job is None or job.get("remoteStatus") == "failed" or job.get("emailSentAt"):
        return {"ok": True}
    transcript_id = job.get("transcriptId")
    if not transcript_id:
        return JSONResponse(status_code=503, content={"error": "no transcript yet"})

    transcript = await transcriber.fetch(transcript_id)
    if transcript.get("status") == "error":
        reason = transcript.get("error", "transcription failed")
        return await _fail(
            store,
            body.job_id,
            "TRANSCRIPT_ERROR",
            reason,
            notify=_failure_notifier(job, users, oauth, settings, sender, reason),
        )
    if transcript.get("status") != "completed":
        return JSONResponse(status_code=503, content={"error": "transcript not ready"})

    await store.advance(body.job_id, ["transcribing", "queued"], "generating_doc", {})
    access_token = await mint_user_access_token(job["userSub"], users, oauth, settings)

    # --- Doc (idempotent: find by appProperties.jobId, rewrite if half-written) ---
    try:
        doc_id = job.get("docId")
        if not doc_id:
            doc_id = await docs.find_doc(access_token, body.job_id)
        if not doc_id:
            metadata = await drive.get_file_metadata(access_token, job["driveFileId"])
            folder_id = (metadata or {}).get("parents", [None])[0]
            doc_id = await docs.create_doc(
                access_token, f"Transcript – {job['name']}", folder_id, body.job_id
            )
        await store.update(body.job_id, {"docId": doc_id})

        if not job.get("contentWritten"):
            turns = docgen.turns_from_transcript(transcript, int(job.get("channels", 1)))
            batches = docgen.build_doc_batches(
                title=job["name"],
                recorded_at=f"{job.get('createdAt', '')} (UTC)",
                duration_ms=int(transcript.get("audio_duration", 0)) * 1000,
                recording_url=_drive_url(job["driveFileId"]),
                turns=turns,
            )
            end_index = await docs.get_end_index(access_token, doc_id)
            clear = docgen.clear_body_request(end_index)
            if clear and batches:
                batches[0] = [clear, *batches[0]]
            for batch in batches:
                await docs.batch_update(access_token, doc_id, batch)
            await store.update(body.job_id, {"contentWritten": True})
    except DocsError as error:
        # The Docs/Drive API said no (quota, revoked grant, bad request).
        # Mark failed so the user gets a Retry path; retry resumes at finalize.
        return await _fail(
            store,
            body.job_id,
            "DOC_FAILED",
            str(error),
            notify=_failure_notifier(
                job, users, oauth, settings, sender, "we couldn't create the transcript Doc"
            ),
        )

    await store.advance(body.job_id, ["generating_doc"], "emailing", {})

    # --- Email (at most once; duplicate-on-crash is the documented accepted risk) ---
    current = await store.get(body.job_id)
    if current and not current.get("emailSentAt"):
        await store.update(body.job_id, {"emailSending": True})
        name = job["name"]
        duration = docgen.format_clock(int(transcript.get("audio_duration", 0)) * 1000)
        recording_url = _drive_url(job["driveFileId"])
        doc_url = _doc_url(doc_id)
        try:
            await sender.send(
                access_token=access_token,
                to=job.get("userEmail", ""),
                subject=f"Your recording “{name}” is ready",
                text=(
                    f"“{name}” has been transcribed.\n\n"
                    f"Recording: {recording_url}\nTranscript: {doc_url}\nDuration: {duration}\n"
                ),
                html=(
                    f"<p><b>{name}</b> has been transcribed.</p>"
                    f'<p><a href="{recording_url}">Recording</a> · '
                    f'<a href="{doc_url}">Transcript</a> · {duration}</p>'
                ),
                job_id=body.job_id,
            )
        except EmailError as error:
            # No failure email here: if Gmail is refusing sends, it would fail too.
            return await _fail(store, body.job_id, "EMAIL_FAILED", str(error))
        await store.update(body.job_id, {"emailSentAt": now_iso()})

    await store.advance(body.job_id, ["emailing"], "completed", {})
    return {"ok": True}
