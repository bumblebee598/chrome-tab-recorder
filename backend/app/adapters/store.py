"""Firestore job records. Document ID = jobId (client-generated UUID), so
creation is naturally idempotent. All status moves go through the advance()
compare-and-set so replayed Cloud Tasks deliveries and late webhooks can
never move a job backward."""

from datetime import datetime, timezone
from typing import Any, Protocol

JobDoc = dict[str, Any]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class JobStore(Protocol):
    async def create(self, doc: JobDoc) -> JobDoc:
        """Create the document; on AlreadyExists return the stored one unchanged."""
        ...

    async def get(self, job_id: str) -> JobDoc | None: ...

    async def get_many(self, job_ids: list[str]) -> list[JobDoc]: ...

    async def find_by_transcript(self, transcript_id: str) -> JobDoc | None: ...

    async def update(self, job_id: str, patch: JobDoc) -> None: ...

    async def advance(
        self, job_id: str, expected: list[str], new_state: str, patch: JobDoc
    ) -> bool:
        """Compare-and-set remoteStatus; False when the job is not in `expected`."""
        ...

    async def set_transcript_once(self, job_id: str, transcript_id: str) -> bool:
        """Record the transcript ID only if none is set yet (double-submit guard)."""
        ...


class FirestoreJobStore:
    def __init__(self, project: str):
        from google.cloud import firestore

        self._firestore = firestore
        self._client = firestore.AsyncClient(project=project)

    def _doc(self, job_id: str):
        return self._client.collection("jobs").document(job_id)

    async def create(self, doc: JobDoc) -> JobDoc:
        from google.api_core.exceptions import AlreadyExists

        try:
            await self._doc(doc["jobId"]).create({**doc, "updatedAt": now_iso()})
            return doc
        except AlreadyExists:
            existing = await self.get(doc["jobId"])
            assert existing is not None
            return existing

    async def get(self, job_id: str) -> JobDoc | None:
        snapshot = await self._doc(job_id).get()
        return snapshot.to_dict() if snapshot.exists else None

    async def get_many(self, job_ids: list[str]) -> list[JobDoc]:
        docs = []
        for job_id in job_ids:
            doc = await self.get(job_id)
            if doc is not None:
                docs.append(doc)
        return docs

    async def find_by_transcript(self, transcript_id: str) -> JobDoc | None:
        from google.cloud.firestore_v1.base_query import FieldFilter

        query = (
            self._client.collection("jobs")
            .where(filter=FieldFilter("transcriptId", "==", transcript_id))
            .limit(1)
        )
        async for snapshot in query.stream():
            return snapshot.to_dict()
        return None

    async def update(self, job_id: str, patch: JobDoc) -> None:
        await self._doc(job_id).update({**patch, "updatedAt": now_iso()})

    async def advance(
        self, job_id: str, expected: list[str], new_state: str, patch: JobDoc
    ) -> bool:
        firestore = self._firestore
        transaction = self._client.transaction()
        ref = self._doc(job_id)

        @firestore.async_transactional
        async def run(tx) -> bool:
            snapshot = await ref.get(transaction=tx)
            if not snapshot.exists:
                return False
            data = snapshot.to_dict() or {}
            if data.get("remoteStatus") not in expected:
                return False
            tx.update(ref, {**patch, "remoteStatus": new_state, "updatedAt": now_iso()})
            return True

        return await run(transaction)

    async def set_transcript_once(self, job_id: str, transcript_id: str) -> bool:
        firestore = self._firestore
        transaction = self._client.transaction()
        ref = self._doc(job_id)

        @firestore.async_transactional
        async def run(tx) -> bool:
            snapshot = await ref.get(transaction=tx)
            if not snapshot.exists:
                return False
            if (snapshot.to_dict() or {}).get("transcriptId"):
                return False
            tx.update(ref, {"transcriptId": transcript_id, "updatedAt": now_iso()})
            return True

        return await run(transaction)
