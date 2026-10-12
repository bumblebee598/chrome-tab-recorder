# Tab Recorder — System Architecture

Record a Chrome tab plus microphone, upload to the user's Google Drive, transcribe with
AssemblyAI, deliver a formatted Google Doc and an email. This document covers the design
of each subsystem and the reasoning behind the choices.

```
Extension (MV3)                                GCP
┌─────────────────────────────┐    ┌──────────────────────────────────────────┐
│ popup ── dashboard ── widget│    │ api (Cloud Run, public)                  │
│        │                    │    │   /auth/* /v1/jobs /webhooks/assemblyai  │
│ service worker (coordinator)│    │ worker (Cloud Run, private, 2vCPU/2GiB)  │
│        │                    │    │   /tasks/extract /transcribe-submit      │
│ offscreen document          │    │   /tasks/poll /tasks/finalize            │
│   tabCapture + mic          │    │ Cloud Tasks: queue per stage             │
│   MediaRecorder → OPFS      │    │ Firestore: jobs/{uuid}, users/{sub}      │
│ IndexedDB job queue ────────┼──► │ GCS: audio/{jobId}.ogg (7-day lifecycle) │
│   resumable upload to Drive │    │ AssemblyAI · Docs API · Gmail API        │
└─────────────────────────────┘    └──────────────────────────────────────────┘
```

Four principles drive everything:

1. **Media never touches our servers.** The browser uploads directly to the user's Drive;
   the backend reads it back from Drive. Cloud Run's 32 MB request cap never matters, and
   storage cost/quota is the user's own Drive.
2. **No component ever waits on a slow operation.** Every backend stage finishes in
   seconds-to-minutes; transcription completion arrives by webhook with a polling backup.
3. **Forward-only state.** One shared state machine (implemented in both TypeScript and
   Python, verified against a single fixture table) guarantees that replayed deliveries
   and late webhooks can never move a job backwards.
4. **Everything is keyed on a client-generated job UUID**, which makes creation, upload,
   transcription, doc generation, and email all idempotent.

---

## 1. Chrome extension architecture

MV3 forces a split across isolated contexts; each has exactly one role:

| Context | Role | Why it exists |
| --- | --- | --- |
| Service worker | Coordinator: message router, offscreen lifecycle, badge, queue runner, crash recovery | MV3 kills it at will, so it holds **zero in-memory state** — everything it needs lives in IndexedDB / `chrome.storage` |
| Offscreen document (`USER_MEDIA`) | The recorder: `getUserMedia`, Web Audio mixing, `MediaRecorder`, OPFS writes | Service workers cannot host media APIs; offscreen documents are Chrome's sanctioned MV3 path (Chrome 116+) |
| Popup | Record/stop controls, source toggles, recent jobs, sign-in | Entry point; its click is the user gesture `tabCapture` requires |
| Dashboard (extension page) | Full job history, live stage chips, retry, debug file import | Long-lived page for status polling (popups die on blur) |
| On-page widget (injected, shadow DOM) | Loom-style start/stop ball + recording pill + timer | Visible recording state without opening the popup; injected via `scripting` + `activeTab`, styled in a closed shadow root so page CSS can't touch it |
| Permissions page | One-time `getUserMedia({audio:true})` grant | Mic prompts cannot render inside offscreen documents; the grant is per-extension-origin and is reused silently afterwards |

Contexts communicate through typed message contracts discriminated by a `target` field.
The manifest pins a public key, so the extension ID — and therefore the OAuth redirect
URL — is identical on every machine.

Stack: WXT (Vite-based MV3 framework), React 18, TypeScript, Dexie.

## 2. Tab recording implementation

Flow on "Record":

1. Popup (inside the click handler — gesture requirement) calls
   `tabCapture.getMediaStreamId({targetTabId})`; the tab is pre-queried on popup open so
   no `await` precedes the call.
2. Service worker ensures the offscreen document exists and forwards
   `{streamId, jobId, mode, sources}`.
3. Offscreen builds the media graph:
   - Tab: `getUserMedia` with `chromeMediaSource: 'tab'` (video capped 1080p30).
   - Mic: `getUserMedia({audio: {echoCancellation: true}})`.
   - Web Audio: tab source → `ChannelMergerNode` input 0 (**left**), mic → input 1
     (**right**), merger → `MediaStreamAudioDestinationNode`. The tab source is also
     wired to `ctx.destination` so the user keeps hearing the tab.
   - A single audio source records mono; the channel count is stored in the manifest.
