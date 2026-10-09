"""Pure job state machine, mirrored by extension/src/lib/state/transition.ts.

Both implementations must pass shared/fixtures/transitions.json. Keep them in
lockstep: any rule change happens in the fixtures first, then in both languages.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .model import Event, Job, JobError, LocalStatus, RemoteStatus, StageDone

_LOCAL_ORDER = [
    "recording",
    "pending_upload",
    "uploading",
    "uploaded",
    "queued_for_transcription",
    "transcribing",
    "completed",
]

_REMOTE_ORDER = [
    "queued",
    "extracting_audio",
    "transcribing",
    "generating_doc",
    "emailing",
    "completed",
]

BACKOFF_BASE_SECONDS = 30
BACKOFF_CAP_SECONDS = 1800
MAX_AUTO_ATTEMPTS = 10


def transition(job: Job, event: Event) -> Job:
    # completed is absorbing: a late webhook or retry can never move the job backward
    if job.local_status == "completed":
        return job
    if job.local_status == "failed" and event.type != "RETRY":
        return job
    if job.local_status == "needs_sign_in" and event.type != "SIGNED_IN":
        return job
    if job.local_status == "recording" and event.type not in (
        "RECORDING_FINISHED",
        "RECORDING_FAILED",
    ):
        return job
    return _HANDLERS[event.type](job, event)


def _local_rank(status: str) -> int:
    return _LOCAL_ORDER.index(status)


def _remote_rank(status: str) -> int:
    return _REMOTE_ORDER.index(status)


def _advance_local(current: str, candidate: str) -> LocalStatus:
    return candidate if _local_rank(candidate) > _local_rank(current) else current  # type: ignore[return-value]


def _advance_remote(current: str | None, candidate: str) -> RemoteStatus:
    if current is None or _remote_rank(candidate) > _remote_rank(current):
        return candidate  # type: ignore[return-value]
    return current  # type: ignore[return-value]


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _format_ts(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _next_retry_at(occurred_at: str, attempts: int) -> str:
    delay = min(BACKOFF_BASE_SECONDS * 2 ** (attempts - 1), BACKOFF_CAP_SECONDS)
    return _format_ts(_parse_ts(occurred_at) + timedelta(seconds=delay))


_CLEARED = {"attempts": 0, "last_error": None, "next_retry_at": None}


def _resume_remote(job: Job) -> RemoteStatus:
    stages = job.stages
    if stages.extract_audio is None:
        return "queued"
    if stages.transcribe is None:
        return "transcribing"
    if stages.generate_doc is None:
        return "generating_doc"
    if stages.email is None:
        return "emailing"
    return "completed"


def _resume_local(job: Job, remote: RemoteStatus | None) -> LocalStatus:
    if job.stages.upload is None:
        return "uploading" if job.drive_session_uri else "pending_upload"
    if remote is None:
        return "uploaded"
    if remote == "queued":
        return "queued_for_transcription"
    if remote in ("extracting_audio", "transcribing", "generating_doc", "emailing"):
        return "transcribing"
    if remote == "completed":
        return "completed"
    return "failed"


def _recording_finished(job: Job, event: Event) -> Job:
    if job.local_status != "recording":
        return job
    update: dict = {"local_status": "pending_upload"}
    if event.total_bytes is not None:
        update["total_bytes"] = event.total_bytes
    if event.recovered:
        update["recovered"] = True
    return job.model_copy(update=update)


def _recording_failed(job: Job, event: Event) -> Job:
    if job.local_status != "recording":
        return job
    return job.model_copy(
        update={
            "local_status": "failed",
            "last_error": JobError(
                code=event.code or "RECORDING_ERROR",
                message=event.message or "",
                retryable=False,
            ),
        }
    )


def _upload_started(job: Job, event: Event) -> Job:
    if _local_rank(job.local_status) >= _local_rank("uploading"):
        return job
    return job.model_copy(update={"local_status": "uploading"})


def _upload_progress(job: Job, event: Event) -> Job:
    if job.local_status != "uploading" or event.uploaded_bytes is None:
        return job
    if event.uploaded_bytes <= job.uploaded_bytes:
        return job
    return job.model_copy(update={"uploaded_bytes": event.uploaded_bytes})


def _upload_completed(job: Job, event: Event) -> Job:
    if _local_rank(job.local_status) >= _local_rank("uploaded"):
        return job
    update: dict = {
        "local_status": "uploaded",
        "drive_file_id": event.drive_file_id,
        "stages": job.stages.model_copy(
            update={"upload": StageDone(completed_at=event.occurred_at)}
        ),
        **_CLEARED,
    }
    if job.total_bytes is not None:
        update["uploaded_bytes"] = job.total_bytes
    return job.model_copy(update=update)


def _job_enqueued(job: Job, event: Event) -> Job:
    if job.stages.upload is None:
        return job
    if _local_rank(job.local_status) >= _local_rank("queued_for_transcription"):
        return job
    return job.model_copy(
        update={
            "local_status": "queued_for_transcription",
            "remote_status": _advance_remote(job.remote_status, "queued"),
            **_CLEARED,
        }
    )


def _extract_started(job: Job, event: Event) -> Job:
    if job.remote_status is not None and _remote_rank(job.remote_status) >= _remote_rank(
        "extracting_audio"
    ):
        return job
    return job.model_copy(
        update={
            "remote_status": "extracting_audio",
            "local_status": _advance_local(job.local_status, "transcribing"),
            **_CLEARED,
        }
    )


def _extract_completed(job: Job, event: Event) -> Job:
    if job.stages.extract_audio is not None:
        return job
    return job.model_copy(
        update={
            "stages": job.stages.model_copy(
                update={"extract_audio": StageDone(completed_at=event.occurred_at)}
            ),
            "remote_status": _advance_remote(job.remote_status, "extracting_audio"),
            "local_status": _advance_local(job.local_status, "transcribing"),
            **_CLEARED,
        }
    )


def _transcript_submitted(job: Job, event: Event) -> Job:
    if job.remote_status is not None and _remote_rank(job.remote_status) >= _remote_rank(
        "transcribing"
    ):
        return job
    return job.model_copy(
        update={
            "remote_status": "transcribing",
            "transcript_id": event.transcript_id,
            "local_status": _advance_local(job.local_status, "transcribing"),
            **_CLEARED,
        }
    )


def _transcript_completed(job: Job, event: Event) -> Job:
    if job.stages.transcribe is not None:
        return job
    return job.model_copy(
        update={
            "stages": job.stages.model_copy(
                update={"transcribe": StageDone(completed_at=event.occurred_at)}
            ),
            "remote_status": _advance_remote(job.remote_status, "generating_doc"),
            "local_status": _advance_local(job.local_status, "transcribing"),
            **_CLEARED,
        }
    )


def _doc_created(job: Job, event: Event) -> Job:
    if job.stages.generate_doc is not None:
        return job
    return job.model_copy(
        update={
            "doc_id": event.doc_id,
            "stages": job.stages.model_copy(
                update={"generate_doc": StageDone(completed_at=event.occurred_at)}
            ),
            "remote_status": _advance_remote(job.remote_status, "emailing"),
            "local_status": _advance_local(job.local_status, "transcribing"),
            **_CLEARED,
        }
    )


def _email_sent(job: Job, event: Event) -> Job:
    if job.stages.email is not None:
        return job
    return job.model_copy(
        update={
            "stages": job.stages.model_copy(
                update={"email": StageDone(completed_at=event.occurred_at)}
            ),
            "remote_status": "completed",
            "local_status": "completed",
            **_CLEARED,
        }
    )


def _stage_failed(job: Job, event: Event) -> Job:
    error = JobError(
        code=event.code or "UNKNOWN",
        message=event.message or "",
        retryable=bool(event.retryable),
    )
    if event.retryable:
        attempts = job.attempts + 1
        if attempts >= MAX_AUTO_ATTEMPTS:
            update_exhausted: dict = {
                "last_error": error,
                "attempts": attempts,
                "next_retry_at": None,
                "local_status": "failed",
            }
            if job.remote_status is not None:
                update_exhausted["remote_status"] = "failed"
            return job.model_copy(update=update_exhausted)
        return job.model_copy(
            update={
                "last_error": error,
                "attempts": attempts,
                "next_retry_at": _next_retry_at(event.occurred_at, attempts),
            }
        )
    update: dict = {"last_error": error, "local_status": "failed"}
    if job.remote_status is not None:
        update["remote_status"] = "failed"
    return job.model_copy(update=update)


def _auth_required(job: Job, event: Event) -> Job:
    return job.model_copy(update={"local_status": "needs_sign_in"})


def _signed_in(job: Job, event: Event) -> Job:
    if job.local_status != "needs_sign_in":
        return job
    return job.model_copy(
        update={"local_status": _resume_local(job, job.remote_status), **_CLEARED}
    )


def _retry(job: Job, event: Event) -> Job:
    if job.local_status != "failed":
        return job
    remote = _resume_remote(job) if job.remote_status is not None else None
    return job.model_copy(
        update={
            "local_status": _resume_local(job, remote),
            "remote_status": remote,
            **_CLEARED,
        }
    )


_HANDLERS = {
    "RECORDING_FINISHED": _recording_finished,
    "RECORDING_FAILED": _recording_failed,
    "UPLOAD_STARTED": _upload_started,
    "UPLOAD_PROGRESS": _upload_progress,
    "UPLOAD_COMPLETED": _upload_completed,
    "JOB_ENQUEUED": _job_enqueued,
    "EXTRACT_STARTED": _extract_started,
    "EXTRACT_COMPLETED": _extract_completed,
    "TRANSCRIPT_SUBMITTED": _transcript_submitted,
    "TRANSCRIPT_COMPLETED": _transcript_completed,
    "DOC_CREATED": _doc_created,
    "EMAIL_SENT": _email_sent,
    "STAGE_FAILED": _stage_failed,
    "AUTH_REQUIRED": _auth_required,
    "SIGNED_IN": _signed_in,
    "RETRY": _retry,
}
