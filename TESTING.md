# QA Test Matrix

Every row traces to a line in the brief. **Auto** rows run in `make test` (file and test
named); **Manual** rows are a real Chrome session — record each as evidence/demo B-roll.
Fill the Outcome column as runs complete: ✅ pass · ❌ fail (link issue) · ➖ n/a.

Automated totals: **80 backend (pytest) + 86 extension (vitest)**, plus the gated load
test (`RUN_LOAD_TESTS=1 uv run pytest tests/load -s`).

## 1. Recording

| # | Test | How | Where / Steps | Outcome |
| --- | --- | --- | --- | --- |
| R1 | Defaults record: both toggles ON, video+audio; playback has tab on L, mic on R (`ffprobe` → 2ch; `ffmpeg -af "pan=mono\|c0=c0"` / `c0=c1` isolates each) | Manual | Record YouTube + narration → Save local → ffprobe | |
| R2 | Every toggle combo: tab only, mic only, both, neither (Record disabled) | Manual | Popup toggles ×4 | |
| R3 | Audio-only mode with tab+mic / each alone; output `audio/webm`, no video track | Manual | Audio-only + ffprobe | |
| R4 | Status indicators appear on start, clear on stop: badge, popup timer, widget pill+glow | Manual | Start/stop watching all three | |
| R5 | chrome:// page / Web Store: start fails gracefully with a readable popup error | Manual | Try recording chrome://settings | |
| R6 | Tab closed mid-recording: clean stop, job → pending upload with segments intact | Manual | Close the recorded tab at ~30s | |
| R7 | Segment writer: each timeslice lands as a closed OPFS file with correct index; manifest on stop | Partial auto | naming: `recovery.test.ts::pads segment names`; write path is a thin OPFS wrapper — covered end-to-end by P1 playback | ✅ auto part |

## 2. Local persistence and crash recovery

| # | Test | How | Where / Steps | Outcome |
| --- | --- | --- | --- | --- |
| P1 | Force-quit Chrome 5 min into recording → relaunch → job "recovered", segments play to ~5s before kill | Manual | Force Quit; reopen; Save local; play | |
| P2 | Reload the extension mid-recording → same recovery | Manual | chrome://extensions ↻ while recording | |
| P3 | Recovery routine: `recording` jobs with segments → pending_upload(recovered); zero segments → failed | Auto | `recovery.test.ts` (3 cases) | ✅ |
| P4 | Disk quota gate: below floor blocked, low space warns, plenty quiet | Auto + 1 manual | `quota.test.ts` (4 cases); manual spot-check on a nearly full disk | ✅ auto |
| P5 | History survives extension reload + browser restart: all rows + links present | Manual | 10 jobs, reload, restart | |
| P6 | Local copy deleted only after size-verified upload + 24h; never for pending/failed; unverifiable → kept | Auto | `cleanup.test.ts` (5 cases) | ✅ |

## 3. Upload, retry, dedup

| # | Test | How | Where / Steps | Outcome |
| --- | --- | --- | --- | --- |
| U1 | Happy path: progress advances per chunk, Drive file ID stored, file in "Tab Recorder" folder | Manual | Any recording; check Drive | |
| U2 | Network off mid-upload → on: resumes from offset (not zero), exactly one Drive file, size matches | Manual | DevTools Offline or Wi-Fi toggle during 2h synthetic | |
| U3 | Service worker killed mid-upload: next tick resumes | Manual | chrome://serviceworker-internals → Stop | |
| U4 | Chrome quit mid-upload, relaunch: resumes | Manual | Quit during upload | |
| U5 | Resumable client: 308+Range→resume at next byte; 200/201→store ID; 404/410→dedup lookup→new session; chunks are 256 KiB multiples | Auto | `driveUpload.test.ts` (fresh, resume, adopt, expired→new session, chunk-size) | ✅ |
| U6 | Dedup after session loss: cleared sessionUri → existing file adopted by appProperties.jobId, no second file | Auto + Manual | `driveUpload.test.ts::expired session adopts`; manual: delete sessionUri via dashboard console | ✅ auto |
| U7 | New session when file already exists → adopted not duplicated | Auto | same file, adopt-before-create path | ✅ |
| U8 | Backoff: expected `nextRetryAt` per attempt, 30-min cap, auto-stop at 10, manual retry still allowed; jitter deterministic+bounded | Auto | shared fixtures (backoff/cap/tenth-attempt/manual-retry cases) + `queue.test.ts::jitter` | ✅ |
| U9 | Manual Retry fires immediately, ignoring backoff | Manual | Fail a job (Wi-Fi off 10 tries is slow — use backend FAIL_STAGE or revoke) then Retry | |
| U10 | 5xx/429 on a chunk: retry scheduled, job not failed | Auto | `driveUpload.test.ts::a 5xx on a chunk schedules a retry` | ✅ |
| U11 | Backend down at handoff: stays `uploaded`, registers when backend returns | Manual | Scale api to 0 (or bad WXT_API_BASE_URL build), restore | |
| U12 | 3 offline jobs upload one-at-a-time when online; single-flight lock holds | Auto + Manual | `queue.test.ts` (order, offline, lease); manual: 3 recordings offline → online | ✅ auto |
| U13 | Auth revoked mid-queue: jobs pause `needs_sign_in`, banner, re-sign-in resumes all | Manual | myaccount.google.com/permissions → remove access | |
| U14 | 401 on chunk → refresh → same chunk once; invalid_grant → needs_sign_in | Auto | `driveUpload.test.ts` (401-retry, double-401) + `auth.test.ts::401 clears session` | ✅ |

