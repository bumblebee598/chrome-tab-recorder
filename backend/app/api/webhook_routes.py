from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.adapters.store import JobStore
from app.adapters.tasks import TaskQueue, task_name
from app.api.deps import get_job_store, get_settings, get_task_queue
from app.settings import Settings

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.post("/assemblyai")
async def assemblyai_webhook(
    request: Request,
    job: str = Query(default=""),
    store: JobStore = Depends(get_job_store),
    tasks: TaskQueue = Depends(get_task_queue),
    settings: Settings = Depends(get_settings),
) -> dict:
    # AssemblyAI retries unless we answer 2xx within 10s: verify, enqueue, return.
    provided = request.headers.get(settings.webhook_header_name, "")
    if not settings.webhook_secret or provided != settings.webhook_secret:
        raise HTTPException(status_code=401, detail="Bad webhook secret")

    body = await request.json()
    transcript_id = body.get("transcript_id", "")
    status = body.get("status", "")

    doc = await store.get(job) if job else None
    if doc is None and transcript_id:
        doc = await store.find_by_transcript(transcript_id)
    if doc is None:
        return {"ok": True}  # unknown job: ack so AssemblyAI stops retrying

    if transcript_id and doc.get("transcriptId") not in (None, transcript_id):
        return {"ok": True}  # stale webhook for a superseded transcript

    job_id = doc["jobId"]
    if status == "completed":
        await tasks.enqueue(
            queue="finalize",
            path="/tasks/finalize",
            payload={"jobId": job_id},
            name=task_name("finalize", job_id, int(doc.get("generation", 0))),
        )
    elif status == "error":
        await store.advance(
            job_id,
            ["transcribing", "extracting_audio", "queued"],
            "failed",
            {"error": {"code": "TRANSCRIPT_ERROR", "message": "AssemblyAI reported an error"}},
        )
    return {"ok": True}
