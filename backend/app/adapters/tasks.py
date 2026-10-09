"""Cloud Tasks HTTP tasks with explicit hashed names: {stage}-{sha256(jobId)[:16]}
-g{generation}. Name-based dedup means a double enqueue (replayed request,
webhook + poll race) collapses into one delivery; ALREADY_EXISTS is success."""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol


def job_hash(job_id: str) -> str:
    return hashlib.sha256(job_id.encode()).hexdigest()[:16]


def task_name(stage: str, job_id: str, generation: int, suffix: str = "") -> str:
    return f"{stage}-{job_hash(job_id)}-g{generation}{suffix}"


class TaskQueue(Protocol):
    async def enqueue(
        self,
        queue: str,
        path: str,
        payload: dict[str, Any],
        name: str,
        delay_seconds: int = 0,
    ) -> None: ...


class CloudTasksQueue:
    def __init__(
        self,
        project: str,
        location: str,
        worker_base_url: str,
        emulator_host: str | None = None,
        invoker_service_account: str | None = None,
    ):
        from google.cloud import tasks_v2

        self._tasks_v2 = tasks_v2
        self._project = project
        self._location = location
        self._worker_base_url = worker_base_url.rstrip("/")
        self._invoker = invoker_service_account

        if emulator_host:
            import grpc
            from google.cloud.tasks_v2.services.cloud_tasks.transports import (
                CloudTasksGrpcTransport,
            )

            channel = grpc.insecure_channel(emulator_host)
            self._client = tasks_v2.CloudTasksClient(
                transport=CloudTasksGrpcTransport(channel=channel)
            )
        else:
            self._client = tasks_v2.CloudTasksClient()

    async def enqueue(
        self,
        queue: str,
        path: str,
        payload: dict[str, Any],
        name: str,
        delay_seconds: int = 0,
    ) -> None:
        import asyncio

        from google.api_core.exceptions import AlreadyExists

        parent = self._client.queue_path(self._project, self._location, queue)
        task: dict[str, Any] = {
            "name": f"{parent}/tasks/{name}",
            "http_request": {
                "http_method": self._tasks_v2.HttpMethod.POST,
                "url": f"{self._worker_base_url}{path}",
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps(payload).encode(),
            },
        }
        if self._invoker:
            task["http_request"]["oidc_token"] = {"service_account_email": self._invoker}
        if delay_seconds > 0:
            eta = datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)
            task["schedule_time"] = eta

        def create() -> None:
            try:
                self._client.create_task(parent=parent, task=task)
            except AlreadyExists:
                pass  # name-based dedup: someone already enqueued this exact stage attempt

        await asyncio.to_thread(create)
