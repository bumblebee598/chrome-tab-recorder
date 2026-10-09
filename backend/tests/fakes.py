from typing import Any

from app.adapters.store import JobDoc, now_iso


class InMemoryJobStore:
    def __init__(self) -> None:
        self.docs: dict[str, JobDoc] = {}

    async def create(self, doc: JobDoc) -> JobDoc:
        if doc["jobId"] in self.docs:
            return self.docs[doc["jobId"]]
        self.docs[doc["jobId"]] = {**doc, "updatedAt": now_iso()}
        return doc

    async def get(self, job_id: str) -> JobDoc | None:
        return self.docs.get(job_id)

    async def get_many(self, job_ids: list[str]) -> list[JobDoc]:
        return [self.docs[i] for i in job_ids if i in self.docs]

    async def find_by_transcript(self, transcript_id: str) -> JobDoc | None:
        for doc in self.docs.values():
            if doc.get("transcriptId") == transcript_id:
                return doc
        return None

    async def update(self, job_id: str, patch: JobDoc) -> None:
        self.docs[job_id].update(patch)

    async def advance(
        self, job_id: str, expected: list[str], new_state: str, patch: JobDoc
    ) -> bool:
        doc = self.docs.get(job_id)
        if doc is None or doc.get("remoteStatus") not in expected:
            return False
        doc.update({**patch, "remoteStatus": new_state})
        return True

    async def set_transcript_once(self, job_id: str, transcript_id: str) -> bool:
        doc = self.docs.get(job_id)
        if doc is None or doc.get("transcriptId"):
            return False
        doc["transcriptId"] = transcript_id
        return True


class FakeTaskQueue:
    def __init__(self) -> None:
        self.tasks: list[dict[str, Any]] = []
        self._names: set[str] = set()

    async def enqueue(
        self,
        queue: str,
        path: str,
        payload: dict[str, Any],
        name: str,
        delay_seconds: int = 0,
    ) -> None:
        if name in self._names:
            return  # ALREADY_EXISTS -> success, exactly like Cloud Tasks
        self._names.add(name)
        self.tasks.append(
            {"queue": queue, "path": path, "payload": payload, "name": name, "delay": delay_seconds}
        )


class FakeAudioStorage:
    def __init__(self) -> None:
        self.uploads: list[tuple[str, str]] = []

    async def upload_file(self, local_path: str, blob_name: str, content_type: str) -> str:
        self.uploads.append((local_path, blob_name))
        return f"gs://test-bucket/{blob_name}"

    async def signed_url(self, blob_name: str, hours: int = 24) -> str:
        return f"https://signed.test/{blob_name}"


class FakeDocsClient:
    def __init__(self, existing: str | None = None, end_index: int = 1) -> None:
        self.existing = existing
        self.end_index = end_index
        self.created: list[dict[str, Any]] = []
        self.batches: list[list[dict[str, Any]]] = []

    async def find_doc(self, access_token: str, job_id: str) -> str | None:
        return self.existing

    async def create_doc(
        self, access_token: str, name: str, folder_id: str | None, job_id: str
    ) -> str:
        self.created.append({"name": name, "folderId": folder_id, "jobId": job_id})
        return "doc-new-1"

    async def get_end_index(self, access_token: str, doc_id: str) -> int:
        return self.end_index

    async def batch_update(
        self, access_token: str, doc_id: str, requests: list[dict[str, Any]]
    ) -> None:
        self.batches.append(requests)


class FakeEmailSender:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, access_token: str, to: str, subject: str, text: str, html: str, job_id: str) -> None:
        self.sent.append({"to": to, "subject": subject, "text": text, "jobId": job_id})


class FakeTranscriber:
    def __init__(self, status: str = "processing") -> None:
        self.submissions: list[dict[str, Any]] = []
        self.status = status

    async def submit(self, **kwargs: Any) -> str:
        self.submissions.append(kwargs)
        return "tr-fake-1"

    async def fetch(self, transcript_id: str) -> dict[str, Any]:
        return {
            "id": transcript_id,
            "status": self.status,
            "error": "boom",
            "audio_duration": 7200,
            "text": "Hello world from the recording.",
            "utterances": [
                {"channel": "1", "speaker": "1", "start": 0, "text": "Hello from the tab."},
                {"channel": "2", "speaker": "2", "start": 2500, "text": "And this is me talking."},
            ],
        }
