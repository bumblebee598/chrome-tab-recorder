"""Drive access on behalf of the user (drive.file scope): metadata checks for
job registration and Range-chunked media streaming for audio extraction.
The video never touches a server disk — chunks stream straight into ffmpeg."""

import asyncio
from typing import Any, AsyncIterator

import httpx

FILES_URL = "https://www.googleapis.com/drive/v3/files"
RANGE_CHUNK_BYTES = 16 * 1024 * 1024
MAX_CHUNK_RETRIES = 3


class DriveError(Exception):
    pass


async def get_file_metadata(access_token: str, file_id: str) -> dict[str, Any] | None:
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.get(
            f"{FILES_URL}/{file_id}",
            params={"fields": "id,name,size,parents,appProperties"},
            headers={"Authorization": f"Bearer {access_token}"},
        )
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise DriveError(f"Drive metadata failed: HTTP {response.status_code}")
    return response.json()


async def stream_file(access_token: str, file_id: str) -> AsyncIterator[bytes]:
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(120, read=300)) as client:
        meta = await client.get(
            f"{FILES_URL}/{file_id}", params={"fields": "size"}, headers=headers
        )
        if meta.status_code != 200:
            raise DriveError(f"Drive size lookup failed: HTTP {meta.status_code}")
        size = int(meta.json()["size"])

        offset = 0
        while offset < size:
            end = min(offset + RANGE_CHUNK_BYTES, size) - 1
            chunk = await _fetch_range(client, file_id, headers, offset, end)
            yield chunk
            offset = end + 1


async def _fetch_range(
    client: httpx.AsyncClient,
    file_id: str,
    headers: dict[str, str],
    start: int,
    end: int,
) -> bytes:
    last_status = 0
    for attempt in range(MAX_CHUNK_RETRIES):
        response = await client.get(
            f"{FILES_URL}/{file_id}",
            params={"alt": "media"},
            headers={**headers, "Range": f"bytes={start}-{end}"},
        )
        if response.status_code in (200, 206):
            return response.content
        last_status = response.status_code
        if response.status_code < 500 and response.status_code != 429:
            break  # auth/permission problems do not heal with retries
        await asyncio.sleep(2**attempt)
    raise DriveError(f"Drive range read failed after retries: HTTP {last_status}")
