from fastapi import APIRouter, Depends, HTTPException, Query

from app.adapters import drive
from app.adapters.google_oauth import GoogleOAuthClient
from app.adapters.store import JobDoc, JobStore, now_iso
from app.adapters.tasks import TaskQueue, task_name
from app.adapters.users import UserStore
from app.api.deps import (
    CurrentUser,
    get_current_user,
    get_job_store,
    get_oauth_client,
    get_settings,
    get_task_queue,
    get_user_store,
    mint_user_access_token,
)
from app.domain.model import CamelModel
from app.settings import Settings

router = APIRouter(prefix="/v1/jobs", tags=["jobs"])

# Resume ladder: first stage whose artifact is missing is where retry restarts.
STAGE_QUEUES = {"extract": "extract", "transcribe-submit": "transcribe-submit", "finalize": "finalize"}


class CreateJobRequest(CamelModel):
    job_id: str
    drive_file_id: str
    name: str
    created_at: str
    channels: int


class JobStatus(CamelModel):
    job_id: str
    remote_status: str
    transcript_id: str | None = None
    doc_id: str | None = None
    error: dict | None = None


def to_status(doc: JobDoc) -> JobStatus:
    return JobStatus(
        job_id=doc["jobId"],
        remote_status=doc.get("remoteStatus", "queued"),
        transcript_id=doc.get("transcriptId"),
        doc_id=doc.get("docId"),
        error=doc.get("error"),
    )


@router.post("", response_model=JobStatus, response_model_by_alias=True)
async def create_job(
    body: CreateJobRequest,
    user: CurrentUser = Depends(get_current_user),
    store: JobStore = Depends(get_job_store),
    tasks: TaskQueue = Depends(get_task_queue),
    users: UserStore = Depends(get_user_store),
    oauth: GoogleOAuthClient = Depends(get_oauth_client),
    settings: Settings = Depends(get_settings),
) -> JobStatus:
    # The file must be visible to the caller's drive.file grant AND carry this
    # job's UUID in appProperties — proves "this user's upload for this job".
    access_token = await mint_user_access_token(user.sub, users, oauth, settings)
    metadata = await drive.get_file_metadata(access_token, body.drive_file_id)
    if metadata is None:
        raise HTTPException(status_code=404, detail="Drive file not found")
    if (metadata.get("appProperties") or {}).get("jobId") != body.job_id:
        raise HTTPException(status_code=403, detail="Drive file does not belong to this job")

    doc = await store.create(
        {
            "jobId": body.job_id,
            "userSub": user.sub,
            "userEmail": user.email,
            "name": body.name,
            "createdAt": body.created_at,
            "driveFileId": body.drive_file_id,
            "channels": body.channels,
            "remoteStatus": "queued",
            "generation": 0,
            "transcriptId": None,
            "audioGcsUri": None,
            "docId": None,
            "error": None,
            "registeredAt": now_iso(),
        }
    )

    await tasks.enqueue(
        queue="extract",
        path="/tasks/extract",
        payload={"jobId": body.job_id},
        name=task_name("extract", body.job_id, int(doc.get("generation", 0))),
    )
    return to_status(doc)


@router.get("", response_model=dict, response_model_by_alias=True)
async def list_jobs(
    ids: str = Query(default=""),
    user: CurrentUser = Depends(get_current_user),
    store: JobStore = Depends(get_job_store),
) -> dict:
    job_ids = [i for i in ids.split(",") if i][:50]
    docs = await store.get_many(job_ids)
    visible = [doc for doc in docs if doc.get("userSub") == user.sub]
    return {"jobs": [to_status(doc).model_dump(by_alias=True) for doc in visible]}


@router.post("/{job_id}/retry", response_model=JobStatus, response_model_by_alias=True)
async def retry_job(
    job_id: str,
    user: CurrentUser = Depends(get_current_user),
    store: JobStore = Depends(get_job_store),
    tasks: TaskQueue = Depends(get_task_queue),
) -> JobStatus:
    doc = await store.get(job_id)
    if doc is None or doc.get("userSub") != user.sub:
        raise HTTPException(status_code=404, detail="Job not found")
    # Manual retry is allowed from any non-completed state: `failed` is the
    # normal case, but a job can also wedge mid-stage when a task exhausts its
    # queue attempts — retry is the documented recovery path for both.
    if doc.get("remoteStatus") == "completed":
        return to_status(doc)

    if not doc.get("audioGcsUri"):
        stage, new_state = "extract", "queued"
    elif not doc.get("transcriptId"):
        stage, new_state = "transcribe-submit", "extracting_audio"
    else:
        stage, new_state = "finalize", "generating_doc"

    generation = int(doc.get("generation", 0)) + 1
    moved = await store.advance(
        job_id, [doc.get("remoteStatus")], new_state, {"generation": generation, "error": None}
    )
    if not moved:
        return to_status((await store.get(job_id)) or doc)

    await tasks.enqueue(
        queue=STAGE_QUEUES[stage],
        path=f"/tasks/{stage}",
        payload={"jobId": job_id},
        name=task_name(stage, job_id, generation),
    )
    return to_status((await store.get(job_id)) or doc)
