"""Google Docs via the user's token: Drive files.create for the Doc shell
(appProperties.jobId makes retries find it instead of duplicating), Docs
batchUpdate for content. The Doc is created in the user's Drive, owned by
them — no sharing call needed."""

from typing import Any, Protocol

import httpx

DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"
DOCS_URL = "https://docs.googleapis.com/v1/documents"
DOC_MIME = "application/vnd.google-apps.document"


class DocsError(Exception):
    pass


class DocsClient(Protocol):
    async def find_doc(self, access_token: str, job_id: str) -> str | None: ...

    async def create_doc(
        self, access_token: str, name: str, folder_id: str | None, job_id: str
    ) -> str: ...

    async def get_end_index(self, access_token: str, doc_id: str) -> int: ...

    async def batch_update(
        self, access_token: str, doc_id: str, requests: list[dict[str, Any]]
    ) -> None: ...


class GoogleDocsClient:
    async def find_doc(self, access_token: str, job_id: str) -> str | None:
        query = (
            f"appProperties has {{ key='jobId' and value='{job_id}' }} "
            f"and mimeType='{DOC_MIME}' and trashed=false"
        )
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                DRIVE_FILES_URL,
                params={"q": query, "fields": "files(id)"},
                headers=self._auth(access_token),
            )
        if response.status_code != 200:
            raise DocsError(f"Doc lookup failed: HTTP {response.status_code}")
        files = response.json().get("files", [])
        return files[0]["id"] if files else None

    async def create_doc(
        self, access_token: str, name: str, folder_id: str | None, job_id: str
    ) -> str:
        body: dict[str, Any] = {
            "name": name,
            "mimeType": DOC_MIME,
            "appProperties": {"jobId": job_id},
        }
        if folder_id:
            body["parents"] = [folder_id]
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{DRIVE_FILES_URL}?fields=id",
                json=body,
                headers=self._auth(access_token),
            )
        if response.status_code != 200:
            raise DocsError(f"Doc create failed: HTTP {response.status_code}")
        return response.json()["id"]

    async def get_end_index(self, access_token: str, doc_id: str) -> int:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"{DOCS_URL}/{doc_id}",
                params={"fields": "body(content(endIndex))"},
                headers=self._auth(access_token),
            )
        if response.status_code != 200:
            raise DocsError(f"Doc read failed: HTTP {response.status_code}")
        content = response.json().get("body", {}).get("content", [])
        return int(content[-1]["endIndex"]) if content else 1

    async def batch_update(
        self, access_token: str, doc_id: str, requests: list[dict[str, Any]]
    ) -> None:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{DOCS_URL}/{doc_id}:batchUpdate",
                json={"requests": requests},
                headers=self._auth(access_token),
            )
        if response.status_code != 200:
            raise DocsError(
                f"batchUpdate failed: HTTP {response.status_code}: {response.text[:300]}"
            )

    @staticmethod
    def _auth(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}