4. `MediaRecorder` on `[videoTrack?, mixedAudioTrack]`, `video/webm;codecs=vp9,opus`
   (vp8 fallback), ~3 Mbps video / 128 kbps audio, `start(5000)`.

The channel split is the cheapest diarization decision in the system: downstream,
AssemblyAI's multichannel mode yields "Tab audio" vs "You (mic)" speaker turns for free.

`track.onended` (tab closed, capture revoked) stops cleanly with whatever was captured.
Recording state lives in `chrome.storage.session` plus the toolbar badge — never in popup
memory, because the popup dies the moment it loses focus.

## 3. Local persistence strategy

| Store | Contents | Rationale |
| --- | --- | --- |
| OPFS | `/recordings/{jobId}/seg-000000.webm…` + `manifest.json` | One file per 5 s timeslice; `FileSystemWritableFileStream` only commits on `close()`, so short-lived per-segment writers bound crash loss to ≤ ~5 s. Byte-concatenation of segments is the original stream. |
| IndexedDB (Dexie `jobs`) | One record per job: statuses, byte counts, Drive/Doc IDs, error + retry bookkeeping, per-stage completion flags | Queryable, transactional, survives restarts; doubles as the user-visible history |
| `chrome.storage.local` | UI preferences, backend session token | Small durable config |
| `chrome.storage.session` | Active-recording marker, queue lock lease, cached access token | Deliberately volatile: cleared with the browser, which matches the lifetime of everything it tracks |

Crash recovery: on startup and on a 1-minute heartbeat, any job still marked `recording`
with no live session is salvaged — segments on disk → `pending_upload (recovered)`,
nothing written → failed. Verified by killing Chrome mid-recording.

Retention: the local copy is deleted automatically 24 h after upload is **verified**
(Drive file ID saved and Drive-reported size equals local bytes). Job history is kept
forever. Backend retries read from Drive, never from the client, so deletion is safe.

Quota: `navigator.storage.persist()` + `unlimitedStorage`; before recording,
`storage.estimate()` warns when free space is below a projected 2-hour recording and
refuses below a 500 MB floor.

## 4. Upload retry logic

A durable queue runner in the service worker:

- **Single-flight**: a `chrome.storage.session` lease (TTL 90 s, renewed after every
  chunk) guarantees two wakeups never upload the same job; a crashed holder expires.
- **Scheduling**: oldest eligible job first. Wake triggers: 1-minute alarm, browser
  startup, regaining network, recording completion, manual retry.
- **Backoff**: `min(30s × 2^(attempts−1), 30min)` persisted on the job, plus
  deterministic jitter (hash of jobId+attempt, 0–30 s) applied at scheduling time — the
  state machine itself stays pure and fixture-testable.
- **Bounded**: auto-retry stops after 10 attempts; the job shows "Stopped after 10 tries —
  press Retry" and manual retry is always available.
- **Auth-aware**: a 401 anywhere triggers one forced token refresh and a retry of the
  same request; a second 401 pauses the job at `needs_sign_in`. Signing in resumes every
  paused job automatically.

## 5. Duplicate job prevention

Seven layers, all keyed on the client-generated UUID; each covered by an automated test:

1. **Resumable session reuse** — session URI + committed byte offset persisted after
   every chunk; on resume, a `bytes */total` probe tells us where to continue.
2. **Adopt-don't-reupload** — if the session died (404/410, or the 1-week expiry), the
   uploader first searches Drive for `appProperties.jobId = {uuid}` and adopts the file a
   previous attempt finished. *Test: expired session → adopted file, zero new uploads.*
3. **Registration** — Firestore document ID = UUID, created with `doc.create`;
   `AlreadyExists` returns the existing record. *Test: POST /v1/jobs twice → one doc, one task.*
4. **Stage tasks** — Cloud Tasks names are `{stage}-{sha256(jobId)[:16]}-g{generation}`;
   name-based dedup collapses concurrent enqueues (webhook + poll racing, replays).
5. **Transcription submit** — `transcriptId` written with a check-then-set transaction.
6. **Doc generation** — find-by-`appProperties.jobId` before creating; a half-written doc
   (`contentWritten=false`) is cleared and rewritten rather than duplicated.
7. **Email** — gated by a stored `emailSentAt` marker. *Test: finalize twice → one Doc, one email.*

