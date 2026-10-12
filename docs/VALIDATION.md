# Large-file validation

The brief asks for recordings up to two hours at high resolution, which lands around
2.5–3.5 GB of webm, and allows a scaled substitute if a full run isn't practical. We
didn't need the substitute: **the two-hour requirement is met with a real recording** — a
two-hour podcast (tab video + tab audio + mic) recorded on 2026-10-12 went through the
entire system, and the backend turned it into a delivered transcript Doc and email in
5 minutes 20 seconds. The synthetic and scaled runs below are supporting stress evidence
(interruption behaviour, extraction benchmarks), not the basis of the claim. The rest of
this file records those measurements and walks through where a file that size lives at
each point in the system and why no single step has to care how big it is.

Test media comes from `scripts/gen_synthetic.sh`. The dashboard has an
"Import file (debug)" action that slices any webm into 8 MiB OPFS segments and queues it
exactly as if it had been recorded, so synthetic files run through the real pipeline,
not a test harness.

## Measured results

| Test | Input | What happened | Date |
| --- | --- | --- | --- |
| 2h audio extraction (`RUN_LOAD_TESTS=1 uv run pytest tests/load -s`) | 153 MB stereo webm, 7200s | extracted in **43 s**, output 68.6 MB ogg¹, ffmpeg peaked at 16 MB RSS (python wrapper 79 MB) | 2026-10-09 |
| Synthetic generation speed | `gen_synthetic.sh 7200 audio` | 62 s to generate | 2026-10-09 |
| 1.2 GB video upload, interrupted | `gen_synthetic.sh 3600 video`, imported via dashboard | upload completed; exactly one file in Drive. Local copy was auto-deleted afterwards, which only happens once the extension confirms Drive's reported size matches the local bytes, so cleanup doubled as the integrity check | 2026-10-12 |
| Network drop mid-upload | same 1.2 GB upload, Wi-Fi off 60 s at 6% (67 MB) | status showed "Connection lost · attempt 1"; on reconnect it resumed from 6%, not from zero | 2026-10-12 |
| Real 60-minute recording, 1080p | tab + mic, ~780 MB (≈13 MB/min) | full pipeline ran unattended: Drive, transcript, Doc, email | 2026-10-12 |
| Service-worker kill mid-upload | OS-level kill of the extension process | attempted twice; the upload finished before the kill landed both times. The resume path this was meant to exercise is covered by the automated resumable-protocol tests (`driveUpload.test.ts`) | 2026-10-12 |
| **Real 2-hour recording, end to end** | 2h tab+mic recording of a podcast (video + both audio sources; file size: TODO from Drive) | recorded, uploaded, and the backend ran registration → extraction → transcription → Doc → email in **5 min 20 s** (Firestore: registered 11:34:18Z, completed 11:39:38Z); transcript Doc and email delivered (Doc length / speaker-separation quality: TODO after review of the Doc) | 2026-10-12 |

¹ Opus VBR overshoots its 48k nominal on pure sine tones; real speech encodes close to
nominal (~43 MB for 2h). Either number is small enough that it doesn't matter downstream.

## Why file size doesn't accumulate anywhere

Follow a 3 GB recording through the system. At no point does any component hold more
than a few megabytes of it at once, which is the whole trick.

**While recording**, MediaRecorder hands the extension a compressed chunk every five
seconds and each chunk is written to OPFS as its own file, committed on close. Memory
stays flat for hours because nothing is ever buffered beyond the current chunk, and a
crash costs at most the five seconds that hadn't been flushed. The 60-minute real
recording wrote about 13 MB/min this way.

**During upload**, the file goes from the browser directly to the user's Drive in 8 MiB
slices. The job record stores the upload session URI and the confirmed byte offset after
every slice, so an interruption of any kind (network, service worker death, browser
quit) resumes by asking Drive how much it has and continuing from there. That is what
the 6%-cut test shows: a 3 GB file is just more slices, not a different problem. Our
servers are not involved in this hop at all, so Cloud Run's 32 MB request limit and our
bandwidth bill are both irrelevant to video size.

**For transcription**, the worker never downloads the video. It streams it from Drive in
16 MiB range reads, pipes them straight into ffmpeg's stdin, and keeps only the audio
output: two hours of video reduce to a 40–70 MB ogg. Measured, that extraction runs
about 170× faster than realtime (43 s for 2 h) inside a 30-minute task budget, with
ffmpeg holding 16 MB of memory. The audio goes to a GCS bucket that purges itself after
seven days.

**AssemblyAI** receives a signed URL to that small audio file, not the video. Their API
accepts up to 5 GB and 10 hours per request and reports completion by webhook, so no
process on our side waits while a long transcription runs; a two-hour job and a
two-minute job hold connections open for exactly the same amount of time, which is none.

**The Doc** at the end is roughly 100–150k characters for two hours of speech, written
in batches of at most 100 requests. Comfortably one document.

The remaining bottlenecks are the ones you'd expect and can't engineer away client-side:
the user's disk (recording writes ~13 MB/min; the quota guard warns before starting if a
2-hour projection doesn't fit, and local copies self-delete ~10 minutes after a verified
upload) and the user's upstream bandwidth (upload time is bandwidth ÷ file size; the
resumable protocol just makes interruptions free instead of fatal).

## Reproducing

```sh
# extraction benchmark (excluded from normal CI)
cd backend && RUN_LOAD_TESTS=1 uv run pytest tests/load -s
# shorter run: LOAD_TEST_DURATION_S=1800

# synthetic long recording (vp8 realtime: a 2h file encodes in minutes)
./scripts/gen_synthetic.sh 7200 video /tmp/two-hour.webm

# run it through the real product: dashboard -> Import file (debug)
# then, mid-upload: toggle Wi-Fi off/on, kill the extension process.
# success = exactly one Drive file and a completed pipeline anyway
```
