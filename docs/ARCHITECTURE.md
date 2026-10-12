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

1. **The video never passes through our servers.** The browser uploads it straight to the
   user's Drive, and the backend only ever handles the small extracted audio track
   (~40–70 MB for two hours, purged from Cloud Storage after 7 days). Cloud Run's 32 MB
   request cap never matters, and video storage is the user's own Drive quota.
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

Tab audio and microphone are both on by default, and either can be switched off before
recording starts (plus an audio-only mode). Every job row shows its name, creation time,
current status, retry state ("attempt 3 · next try in 2m"), and Drive/Doc links once they
exist. The statuses match the brief: Pending upload, Uploading, Uploaded, Queued for
transcription, Transcribing, Completed and Failed, plus a "Sign-in needed" pause state.
History lives in IndexedDB, so it survives extension reloads and browser restarts.

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

Retention: the local copy is deleted automatically ~10 minutes after upload is **verified**
(Drive file ID saved and Drive-reported size equals local bytes). Job history is kept
forever. Backend retries read from Drive, never from the client, so deletion is safe.

Quota: `navigator.storage.persist()` + `unlimitedStorage`; before recording,
`storage.estimate()` warns when free space is below a projected 2-hour recording and
refuses below a 500 MB floor.

## 4. Upload retry logic

Recordings land in a "Tab Recorder" folder the extension creates in the user's Drive on
first upload. When an upload finishes, the Drive file ID is stored on the job record —
that ID is what the backend receives at registration and the only handle it ever needs.

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

## 5. Duplicate prevention and idempotency

Every backend handler follows one rule: read the job first, and if your step is already
done, return success and do nothing. Combined with named tasks and the forward-only state
machine, delivering the same work twice is harmless everywhere.

Beyond that rule, seven layers, all keyed on the client-generated UUID; each covered by
an automated test:

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

**Retry, in one view:**

| Layer | How it retries | Limit | After that |
| --- | --- | --- | --- |
| Extension upload | backoff 30 s → 30 min with jitter | 10 attempts | `failed`, manual Retry |
| Pipeline stage | Cloud Tasks backoff 10 s → 10 min | 8 attempts | job wedges mid-stage; Retry re-enqueues from the first missing step (`generation+1`) |
| Transcription check | scheduled polls 15 min → 1 h | 12 polls (~10.5 h total) | `TRANSCRIPT_TIMEOUT`, failure email |
| Manual | Retry button → local queue and/or `POST /v1/jobs/{id}/retry` | any non-completed job | — |

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
   server disk; only the ~40–70 MB ogg lands in `/tmp` (RAM-backed), then GCS. In a
   two-hour benchmark, extraction took **43 s** with ffmpeg peaking at **16 MB** of memory.
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

Long audio needs no special handling: a two-hour file is one request, submission returns
in milliseconds, and nothing on our side runs or waits while AssemblyAI works. A 10-hour
recording would follow exactly the same path.

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
  the user, so it arrives like any other message they have sent themselves. Works for any
  OAuth test user with zero signup or domain verification.
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

**Retry logic** across all layers is summarized in the table at the end of §6.

**Failure handling.** Every failure mode has a code, a user-facing message, a recovery
path, and a reproduction recipe — the full matrix is `docs/ERRORS.md` (14 scenarios).
Transient vs permanent is encoded in HTTP semantics (503 = queue retries, 200+failed =
stop and tell the user). A `FAIL_STAGE=stage:N` flag injects failures for demos and tests.
Terminal failures email the user once. Two scenarios the brief calls out explicitly:
**backend down** — the upload still completes, the job rests at `Uploaded`, and the
extension re-attempts registration on every queue tick until the backend returns;
**Google API errors and rate limits (5xx/429)** — retried with backoff on both sides
(the extension's chunk retries, Cloud Tasks' stage retries).

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

## 11. GCP services, one by one

Everything lives in a single GCP project, provisioned by `infra/setup.sh`
(`bootstrap → secrets → deploy`, idempotent).

