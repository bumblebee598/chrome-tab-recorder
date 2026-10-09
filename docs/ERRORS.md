# Error-handling matrix (Part C)

Every failure has a code, a state, a user-facing message, and a recovery path.
Raw codes/messages appear only in tooltips and logs; the UI shows the human string.

Manual retry is available everywhere: **Retry** in the popup/dashboard replays the
local queue for upload-side failures and calls `POST /v1/jobs/{id}/retry` for
backend-side ones (allowed from any non-completed state, so even a job wedged by
exhausted queue retries is recoverable). A **Sign in with Google** button plus a
"Sign in to resume paused uploads" hint appears whenever any job is paused for auth.

| Scenario | Code | Retryable | Job state | UI message | Recovery | Reproduce |
| --- | --- | --- | --- | --- | --- | --- |
| Network drops mid-upload | `NETWORK` | auto (backoff 30s→30m, stops at 10) | keeps stage, `nextRetryAt` set | "Connection lost" + attempt line | auto on reconnect (online event kicks queue); manual Retry after 10 tries | Toggle Wi-Fi off during upload |
| Drive resumable session expired (>1 week) | `SESSION_EXPIRED` | auto | uploading | "Upload link expired" | new session opened in same run; adopts existing Drive file if one finished | Delete `driveSessionUri` via dashboard console, kick queue |
| Google auth expired/revoked (extension side) | — | manual | `needs_sign_in` | "Sign-in needed" chip + banner | Sign in → all paused jobs resume automatically | Revoke app access at myaccount.google.com/permissions |
| Google auth revoked (backend side, during extract) | `USER_AUTH` | manual | failed + failure email | "Google access expired — sign in again" | Sign in, then Retry | Revoke access, then retry a job |
| Drive storage full | `QUOTA_EXCEEDED` | manual | failed | "Google Drive is full" | Free Drive space, Retry | Fill Drive quota (or mock 403 `storageQuotaExceeded`) |
| Backend unreachable / not deployed | — | auto (silent) | stays `uploaded` | "Uploaded" chip persists | queue retries every tick; nothing is lost | Stop the api service |
| Recording produced no data | `NO_DATA` | no | failed | "Nothing was captured" | record again | Stop a recording instantly |
| Disk full while recording | `SEGMENT_WRITE` | no | failed (segments up to failure kept) | "Ran out of disk space while recording" | free space, record again | Fill the disk (or quota guard blocks first) |
| Recording has no audio channels | `NO_AUDIO` | no | failed | "Recording has no audio to transcribe" | — (video-only is never submitted) | Record with both audio toggles off |
| ffmpeg / Drive stream hiccup (transient) | — (503 to queue) | auto (queue: 8 tries, 10s→10m) | stays `extracting_audio` | stage chip "Preparing audio" | Cloud Tasks retries; if exhausted → Retry button re-enqueues (generation+1) | `FAIL_STAGE=extract:2` on the worker |
| AssemblyAI reports error | `TRANSCRIPT_ERROR` | manual | failed + failure email | "Transcription failed" | Retry (resumes at transcribe stage) | Submit an invalid audio URL |
| Transcription never finishes (~3h of polls) | `TRANSCRIPT_TIMEOUT` | manual | failed + failure email | "Transcription timed out" | Retry | — |
| Docs API rejects Doc creation/write | `DOC_FAILED` | manual | failed + failure email | "Couldn't create the transcript Doc" | Retry (resumes at finalize; adopts existing Doc) | `FAIL_STAGE=finalize:8`, or revoke Docs scope |
| Gmail send fails | `EMAIL_FAILED` | manual | failed | "Couldn't send the email" | Retry (Doc already exists; only email re-runs) | Gmail API quota / revoke scope |

**Fault injection** (demos and tests): deploy/run the worker with `FAIL_STAGE=<stage>:<n>`
(`extract`, `transcribe-submit`, `finalize`) and the first *n* deliveries of that stage
return 503, exercising queue retries end to end. Covered by `tests/test_error_matrix.py`.

**Known accepted risks** (documented in code):
- A crash between the Gmail send and the `emailSentAt` write can produce one duplicate email.
- A crash between AssemblyAI accepting a job and the `transcriptId` write can produce one
  duplicate transcript (~$1 max).
- The api-side webhook `error` path marks the job failed without a failure email (the
  poll task sends it if it fires first; the webhook handler stays within its 10s budget).
