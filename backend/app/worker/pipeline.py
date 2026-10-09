"""Audio extraction: Drive byte stream -> ffmpeg stdin -> small opus .ogg.
The video is never written to disk; only the ~40 MB audio output lands in
/tmp (which is RAM on Cloud Run — fine for audio, never for video)."""

import asyncio
from typing import AsyncIterator


class ExtractionError(Exception):
    pass


async def extract_audio_to_ogg(
    chunks: AsyncIterator[bytes],
    channels: int,
    out_path: str,
) -> None:
    process = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        "pipe:0",
        "-vn",
        "-ac",
        str(max(1, min(channels, 2))),
        "-c:a",
        "libopus",
        "-b:a",
        "48k",
        "-f",
        "ogg",
        out_path,
        stdin=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert process.stdin is not None

    try:
        async for chunk in chunks:
            process.stdin.write(chunk)
            await process.stdin.drain()
        process.stdin.close()
    except (BrokenPipeError, ConnectionResetError):
        pass  # ffmpeg exited early; its stderr below explains why

    _, stderr = await process.communicate()
    if process.returncode != 0:
        raise ExtractionError(f"ffmpeg exited {process.returncode}: {stderr.decode()[:300]}")
