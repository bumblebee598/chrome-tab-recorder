# Large-file validation (Part D)

Evidence for the 2-hour claim. Synthetic media comes from `scripts/gen_synthetic.sh`;
it enters the real pipeline via the dashboard's **Import file (debug)** action
(slices any webm into 8 MiB OPFS segments and queues it exactly like a recording).

## Measured results

| Test | Input | Stage | Result | Measured on |
| --- | --- | --- | --- | --- |
| 2h stereo audio extraction (`RUN_LOAD_TESTS=1 uv run pytest tests/load -s`) | 153 MB webm (opus 128k, 7200s) | ffmpeg pipeline (`extract_audio_to_ogg`, 16 MiB chunks) | **43 s**, output 68.6 MB ogg¹, RSS: python 79 MB / ffmpeg 16 MB | 2026-10-09, M-series MacBook |
| Synthetic generation speed | `gen_synthetic.sh 7200 audio` | — | 62 s | same |
| 1h synthetic video → Drive upload (2h scaled: disk allowed 1.2 GB × 2 copies) | `gen_synthetic.sh 3600 video` (1.2 GB) | dashboard import → OPFS → Drive resumable | uploaded completely; **exactly one Drive file**; local copy auto-deleted after size verification (which doubles as the integrity check) | 2026-10-12, residential uplink |
| Network-drop resume | 1.2 GB upload in flight | Wi-Fi off 60 s at **6% (67 MB)** | status showed "Connection lost · attempt 1"; resumed **from 6%**, not zero; single Drive file | 2026-10-12 |
| Real recording 60 min, full pipeline | real tab+mic recording (~780 MB ≈ **13 MB/min**) | record → Drive → transcript → Doc → email | full pipeline completed unattended; email + Doc delivered | 2026-10-12 |
| Service-worker kill mid-upload | OS-level `kill` of the extension process | upload | covered by automated resume tests (`driveUpload.test.ts` probe/offset cases); two live kill attempts were outrun by the upload finishing first — noted honestly | 2026-10-12 |
| 2h two-speaker speech → transcription | TTS-generated stereo speech (135 MB, L/R speakers) | import → extract → AssemblyAI → Doc | _in progress_ | _pending_ |

¹ Synthetic sine tones make opus VBR overshoot its 48k nominal; real speech lands near
~43 MB for 2h. Either size is far below AssemblyAI's 5 GB limit and trivially held in
Cloud Run memory.

## Why the 2-hour claim holds (measured + by construction)

- **Extraction is ~170× realtime** on a laptop (43 s for 7200 s of audio); the Cloud Run
  worker has a 30-minute task budget — two orders of magnitude of headroom.
- **Memory is flat**: the video streams Drive→ffmpeg in 16 MiB chunks (never written to
  disk); ffmpeg held 16 MB RSS. Only the ~40–70 MB audio output touches /tmp (RAM-backed,
  2 GiB available).
- **Upload scales by construction**: 8 MiB chunks with the offset persisted after each —
  a 2.3 GB upload is just ~290 iterations of the same tested loop, resumable at any point.
- **AssemblyAI limits**: 2h stereo audio ≈ 43–70 MB via signed URL — far under the 5 GB /
  10h caps; async API, so duration never holds a connection open.

## How to reproduce

```sh
# 1. Backend extraction benchmark (included in repo, excluded from normal CI)
cd backend && RUN_LOAD_TESTS=1 uv run pytest tests/load -s
# shorter variant: LOAD_TEST_DURATION_S=1800

# 2. Generate a 2-hour synthetic video (~2.3 GB, encodes in minutes)
./scripts/gen_synthetic.sh 7200 video /tmp/two-hour.webm

# 3. Feed it through the real product
#    dashboard -> "Import file (debug)" -> pick /tmp/two-hour.webm
#    watch: Uploading (with byte progress) -> ... -> Completed + email

# 4. Resilience during step 3: toggle Wi-Fi off/on; kill the service worker.
#    Success = exactly one file in Drive, pipeline completes anyway.
```