## 4. Job queue UI and states

| # | Test | How | Where / Steps | Outcome |
| --- | --- | --- | --- | --- |
| Q1 | Every state renders its label (incl. backend stage-detail chips) | Auto + Manual | `status.test.ts` (all 9 local states + 4 stage details); visual pass in dashboard | ✅ auto |
| Q2 | Job rows show name, time, status, retry line ("attempt 3 · next try in 2m"), Drive/Doc links | Manual | Dashboard during a full run | |
| Q3 | Backend transitions reflected within one poll interval (5s, dashboard open) | Manual | Watch during pipeline run | |
| Q4 | Failed job shows human reason + Retry button | Manual | Any failed job | |

## 5. Backend pipeline, idempotency, retries

| # | Test | How | Where / Steps | Outcome |
| --- | --- | --- | --- | --- |
| B1 | Shared state machine: TS + Python pass identical fixture table; backward transitions rejected | Auto | `transition.test.ts` + `test_transitions.py` (36 shared cases: late webhook, replays, guards) | ✅ |
| B2 | POST /jobs twice → one doc, one task | Auto | `test_jobs_api.py::create_job_twice` (in-memory store stands in for the Firestore emulator; CAS semantics covered by B4) | ✅ |
| B3 | Every handler re-delivered → second call no-op (extract skip, submit skip, finalize/email skip) | Auto | `test_worker_pipeline.py` + `test_finalize.py::finalize_twice` | ✅ |
| B4 | Concurrent duplicate dispatch: one CAS winner, other exits clean | Auto | `test_jobs_api.py::advance_cas_has_exactly_one_winner` | ✅ |
| B5 | transcriptId already set → no second AssemblyAI call | Auto | `test_worker_pipeline.py::submit_sets_transcript_once` (call count = 1) | ✅ |
| B6 | Webhook replayed → one finalize task, one Doc, one email | Auto | `test_jobs_api.py::webhook_completed_enqueues_finalize_once` + finalize-twice | ✅ |
| B7 | Webhook with bad auth header → 401 | Auto | `test_jobs_api.py::webhook_rejects_bad_secret` | ✅ |
| B8 | Webhook lost → poll finds completed transcript, enqueues finalize | Auto | `test_worker_pipeline.py::poll_completed_enqueues_finalize` | ✅ |
| B9 | AssemblyAI error → Failed with reason + failure email once; manual retry resubmits with new generation | Auto + Manual | `test_finalize.py::poll_error_sends_failure_email_exactly_once`, `test_jobs_api.py::retry_increments_generation`; manual: corrupt audio file | ✅ auto |
| B10 | Late webhook from an old generation ignored | Auto | `test_jobs_api.py::webhook_for_superseded_transcript_is_ignored` | ✅ |
| B11 | FAIL_STAGE=extract:2 → fails twice, third succeeds | Auto + Manual | `test_error_matrix.py::fault_injection`; manual on real Cloud Tasks watching logs | ✅ auto |
| B12 | Revoked refresh token in worker → USER_AUTH failed, no crash loop | Auto | `test_error_matrix.py::extract_with_revoked_google_access` | ✅ |
| B13 | Task exceeding dispatch deadline resumes from stage flags on retry | Manual | Short-deadline test queue + big file | |

