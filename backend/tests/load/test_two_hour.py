"""Load evidence for docs/VALIDATION.md. Not part of the normal suite:

    RUN_LOAD_TESTS=1 uv run pytest tests/load -s
    RUN_LOAD_TESTS=1 LOAD_TEST_DURATION_S=1800 uv run pytest tests/load -s
"""

import asyncio
import os
import platform
import resource
import subprocess
import sys
import time
from pathlib import Path

import pytest

from app.worker.pipeline import extract_audio_to_ogg

pytestmark = pytest.mark.skipif(
    not os.environ.get("RUN_LOAD_TESTS"), reason="set RUN_LOAD_TESTS=1 to run load tests"
)

DURATION_S = int(os.environ.get("LOAD_TEST_DURATION_S", "7200"))


def _rss_mb(usage: resource.struct_rusage) -> float:
    divisor = 1024**2 if platform.system() == "Darwin" else 1024  # bytes vs KiB
    return usage.ru_maxrss / divisor


def test_long_recording_extracts_within_budget(tmp_path: Path):
    source = tmp_path / "long.webm"
    gen_start = time.monotonic()
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={DURATION_S}",
            "-f", "lavfi", "-i", f"sine=frequency=880:duration={DURATION_S}",
            "-filter_complex", "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]",
            "-map", "[a]", "-c:a", "libopus", "-b:a", "128k", str(source),
        ],
        check=True,
    )
    generation_s = time.monotonic() - gen_start
    source_mb = source.stat().st_size / 1e6

    out = tmp_path / "out.ogg"

    async def chunks():
        with source.open("rb") as fh:
            while blob := fh.read(16 * 1024 * 1024):
                yield blob

    extract_start = time.monotonic()
    asyncio.run(extract_audio_to_ogg(chunks(), channels=2, out_path=str(out)))
    extract_s = time.monotonic() - extract_start

    out_mb = out.stat().st_size / 1e6
    print(
        f"\n[VALIDATION] duration={DURATION_S}s source={source_mb:.1f}MB "
        f"generated_in={generation_s:.0f}s extracted_in={extract_s:.0f}s "
        f"output={out_mb:.1f}MB "
        f"rss_self={_rss_mb(resource.getrusage(resource.RUSAGE_SELF)):.0f}MB "
        f"rss_children(ffmpeg)={_rss_mb(resource.getrusage(resource.RUSAGE_CHILDREN)):.0f}MB",
        file=sys.stderr,
    )

    # 48 kbit/s nominal opus; VBR overshoots on synthetic sines (real speech
    # lands near nominal), so the bound only guards against gross size bugs.
    expected_mb = DURATION_S * 48_000 / 8 / 1e6
    assert 0.5 * expected_mb < out_mb < 2.5 * expected_mb