Documented accepted risks: a crash in the window between Gmail accepting a send and the
`emailSentAt` write can yield one duplicate email; a crash between AssemblyAI accepting a
job and the `transcriptId` write can orphan one transcript (~$1). Both are narrow,
bounded, and preferred over the extra scope/complexity of closing them.

## 6. Queue system choice

**Cloud Tasks, one queue per stage** (`extract`, `transcribe-submit`, `finalize`).

- vs **Pub/Sub push**: push subscriptions cap acknowledgment at 600 s and have no
  name-based dedup or scheduled delivery. Cloud Tasks gives all three: 30-minute dispatch
  deadlines (matching the worker's 1800 s Cloud Run timeout), named tasks for dedup, and
  `schedule_time` — which is exactly how the transcription polling backup is built.
- vs **Cloud Workflows**: a second orchestration model with its own DSL, for a pipeline
  that is a straight line. The job record in Firestore *is* the orchestration state.
- Per-queue retry policy: 8 attempts, 10 s → 10 min exponential backoff. Handlers return
  non-2xx for transient faults (queue retries) and 200-with-failure-state for permanent
  ones (queue stops; the user gets a Retry path instead of futile redelivery).
- Auth: tasks carry OIDC tokens for a dedicated invoker service account — the only
  principal with `run.invoker` on the private worker. Verification happens at the Cloud
  Run platform layer; no token code in the app.

## 7. Transcription orchestration

**Provider: AssemblyAI.** The 2-hour requirement eliminated the alternatives: OpenAI caps
uploads at 25 MB; Deepgram's pre-recorded path 504s when processing exceeds ~10 minutes;
Google's Chirp batch guidance tops out around an hour with word timestamps. AssemblyAI
takes 5 GB / 10 h per request, does per-channel diarization, and signals completion by
webhook.

Pipeline (each step a separate idempotent task):

1. **extract** — mints a user access token from the stored refresh token, streams the
   Drive file in 16 MiB `Range` reads (3 retries on 5xx) straight into
   `ffmpeg -i pipe:0 -vn -ac {channels} -c:a libopus -b:a 48k`. The video never exists on
   server disk; only the ~40–70 MB ogg lands in `/tmp` (RAM-backed), then GCS. Measured:
   a 2-hour stereo file extracts in **43 s** with ffmpeg peaking at **16 MB RSS**.
2. **transcribe-submit** — 24 h V4 signed URL for the GCS object (signed via the IAM
   signBlob API, since Cloud Run service credentials carry no private key) → AssemblyAI
   with `multichannel`, `speaker_labels`, `webhook_url` carrying the job ID and a secret
   auth header. Saves `transcriptId` transactionally, schedules the first poll.
3. **Completion, two independent paths**:
   - **Webhook** (primary): verified by secret header, does nothing but enqueue the
     finalize task — well inside AssemblyAI's 10-second ack window. Named-task dedup
     makes webhook retries harmless.
   - **Poll** (backup): scheduled tasks at growing intervals (15 min → 1 h, 12 attempts)
     fetch transcript status; completion enqueues the same named finalize task, error or
     exhaustion fails the job. This path alone carried local development, where
     AssemblyAI cannot reach a laptop.

Backend progress mirrors to the client by status polling (`GET /v1/jobs?ids=`); the
extension replays the status onto its local job via the same forward-only events, so
repeated application is a no-op by construction.

## 8. Google Docs generation

First half of the **finalize** task:

- **Find-or-create**: Drive `files.create` with `mimeType: document`, parented in the
  same folder as the recording, stamped with `appProperties.jobId`; retries find the
  existing doc by that property. `docId` is persisted immediately.
- **Content build** (pure function, unit-tested): H1 title → recorded-at / duration /
  "Open the recording in Drive" hyperlink → H2 "Transcript" → one paragraph per speaker
  turn with a bold `Speaker — m:ss` prefix. Stereo recordings label turns **Tab audio** /
  **You (mic)**, with sub-speakers within a channel ("Tab audio – Speaker A").
- **Index math**: all `batchUpdate` ranges are precomputed against an empty body in
  **UTF-16 code units** (the Docs API's unit; an emoji in a tab title would otherwise
  corrupt every subsequent range — regression-tested with a surrogate-pair title). Every
  paragraph sets an explicit `namedStyleType` because inserted text inherits the style at
  the insertion point. Requests ship in batches of ≤100.
- **Idempotent rewrite**: a `contentWritten` flag distinguishes done from half-done; a
  retry that finds the doc half-written clears the body (`deleteContentRange`) and
  rewrites, never appends twice.
- Scale: a 2-hour transcript is ~100–150 k characters — one Doc, a handful of batches.
  The Doc is created with the user's own OAuth grant, so they own it; no sharing step.

## 9. Email notification pipeline

Second half of finalize, behind an `EmailSender` protocol:

- **GmailSender** (default): MIME multipart (text + HTML), an `X-Job-Id` header for
  traceability, base64url-encoded into `users.messages.send` — sent *as* the user, *to*
  the user. Works for any OAuth test user with zero signup or domain verification.
- **ResendSender**: drop-in fallback behind the same interface.
- **At-most-once**: `emailSending` is written before the API call, `emailSentAt` after;
  finalize short-circuits when `emailSentAt` exists. Content: recording name, Drive link,
  Doc link, duration.
- **Failure emails**: on terminal failure, sent at most once — gated by the transactional
  `advance() → failed` compare-and-set, which can only succeed once per failure.

## 10. Scale and reliability

**Large files.** A 2-hour 1080p30 recording is ~2.5–3.7 GB. It moves through the system
exactly twice: browser → Drive (resumable, chunked) and Drive → ffmpeg (streamed). Peak
server memory per job is one 16 MiB range buffer plus ffmpeg's ~16 MB; the worker's 2 GiB
is two orders of magnitude of headroom. Measured numbers live in `docs/VALIDATION.md`.

**Resumable/chunked upload.** 8 MiB chunks (Drive requires 256 KiB multiples; 8 MiB = 32×).
The session URI and committed offset are persisted after *every* chunk, so a killed
service worker, browser restart, or network drop resumes mid-file from a status probe.
Sessions expire after a week; the adopt-by-jobId path (§5.2) covers even that.

**Long audio transcription.** Fully asynchronous: submit returns in milliseconds, nothing
holds a connection while AssemblyAI works, and completion is delivered by webhook with a
scheduled-poll fallback. A 10-hour recording would exercise the identical code path.

**Idempotency.** Uniform handler contract: *read the job; if your stage is already done,
return 200.* Combined with named tasks and the forward-only state machine (36 shared
fixture cases executed by both the TS and Python implementations), at-least-once delivery
is safe everywhere.

**Retry logic, in one view:**

| Layer | Mechanism | Bound | After exhaustion |
| --- | --- | --- | --- |
| Extension upload | persisted backoff 30 s→30 min + jitter | 10 attempts | `failed`, manual Retry |
| Cloud Tasks stage | queue backoff 10 s→10 min | 8 attempts | job wedges mid-stage → manual Retry re-enqueues with `generation+1` |
| Transcription poll | scheduled tasks 15 min→1 h | 12 polls | `TRANSCRIPT_TIMEOUT`, failure email |
| Manual | Retry button → local queue and/or `POST /v1/jobs/{id}/retry` | allowed from any non-completed state | — |

**Failure handling.** Every failure mode has a code, a user-facing message, a recovery
path, and a reproduction recipe — the full matrix is `docs/ERRORS.md` (14 scenarios).
Transient vs permanent is encoded in HTTP semantics (503 = queue retries, 200+failed =
stop and tell the user). A `FAIL_STAGE=stage:N` flag injects failures for demos and tests.
Terminal failures email the user once.

**Scaling considerations.**
- *Per-user isolation by design*: media sits in each user's Drive, so our storage and
  bandwidth costs don't scale with recording volume — only the ~40–70 MB audio artifacts
  (auto-purged after 7 days) and Firestore metadata do.
- *Compute*: the worker runs one job per instance (`concurrency=1`, ffmpeg is CPU-bound)
  and scales horizontally under Cloud Run; the api is stateless and cheap. Cloud Tasks
  absorbs bursts and smooths dispatch.
- *Data*: one Firestore document per job — no hot keys, no cross-job transactions.
  AssemblyAI queues submissions FIFO beyond the account's concurrency limit, which
  degrades to latency, not errors.
- *Known limits, deliberate*: Gmail send quotas are irrelevant at one email per
  recording; the 7-day GCS purge means a retry >1 week after extraction re-runs extract
  (stale-pointer edge documented); there's no dead-letter queue — wedged jobs surface in
  the UI with a Retry instead. Each is revisitable if usage outgrows the current shape.
