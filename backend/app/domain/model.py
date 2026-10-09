from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

LocalStatus = Literal[
    "recording",
    "pending_upload",
    "uploading",
    "uploaded",
    "queued_for_transcription",
    "transcribing",
    "completed",
    "failed",
    "needs_sign_in",
]

RemoteStatus = Literal[
    "queued",
    "extracting_audio",
    "transcribing",
    "generating_doc",
    "emailing",
    "completed",
    "failed",
]

Mode = Literal["video", "audio"]

EventType = Literal[
    "RECORDING_FINISHED",
    "RECORDING_FAILED",
    "UPLOAD_STARTED",
    "UPLOAD_PROGRESS",
    "UPLOAD_COMPLETED",
    "JOB_ENQUEUED",
    "EXTRACT_STARTED",
    "EXTRACT_COMPLETED",
    "TRANSCRIPT_SUBMITTED",
    "TRANSCRIPT_COMPLETED",
    "DOC_CREATED",
    "EMAIL_SENT",
    "STAGE_FAILED",
    "AUTH_REQUIRED",
    "SIGNED_IN",
    "RETRY",
]


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Sources(CamelModel):
    tab: bool
    mic: bool


class StageDone(CamelModel):
    completed_at: str


class Stages(CamelModel):
    upload: StageDone | None = None
    extract_audio: StageDone | None = None
    transcribe: StageDone | None = None
    generate_doc: StageDone | None = None
    email: StageDone | None = None


class JobError(CamelModel):
    code: str
    message: str
    retryable: bool


class Job(CamelModel):
    job_id: str
    name: str
    created_at: str
    mode: Mode
    sources: Sources
    local_status: LocalStatus
    remote_status: RemoteStatus | None = None
    uploaded_bytes: int = 0
    total_bytes: int | None = None
    segment_count: int = 0
    recovered: bool = False
    drive_session_uri: str | None = None
    drive_file_id: str | None = None
    drive_folder_id: str | None = None
    doc_id: str | None = None
    transcript_id: str | None = None
    attempts: int = 0
    next_retry_at: str | None = None
    last_error: JobError | None = None
    stages: Stages = Stages()


class Event(CamelModel):
    type: EventType
    occurred_at: str
    total_bytes: int | None = None
    recovered: bool | None = None
    uploaded_bytes: int | None = None
    drive_file_id: str | None = None
    transcript_id: str | None = None
    doc_id: str | None = None
    code: str | None = None
    message: str | None = None
    retryable: bool | None = None