**Cloud Run — two services.**
`tab-rec-api` (public): FastAPI, 1 vCPU / 512 MiB, 300 s timeout. Handles OAuth exchange
and token refresh, job registration, status reads, and the AssemblyAI webhook. Public
because the extension and AssemblyAI both need to reach it; everything sensitive on it is
protected by the session JWT or the webhook secret.
`tab-rec-worker` (private): FastAPI, 2 vCPU / 2 GiB, 1800 s timeout, `concurrency=1`.
Runs the pipeline stages; sized for ffmpeg (CPU-bound, so one job per instance — scale
comes from Cloud Run adding instances, not threads). `--no-allow-unauthenticated`: the
only identity with `run.invoker` on it is the task-invoker service account, enforced by
Cloud Run's own IAM layer, so there is zero auth code in the handlers. Both deploy from
source: Cloud Build builds the Dockerfile (python:3.12-slim + ffmpeg + uv) and pushes to
**Artifact Registry**; the deploy script wires each service's URL into the other's env.

**Cloud Tasks — three queues**, `extract`, `transcribe-submit`, `finalize`, each
8 attempts with 10 s → 10 min exponential backoff (mechanics in §12). Per-stage queues
mean a storm of retries in one stage never starves another.

**Firestore (Native mode)** — two collections.
`jobs/{uuid}`: the orchestration record — remoteStatus, generation counter, driveFileId,
audioGcsUri, transcriptId, docId, contentWritten/emailSentAt markers, error. Document ID
is the client UUID (creation idempotent via `doc.create`); every status move is a
transactional compare-and-set on `remoteStatus`, so concurrent handlers get exactly one
winner. `users/{sub}`: email + the Fernet-encrypted Google refresh token, keyed by the
Google account's stable subject ID.

**Cloud Storage** — one bucket for extracted audio (`audio/{jobId}.ogg`), uniform access,
lifecycle rule deletes objects after 7 days (transcription is long done by then).
AssemblyAI fetches via 24-hour V4 signed URLs; since Cloud Run credentials are token-only
(no private key), signing goes through the IAM `signBlob` API — which is why the worker
SA holds `serviceAccountTokenCreator`.

**Secret Manager** — five secrets (AssemblyAI key, OAuth client secret, session-JWT key,
webhook secret, Fernet key), loaded from `backend/.env` by `setup.sh secrets` and mounted
into Cloud Run as env vars. Nothing sensitive in images or code.

**IAM — three dedicated service accounts.**
`tab-rec-api` and `tab-rec-worker` (runtime identities): `datastore.user`,
`secretmanager.secretAccessor`, `cloudtasks.enqueuer`, bucket `objectAdmin`; worker
additionally `serviceAccountTokenCreator` (URL signing). `tab-rec-tasks-invoker`: owns
`run.invoker` on the worker and nothing else — it exists purely to be the OIDC identity
stamped on tasks, so both runtime SAs also hold `iam.serviceAccountUser` (*actAs*) on it.
Plus one non-obvious grant modern projects need: `cloudbuild.builds.builder` on the
default compute SA, or source deploys fail at the upload step.

**Google Auth Platform** — External + Testing consent screen (sign-in hard-limited to
listed test users), one Web-application OAuth client whose redirect is the extension's
pinned `chromiumapp.org` URL. Scopes: `openid email`, `drive.file`, `gmail.send`.
Testing-mode refresh tokens expire after 7 days (documented demo caveat).

Drive, Docs, and Gmail are consumed as user-delegated Google APIs (the user's own OAuth
grant), not project infrastructure: files and Docs are owned by the user, email is sent
as the user. The backend's only Google-API credential is the refresh token it stores.

## 12. Cloud Tasks mechanics, precisely

A stage transition is an HTTP task: `{queue, name, url, OIDC identity, JSON body, optional
schedule_time}`. The lifecycle:

1. **Enqueue.** The api or worker calls `CreateTask` with an explicit name:
   `{stage}-{sha256(jobId)[:16]}-g{generation}`. Names are unique per queue; creating a
   task whose name already exists returns `ALREADY_EXISTS`, which we treat as success.
   This is the dedup primitive: webhook and poll can race to enqueue `finalize`, a client
   can re-register a job, a handler can be re-run — the queue collapses all of it into
   one delivery. (Google reserves recently used names for a while, which is why retries
   get a fresh `generation` suffix rather than reusing the old name.)
2. **Dispatch.** Cloud Tasks POSTs the body to the worker URL with an OIDC token minted
   for the invoker SA (`audience` = worker URL). Cloud Run validates the token before our
   code runs. The dispatch deadline is 30 minutes — the worker's own timeout is set to
   match, so a stage can never outlive its delivery window unnoticed.
