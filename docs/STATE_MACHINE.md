# Job state machine

One source of truth for job states, shared by the extension (TypeScript) and backend (Python).
Both implementations are pure functions `transition(job, event) -> job` and must pass the same
table-driven fixtures in `shared/fixtures/transitions.json`:

- TypeScript: `extension/src/lib/state/transition.ts` (tested by `transition.test.ts`)
- Python: `backend/app/domain/transitions.py` (tested by `backend/tests/test_transitions.py`)

## Statuses

**`localStatus`** (what the popup shows):

```
recording → pending_upload → uploading → uploaded → queued_for_transcription → transcribing → completed
                                                                                            → failed
needs_sign_in = paused substate (auth expired); exits only via SIGNED_IN
failed        = exits only via RETRY
recording     = accepts only RECORDING_FINISHED / RECORDING_FAILED; all pipeline events are ignored
```

**`remoteStatus`** (backend pipeline substate; `null` until the backend accepts the job):

```
queued → extracting_audio → transcribing → generating_doc → emailing → completed | failed
```

All backend substates except `queued`/`completed`/`failed` render as "Transcribing" in the UI,
with the substate as a detail line.

## Invariants

1. **Monotonic.** Statuses only move forward along the orders above. A late AssemblyAI webhook
   or a replayed Cloud Tasks delivery can never move a `completed` job backward.
2. **Stage flags are separate from display status.** `stages.{upload,extractAudio,transcribe,generateDoc,email}`
   record `completedAt` per stage. Retries and resume key off these flags, never off the display status.
3. **Replays are no-ops.** Every stage-completion event checks its stage flag first, so Cloud Tasks
   at-least-once delivery and webhook retries are safe.
4. **Deterministic backoff.** On a retryable `STAGE_FAILED`:
   `nextRetryAt = occurredAt + min(30 * 2^(attempts-1), 1800)` seconds (attempts is post-increment).
   Auto-retry stops when attempts reaches 10: that failure marks the job `failed` with
   `lastError.retryable=true`, so the UI still offers manual RETRY. Jitter (0–30s, derived from
   jobId+attempts) is added by the queue runner at scheduling time, never inside `transition`.

## Events

| Event | Guard | Effect |
| --- | --- | --- |
| `RECORDING_FINISHED {totalBytes, recovered?}` | local == recording | local → pending_upload, totalBytes set; recovered=true when salvaged after a crash |
| `RECORDING_FAILED {code,message}` | local == recording | local → failed (never retryable) |
| `UPLOAD_STARTED` | local < uploading | local → uploading |
| `UPLOAD_PROGRESS {uploadedBytes}` | local == uploading, bytes increase | uploadedBytes = max |
| `UPLOAD_COMPLETED {driveFileId}` | local < uploaded | local → uploaded, stage upload done, bytes = totalBytes, clear retry state |
| `JOB_ENQUEUED` | stage upload done, local < queued | local → queued_for_transcription, remote → queued |
| `EXTRACT_STARTED` | remote < extracting_audio | remote → extracting_audio, local → transcribing |
| `EXTRACT_COMPLETED` | stage extractAudio unset | stage done |
| `TRANSCRIPT_SUBMITTED {transcriptId}` | remote < transcribing | remote → transcribing, store transcriptId |
| `TRANSCRIPT_COMPLETED` | stage transcribe unset | stage done, remote → generating_doc |
| `DOC_CREATED {docId}` | stage generateDoc unset | stage done, remote → emailing, store docId |
| `EMAIL_SENT` | stage email unset | stage done, remote + local → completed |
| `STAGE_FAILED {code,message,retryable}` | not completed/failed | retryable: attempts++, nextRetryAt per backoff; fatal: local → failed (+ remote → failed if backend involved) |
| `AUTH_REQUIRED` | not completed/failed | local → needs_sign_in |
| `SIGNED_IN` | local == needs_sign_in | local resumes from stage flags + remote status |
| `RETRY` | local == failed | clear error, resume from first incomplete stage |

Successful events clear `attempts`/`lastError`/`nextRetryAt`; `UPLOAD_STARTED`, `UPLOAD_PROGRESS`,
and `AUTH_REQUIRED` leave them untouched.

## Changing the rules

Change `shared/fixtures/transitions.json` first, then update **both** implementations until
`make test` is green on each side. Never change one implementation alone.
