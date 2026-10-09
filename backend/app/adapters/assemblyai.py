from typing import Any, Protocol

import httpx

API_BASE = "https://api.assemblyai.com/v2"


class TranscriptionClient(Protocol):
    async def submit(
        self,
        audio_url: str,
        channels: int,
        webhook_url: str,
        webhook_header_name: str,
        webhook_header_value: str,
    ) -> str: ...

    async def fetch(self, transcript_id: str) -> dict[str, Any]: ...


class AssemblyAIClient:
    def __init__(self, api_key: str):
        self._headers = {"authorization": api_key}

    async def submit(
        self,
        audio_url: str,
        channels: int,
        webhook_url: str,
        webhook_header_name: str,
        webhook_header_value: str,
    ) -> str:
        payload: dict[str, Any] = {
            "audio_url": audio_url,
            "speaker_labels": True,
            "multichannel": channels == 2,
            "webhook_url": webhook_url,
            "webhook_auth_header_name": webhook_header_name,
            "webhook_auth_header_value": webhook_header_value,
        }
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{API_BASE}/transcript", json=payload, headers=self._headers
            )
        response.raise_for_status()
        return response.json()["id"]

    async def fetch(self, transcript_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"{API_BASE}/transcript/{transcript_id}", headers=self._headers
            )
        response.raise_for_status()
        return response.json()