3. **Ack semantics.** 2xx = task done, delete it. Anything else = retry after backoff
   (10 s doubling to 10 min, 8 attempts). Handlers exploit this deliberately: transient
   faults (Drive 5xx, ffmpeg hiccup, transcript not ready yet) return **503** so the
   queue retries; permanent faults (revoked auth, Docs API refusal) write
   `remoteStatus=failed` with an error code and return **200** so the queue *stops* and
   the user gets a Retry button instead of seven more doomed attempts.
4. **At-least-once.** Delivery can duplicate; every handler's first action is to read the
   job and return 200 if its stage artifact already exists (audioGcsUri, transcriptId,
   contentWritten, emailSentAt). Combined with the CAS status moves, redelivery is a
   no-op, proven by running every handler twice in tests.
5. **Scheduled tasks.** `schedule_time` is how the polling backup works: submit schedules
   a poll 15 minutes out; each poll that finds the transcript still processing schedules
   the next with a longer delay (to 1 h, 12 polls max). No cron, no sleeping worker —
   just future-dated tasks.
6. **Exhaustion.** If all 8 attempts fail, the task is dropped — the job wedges in its
   current status. Recovery path: `POST /v1/jobs/{id}/retry` bumps the generation
   counter (new task names, so dedup doesn't block the redo) and re-enqueues from the
   first missing artifact. Stale work from the old generation is ignored: a late webhook
   whose transcript ID doesn't match the job's current one is acknowledged and discarded.

Locally the same code runs against an open-source Cloud Tasks emulator in docker-compose,
with queues pre-created at startup.

## 13. Extension storage internals: IndexedDB and OPFS

**IndexedDB (via Dexie) — the job queue and history.** One table, `jobs`, primary key
`jobId`, secondary indexes on `localStatus` and `createdAt` — exactly the two access
patterns the system has: "give me eligible work, oldest first" (queue runner, recovery,
status polling all filter on `localStatus`) and "newest first" (UI lists). Every state
change goes through one function, `applyEvent(jobId, event)`: a Dexie read-modify-write
transaction that loads the record, runs the pure `transition()` function, and writes the
result. Since the transition is monotonic, racing writers can interleave without
corrupting anything — a replay produces the same record. IndexedDB was chosen over
`chrome.storage.local` because the latter is a 10 MB JSON key-value store with no
indexes and no transactions; it would need a full serialize-deserialize of the whole job
list per update. Crucially, IndexedDB is shared across all extension contexts (popup,
dashboard, worker, offscreen), so the offscreen recorder can update `segmentCount` while
the popup reads it live.

**OPFS — the media.** The Origin Private File System is a real filesystem sandboxed to
the extension's origin: invisible in Finder, not synced, accessed via
`navigator.storage.getDirectory()`. Layout: `/recordings/{jobId}/seg-000000.webm …` plus
a `manifest.json` (mime, channel count, totals, wall-clock duration). Two properties do
all the work:

- *Commit-on-close.* `createWritable()` writes to a hidden temp file and atomically
  swaps it in on `close()`. A long-lived writer would therefore commit nothing until the
  end — the opposite of durable. So the recorder opens a writer per 5-second chunk:
  write, close, done. Each close is a durability checkpoint; crash loss is bounded by
  one chunk.
- *Disk-backed `File` handles.* Reading a segment via `getFile()` yields a `File` whose
  bytes stay on disk. `new Blob([f0, f1, …f1439])` is a lazy concatenation — slicing out
  an 8 MiB upload chunk or feeding a download never materializes the multi-GB whole in
  memory. Byte-concatenation is valid because the segments are one continuous
  MediaRecorder stream split at blob boundaries, not independently containerized files.

Quota and lifecycle: the extension holds `unlimitedStorage` (exempts the data from
Chrome's eviction under disk pressure) and calls `navigator.storage.persist()`; before
recording, `storage.estimate()` gates on free space (hard floor 500 MB, warning below a
projected 2-hour recording). After upload, cleanup deletes a job's segment directory only
once Drive's reported size equals the local byte count and a ~10-minute grace has passed;
the IndexedDB record — with its Drive and Doc links — is kept indefinitely as history.

The remaining two stores are deliberately small: `chrome.storage.local` holds the toggle
prefs and the backend session token (durable config), and `chrome.storage.session` holds
the live-recording marker, the queue's single-flight lease, and the cached access token —
state whose correct lifetime is exactly one browser session, so the store's volatility is
a feature, not a limitation.