## 6. Doc and email

| # | Test | How | Where / Steps | Outcome |
| --- | --- | --- | --- | --- |
| D1 | Doc: title, date, recording link, full transcript, labelled speaker turns, in the user's folder | Auto + Manual | `test_docgen.py` (payload: headings, UTF-16 ranges, link span, bold prefixes, batching) + open a real Doc | ✅ auto |
| D2 | Finalize twice → one Doc, no duplicated content | Auto | `test_finalize.py::finalize_twice_yields_one_doc_and_one_email` | ✅ |
| D3 | docId set but content unwritten → body cleared and rewritten | Auto | `test_finalize.py::rewrites_half_written_doc` | ✅ |
| D4 | Email has both links, sent once; retries don't resend | Auto + Manual | finalize-twice (sent count = 1) + inbox check | ✅ auto |
| D5 | Email send fails → `EMAIL_FAILED`, links visible, Retry resumes at finalize | Auto | `test_error_matrix.py::email_failure` — **deviation from matrix wording**: job is `failed` (with a Retry path), not `completed`+flag; per team decision retries must not re-run completed work, and finalize skips the Doc on retry | ✅ |
| D6 | Failure email sent once on terminal failure | Auto | `test_finalize.py::poll_error_sends_failure_email_exactly_once` | ✅ |

## 7. Large recording validation (→ docs/VALIDATION.md)

| # | Test | How | Where / Steps | Outcome |
| --- | --- | --- | --- | --- |
| L1 | Real 30–60 min 1080p recording: flat memory (Chrome Task Manager), bytes/min, full pipeline | Manual | Record numbers into VALIDATION.md | |
| L2 | Synthetic 2h 1080p (~2.3 GB): import via dashboard debug → upload with U2+U3 interruptions → extract under timeout → Doc | Scripted + Manual | `gen_synthetic.sh 7200 video` → Import file (debug) | |
| L3 | 2h real speech (two speakers, separate channels) through extract → AssemblyAI → Doc: latency, Doc length, diarization quality | Scripted + Manual | Mix a public-domain 2-speaker file to stereo; import | |
| L4 | OPFS stress: 1,440 × 5s blobs at target bitrate; throughput + estimate() delta | Scripted | Covered implicitly by L2's import+record path; dedicated script optional | |
| L5 | Bottleneck table (disk, upload bandwidth, extract, STT, Doc write) with measured numbers | Written | Extraction row done: **2h → 43s, ffmpeg 16 MB RSS**; fill rest from L1–L3 | ◐ |

## 8. Deliverable checks

| # | Test | How | Outcome |
| --- | --- | --- | --- |
| X1 | Fresh Codespace: `make dev` up, `make test` green, `make build-ext` loads in Chrome | Manual, once | |
| X2 | README followed literally from a fresh GCP project: setup.sh, OAuth, one job completes | Manual, ideally someone else | |
| X3 | README explicitly answers: local storage / retries / duplicate prevention | ✅ three dedicated sections | ✅ |

## Manual-run checklist (chronological, with evidence)

Screen-record each; they double as demo B-roll.

1. ☐ R1–R4 in one session: defaults recording with toggles tour, indicators, channel check (ffprobe)
2. ☐ R5 chrome:// refusal · R6 close tab mid-recording
3. ☐ P1 force-quit recovery · P2 extension-reload recovery · P5 history survival
4. ☐ U1 happy-path upload with Drive folder check
5. ☐ L2 synthetic 2h import, then **during its upload**: U2 Wi-Fi cut + U3 SW kill (+U4 quit if patient) → verify one Drive file, size match
6. ☐ U13 auth revoke mid-queue → banner → re-sign-in resumes (covers U9 Retry too)
7. ☐ U11 backend-down handoff (block api URL, restore)
8. ☐ Q2–Q4 dashboard walkthrough during a pipeline run
9. ☐ B11 FAIL_STAGE=extract:2 on the real worker, watch Cloud Tasks heal (demo gold)
10. ☐ L1 real 30–60 min recording with memory/bytes numbers
11. ☐ L3 two-speaker 2h speech file → Doc quality check
12. ☐ D1/D4 open the Doc + email, click every link
13. ☐ X1 fresh Codespace run · X2 README-literal run
