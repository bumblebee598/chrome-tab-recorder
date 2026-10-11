# Automated Test Report

As of 2026-10-12. Totals: **80 backend (pytest) + 87 extension (vitest)**, all passing,
plus one gated load benchmark. Run everything with `make test`; the benchmark with
`RUN_LOAD_TESTS=1 uv run pytest tests/load -s`. Each section: what we tried, what
happened, and why the result holds — tied to the architecture.

## 1. State machine parity — 36 shared fixture cases × 2 languages
**Tried:** every lifecycle transition, replayed/duplicated events, a webhook arriving
after completion, retry/backoff arithmetic, auth pause/resume — the same JSON table
executed by `transition.ts` (vitest) and `transitions.py` (pytest).
**Happened:** byte-identical outcomes in both languages; late/duplicate events are no-ops.
**Why:** statuses are ranked and only move forward; stage-completion flags, not display
status, drive resume decisions. Because extension and backend run the *same* table, they
cannot disagree about what a state means — the fixture file is the contract.

## 2. Crash recovery — `recovery.test.ts`
**Tried:** jobs left in `recording` after a simulated crash: with segments, without, and
one actively recording.
**Happened:** segments → `pending_upload (recovered)` with byte totals; empty → failed
(`NO_DATA`); the active one untouched.
**Why:** recording writes one committed OPFS file per 5 s timeslice, so a crash leaves a
readable prefix on disk; the heartbeat only has to reconcile IndexedDB against it.

## 3. Disk quota gate — `quota.test.ts`
**Tried:** mocked `storage.estimate()` below the 500 MB floor, below a projected 2-hour
recording, and with plenty free.
**Happened:** blocked / warned-but-allowed / silent, respectively.
**Why:** short recordings shouldn't be hostage to a hypothetical 2-hour projection; only
critically low disk (where even a short recording risks mid-write death) hard-blocks.

## 4. Resumable upload protocol — `driveUpload.test.ts` (8 scenarios)
**Tried:** fresh upload; resume after interruption (308 + Range probe); session expired
with a finished file in Drive; session expired with nothing to adopt; missing token;
401 mid-chunk; double 401; 5xx on a chunk; chunk-size invariant.
**Happened:** fresh uploads complete and store the Drive file ID; resumes continue from
the committed offset (asserted via the exact `Content-Range` header); expired sessions
*adopt* the existing Drive file instead of re-uploading; 401 triggers one token refresh
and a retry of the same chunk, a second 401 pauses at `needs_sign_in`; 5xx schedules a
backoff retry without failing the job; chunks are 256 KiB multiples (Drive requirement).
**Why:** the job record persists session URI + byte offset after every chunk, and every
recovery path checks Drive for `appProperties.jobId` before creating anything — this is
the "exactly one Drive file per job" guarantee under any interruption.

## 5. Queue runner — `queue.test.ts`
**Tried:** three queued jobs; offline; a held single-flight lease; a job awaiting backend
handoff with the backend absent, then present; jitter determinism.
**Happened:** uploads run strictly oldest-first; nothing runs offline or while another
runner holds the lease; `uploaded` jobs wait harmlessly until the backend accepts, then
advance; jitter is bounded and reproducible.
**Why:** the lease (storage.session, TTL + renewal) makes concurrent wakeups safe; the
"no progress → skip this tick" rule means a missing backend degrades to waiting, never
to data loss.

## 6. Auth — `pkce.test.ts`, `auth.test.ts`, backend `test_auth.py`
**Tried:** RFC 7636 S256 vector; token caching and forced refresh; 401 handling; backend
code exchange (including wrong `aud`), refresh flow, `invalid_grant`, garbage/unknown
sessions.
**Happened:** challenge matches the published vector; one network call per token
lifetime; 401 clears the session (signed-out state); backend rejects wrong-audience
tokens and maps `invalid_grant` to 401 so the client knows to re-consent.
**Why:** the extension holds only short-lived access tokens; the refresh token lives
encrypted (Fernet) in Firestore and never leaves the backend.

## 7. UI state rendering — `status.test.ts`, `db.test.ts`
**Tried:** every local status and every backend stage chip; error-code → human-string
mapping; backend-retry eligibility; job round-trip through IndexedDB.
**Happened:** all states render labels; stage chips show "Preparing audio / Writing the
transcript / …"; unknown codes fall back cleanly.
**Why:** raw codes stay in tooltips/logs; the UI layer is a pure mapping, so it's tested
as one.

