# Tab Recorder — Chrome tab → Drive → Transcript Doc → Email

Record a Chrome tab (plus your microphone on a separate stereo channel), upload it straight
to your Google Drive with resumable uploads, transcribe it with AssemblyAI, and receive a
formatted Google Doc transcript plus an email with both links — fully automatic, crash-safe
at every step.

```
Extension (MV3, WXT/React)                GCP backend (Python/FastAPI)
┌──────────────────────────┐              ┌─────────────────────────────────────┐
│ tabCapture + mic         │   resumable  │ api (Cloud Run, public)             │
│  L=tab / R=mic channels  │   upload     │   /v1/jobs · /auth/* · webhook      │
│ OPFS 5s segments         │ ───────────► │ worker (Cloud Run, private)         │
│ IndexedDB job queue      │    Drive     │   Cloud Tasks stages:               │
│ popup + dashboard UI     │              │   extract → transcribe → finalize   │
└──────────────────────────┘              │ Firestore jobs · GCS audio          │
                                          │ AssemblyAI → Google Doc → Gmail     │
                                          └─────────────────────────────────────┘
```

## Repository layout

```
extension/        WXT MV3 extension (popup, dashboard, background, offscreen recorder)
backend/          FastAPI api + worker, domain state machine, adapters, tests
shared/schema/    job.schema.json — the Job contract (single source of truth)
shared/fixtures/  transitions.json — state-machine table run by BOTH languages
infra/setup.sh    one-command GCP bootstrap + deploy
scripts/          synthetic test media, extension key generation
docs/             HOW_IT_WORKS, STATE_MACHINE, ERRORS (failure matrix), VALIDATION (benchmarks)
.devcontainer/    Codespaces: Python 3.12, Node 20, Java 21, gcloud, ffmpeg, docker-in-docker
```

## Quickstart (Codespaces or local)

Open in GitHub Codespaces (everything is preinstalled by the devcontainer) or locally with
Docker, Node 20+, [uv](https://docs.astral.sh/uv/), and ffmpeg. Then:

```sh
make dev        # emulators + backend: Firestore :8080, Cloud Tasks :8123, api :8000, worker :8081
make test       # backend pytest + extension vitest (both run the same state-machine fixtures)
make build-ext  # → extension/.output/chrome-mv3
```

**Chrome extensions cannot run inside Codespaces.** Build there, download
`extension/.output/chrome-mv3`, and load it unpacked on your machine via
`chrome://extensions` → Developer mode → Load unpacked. The manifest pins a public key, so
the extension ID — and therefore the OAuth redirect — is identical on every machine:
`nfphhdblmoifbnbieoodhchadpcgnfjd`.

## Environment configuration

Two gitignored env files, with committed `*.example` templates. Copy each template, fill
in the values, and you're done — `make gen-secrets` prints the three random ones.

**`backend/.env`** — everything the API and worker need:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID. Any string works against the emulators. |
| `FIRESTORE_EMULATOR_HOST` | `localhost:8080` for local dev; never set in production. |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client ID. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client secret. Backend-only. |
| `ASSEMBLYAI_API_KEY` | AssemblyAI dashboard → API key. |
| `SESSION_JWT_SECRET` | Signs backend-issued session tokens. |
| `WEBHOOK_SECRET` | Authenticates AssemblyAI webhook callbacks. |
| `TOKEN_FERNET_KEY` | Encrypts stored refresh tokens. Rotating forces re-sign-in. |

**`extension/.env`** — baked in at build time, so rebuild after changing:

| Variable | Purpose |
| --- | --- |
| `WXT_GOOGLE_CLIENT_ID` | Same OAuth client ID (public). |
| `WXT_API_BASE_URL` | Backend URL: `http://localhost:8000` or the Cloud Run URL. |

## Google OAuth client

In console.cloud.google.com (one project for everything):
1. Enable APIs: *Google Drive API*, *Google Docs API*, *Gmail API*.
2. OAuth consent screen: **External**, publishing status **Testing**, and add every account
   that will sign in under **Test users** (testing mode hard-blocks everyone else).
3. Credentials → OAuth client ID → type **Web application** → Authorized redirect URI:
   `https://nfphhdblmoifbnbieoodhchadpcgnfjd.chromiumapp.org/`
   (derived from the pinned extension ID, so it's the same for every install).
4. Scopes used: `openid email`, `drive.file` (only files this app creates), `gmail.send`.

> Testing-mode refresh tokens expire after **7 days** — sign in again before a demo.

## Queue infrastructure (GCP)

Local development needs nothing: `make dev` starts a Firestore emulator and a Cloud Tasks
emulator with the three stage queues pre-created.

Production is one script, run with the project owner's gcloud login:

```sh
PROJECT_ID=<id> ./infra/setup.sh bootstrap  # APIs, Firestore, GCS bucket (7-day audio purge),
                                            # queues, service accounts, IAM, secret containers
PROJECT_ID=<id> ./infra/setup.sh secrets    # loads backend/.env values into Secret Manager
PROJECT_ID=<id> ./infra/setup.sh deploy     # Cloud Run: worker (private) + api (public),
                                            # wires their URLs together
```

Queues are one-per-stage (`extract`, `transcribe-submit`, `finalize`), 8 attempts with
10s→10min exponential backoff. Tasks carry OIDC tokens from a dedicated invoker service
account — the only identity permitted to call the private worker. After deploy, put the
printed api URL into `extension/.env` and rebuild.

## What is stored locally (on the user's machine)

| Store | Contents | Lifetime |
| --- | --- | --- |
| **OPFS** (private extension filesystem) | The recording itself: one file per 5-second chunk (`/recordings/{jobId}/seg-NNNNNN.webm`) + `manifest.json`. Each chunk is committed on close, so a crash loses ≤ ~5s. | Deleted automatically 24h after the upload is **verified** (Drive file ID saved + Drive-reported size matches local bytes). Until then it's the durable source of truth. |
| **IndexedDB** (`jobs` table) | One record per recording: status, sizes, Drive/Doc IDs, error + retry bookkeeping. | Kept forever — this is the visible job history; it survives restarts and local-copy cleanup. |
| **chrome.storage.local** | Toggle preferences, auth session token. | Until sign-out. |
| **chrome.storage.session** | "Recording right now" marker, cached access token, queue lock. | Cleared when the browser closes. |

Nothing media-related ever passes through our servers: the video goes browser → Drive
directly, and the backend reads it back from Drive.

## How retries work

- **Extension (upload side):** a durable queue runner picks the oldest eligible job under a
  single-flight lock. Failures schedule a retry with exponential backoff —
  `min(30s × 2^attempts, 30min)` plus jitter — persisted in the job record, so retries
  survive browser restarts. Auto-retry stops after **10 attempts**; a **Retry** button is
  always available after that. The queue wakes on: a 1-minute alarm, browser startup,
  regaining network, finishing a recording, and manual retry.
- **Backend (pipeline side):** each stage is a Cloud Tasks task (8 attempts, 10s→10min
  backoff). Every handler is idempotent — it first checks whether its stage already
  completed and returns success if so, which makes at-least-once delivery safe. The
  extension's Retry button also calls `POST /v1/jobs/{id}/retry`, which bumps a generation
  counter and re-enqueues from the first missing artifact — the documented recovery path
  even for jobs wedged by exhausted queue retries. Failed backend stages retry **from the
  Drive copy**, never from the user's machine.
- **State machine:** statuses only move forward (shared TS+Python implementation, both
  passing the same fixture table), so a replayed task or late webhook can never regress a
  job. The full failure matrix with per-scenario recovery paths is in `docs/ERRORS.md`.

## How duplicate uploads (and outputs) are prevented

Everything keys on the **job UUID generated at recording time**:

1. **Drive upload:** one resumable session per job with its URI + byte offset persisted
   after every 8 MiB chunk — interruptions resume mid-file instead of restarting. If the
   session died, the uploader first searches Drive for a file stamped with this job's ID
   (`appProperties.jobId`) and **adopts** it rather than uploading again. Result: exactly
   one Drive file per job, proven under network loss and service-worker kills.
2. **Job registration:** Firestore document ID = job UUID; creation is `doc.create` with
   AlreadyExists treated as success — registering twice yields one record.
3. **Pipeline stages:** Cloud Tasks names are derived from the job ID
   (`{stage}-{sha256(jobId)[:16]}-g{generation}`), so duplicate enqueues collapse into one
   delivery. The transcript ID is written with a check-then-set transaction (no double
   submit); the Doc is found by `appProperties.jobId` before ever being created; the email
   is gated by a stored `emailSentAt` marker.
4. Automated tests assert the big three: registering a job twice → one document and one
   task; running finalize twice → one Doc and one email; re-running an upload against an
   expired session → the existing Drive file is adopted.

## Testing

```sh
make test                                        # 78 backend + 76 extension tests
cd backend && RUN_LOAD_TESTS=1 uv run pytest tests/load -s   # 2h extraction benchmark
./scripts/gen_synthetic.sh 7200 video            # 2h synthetic recording for stress tests
```

Measured results and the reproduction procedure live in `docs/VALIDATION.md`; the
error-handling matrix in `docs/ERRORS.md` (including the `FAIL_STAGE=extract:2` fault
injection flag for forced-failure demos).