## 8. Status sync — `sync.test.ts`
**Tried:** replaying backend status onto local jobs (mid-pipeline, repeated, completed,
failed), and the background poll with/without pollable jobs.
**Happened:** the event ladder is idempotent — re-applying a status changes nothing;
completed backend state flips the local job to Completed; the poller no-ops when idle.
**Why matters:** manual QA found jobs frozen at "Waiting in line" because only the
dashboard polled. Fix: the heartbeat and popup now call the same poller. **Defect found
→ fixed → regression-tested.**

## 9. Job API idempotency — `test_jobs_api.py`
**Tried:** registering the same job twice; a Drive file whose `appProperties` doesn't
match the caller's job; listing jobs as a stranger; retry of a failed job and of a
*stuck* (non-failed) job; webhook with bad secret, replayed webhook, webhook from a
superseded generation; concurrent CAS.
**Happened:** one Firestore doc and one task regardless of repeats; foreign files → 403;
strangers see nothing; retry bumps `generation` and re-enqueues exactly the first missing
stage; bad secrets → 401; replays and stale-generation webhooks are acknowledged but do
nothing; exactly one CAS winner.
**Why:** document ID = job UUID, task names = `{stage}-{hash}-g{generation}`, and all
status moves are compare-and-set — the three mechanisms that make at-least-once delivery
and user retries safe.

## 10. Worker pipeline — `test_worker_pipeline.py`
**Tried:** real ffmpeg extraction of a synthetic stereo webm; re-delivered extract for a
job whose audio already exists; unknown job; double transcribe-submit; poll returning
completed / still-processing / error.
**Happened:** extraction yields verified 2-channel opus; re-deliveries skip ahead;
unknown jobs are acked (poison-pill protection); one AssemblyAI submission despite two
deliveries; poll enqueues finalize, reschedules with backoff, or fails the job with
reason, respectively.
**Why:** every handler's first act is "is my stage already done?" — the uniform
idempotency contract.

## 11. Finalize: Doc + email — `test_finalize.py`, `test_docgen.py`
**Tried:** finalize twice; a half-written Doc from a crashed previous attempt; transcript
not ready; Doc content builder with an emoji title, speaker turns, links, batching.
**Happened:** one Doc and one email total; half-written Docs are cleared and rewritten
(first request is `deleteContentRange`); not-ready returns 503 so the queue retries; all
batchUpdate indexes are internally consistent in UTF-16 units, every paragraph carries an
explicit style, the recording link spans exactly its label, batches stay ≤100.
**Why:** `contentWritten`/`emailSentAt` markers + find-by-jobId separate "done" from
"attempted", and precomputed UTF-16 ranges are the only safe way to batch Docs requests.

## 12. Error matrix — `test_error_matrix.py`
**Tried:** Docs API refusing writes; Gmail refusing sends; revoked Google access during
extract; `FAIL_STAGE=extract:2` fault injection; failure-email dedup under repeated polls.
**Happened:** `DOC_FAILED` / `EMAIL_FAILED` / `USER_AUTH` mark the job failed with a
working Retry path (no crash loops, no infinite queue retries); injected failures 503
twice then succeed; exactly one failure email.
**Why:** permanent failures return 200-with-failed-state (stop the queue, inform the
user); transient ones return 503 (let the queue retry); the one-shot `failed` CAS gates
the failure email.

## 13. Cleanup sweeper — `cleanup.test.ts`
**Tried:** verified upload past the grace period; inside the grace; Drive size mismatch;
unverifiable (signed out); never-uploaded jobs.
**Happened:** deletes only the first case; keeps the local copy in every doubt.
**Why:** Drive is the durable copy only once proven identical; the grace (~10 min, was
24 h — tightened on team feedback) is belt-and-suspenders. Job history always survives.

## 14. Load benchmark — `tests/load/test_two_hour.py` (gated)
**Tried:** generate 2 h of stereo audio, stream it through the production extraction
function in 16 MiB chunks.
**Happened:** **43 s** end-to-end, output 68.6 MB ogg, Python RSS 79 MB, ffmpeg 16 MB.
**Why:** ~170× realtime against a 30-minute task budget, with flat memory — the numbers
behind the 2-hour claim (full table: `docs/VALIDATION.md`).

## Defects found by testing, and their fixes
1. **Status freeze at "Waiting in line"** (manual QA) — backend progress only synced
   while the dashboard was open. Fixed: heartbeat + popup poll too. Regression test in
   `sync.test.ts`.
2. **`/healthz` unreachable in production** — Cloud Run's frontend reserves some
   z-suffixed paths and serves its own 404. Renamed to `/health`; alias kept for local
   tooling. Test asserts both.
3. **Deploy-time IAM gaps** (Cloud Build builder role, `actAs` on the task-invoker SA,
   IAM-signed V4 URLs) — all failed loudly on first deploy, all fixed and captured in
   `infra/setup.sh` so a fresh project bootstraps correctly.
