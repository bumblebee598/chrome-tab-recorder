# How the Tab Recorder extension works (plain English)

Current state: the full product works end to end in production — record → Drive upload →
audio extraction → AssemblyAI transcription → Google Doc → email. Backend runs on Cloud Run;
see `docs/ERRORS.md` for the failure matrix and `docs/VALIDATION.md` for measured large-file
evidence.

## Installing

The extension is loaded "unpacked" from `extension/.output/chrome-mv3` (the compiled build).
The manifest pins a public key, so the extension always gets the same ID
(`nfphhdblmoifbnbieoodhchadpcgnfjd`) on every machine. That matters later: Google sign-in
redirects to a URL derived from this ID, so a stable ID means the OAuth setup never breaks.

## Permissions and what each one is for

| Permission | Why it exists |
| --- | --- |
| `tabCapture` | Actually record the tab's video and audio |
| `offscreen` | Create the hidden page that hosts the recorder (Chrome forbids recording from the service worker) |
| `activeTab` | Touch the tab you clicked the icon on: read its title, place the on-page bubble |
| `scripting` | Inject the bubble widget script into that tab |
| `storage` | Remember your toggle settings and the "currently recording" state |
| `unlimitedStorage` | Stop Chrome from evicting multi-GB recordings under disk pressure |
| `alarms` | Wake the extension every minute to recover crashed recordings (and later, resume uploads) |
| `identity` | Google sign-in (used from step 6 onward, unused today) |

The **microphone** is not a manifest permission — it's granted once on the `permissions.html`
page (the mic prompt can't appear inside the hidden recorder page, so a visible page asks).

## The moving parts

- **Popup** — the control panel. Mode picker (Video + audio / Audio only), two switches
  (Tab audio, Microphone — both ON by default), the Record/Stop button, warnings (low disk,
  mic permission), and the 10 most recent recordings with status chips and "Save to Downloads".
- **On-page bubble (widget)** — appears on a tab after you've clicked the extension icon there
  once. Idle: a ball; click it to start recording without the popup. Recording: a pill with a
  pulsing dot, live timer, and stop button, plus a red glow around the page. Hover the ball for
  a × to dismiss it.
- **Background service worker** — the coordinator. It routes messages, sets the REC badge,
  creates/destroys the recorder page, and runs the once-a-minute recovery check. Chrome kills
  and restarts it constantly, which is why it keeps no state in memory.
- **Offscreen document** — the actual recorder. Captures the tab stream and mic, mixes audio
  (tab → left channel, mic → right channel; one source alone records mono), and runs
  MediaRecorder, which hands over a chunk of encoded video every 5 seconds.
- **Helper pages** — `permissions.html` (one-time mic grant) and `save.html` (stitches a
  recording into a single `.webm` in your Downloads).

## Where data lives, and why

- **OPFS (private extension disk space)** — the media itself. Each 5-second chunk becomes its
  own file: `/recordings/{jobId}/seg-000000.webm`, `seg-000001.webm`, … plus a `manifest.json`.
  A file only "counts" once it's closed, so one file per chunk means a crash can lose at most
  about 5 seconds. This is the durable source of truth the Drive upload reads from.
  **Retention rule: verified upload.** Once Drive confirms the file (size parity checked
  against Drive's metadata) and a 24-hour grace period passes, the local copy is deleted
  automatically — Drive is the durable copy from then on, and the backend only ever reads
  from Drive. Job history (name, date, status, Drive/Doc links) is kept forever; cleanup is
  fully automatic by team decision — no manual delete controls in the UI. The dashboard
  shows a storage meter.
- **IndexedDB (the `jobs` table)** — one record per recording: its status, size, segment count,
  error info, retry bookkeeping, and (later) its Drive file ID, transcript ID, and Doc ID.
  It survives restarts and is queryable — recovery literally asks "give me every job still
  marked `recording`" after a crash.
- **chrome.storage.local** — just your toggle preferences.
- **chrome.storage.session** — the live "a recording is happening right now" marker (job ID,
  start time, which tab). Cleared when the browser closes, which is correct: a recording can't
  outlive the browser, and anything left behind is handled by recovery.

Nothing is sent anywhere today. No network calls exist yet.

## The job state machine (the contract with the future backend)

Every recording is a **job** that moves one way through named statuses:

`recording → pending_upload → uploading → uploaded → queued_for_transcription → transcribing → completed` (or `failed`)

The rules for moving between statuses are written once as a table of test cases
(`shared/fixtures/transitions.json`) and implemented twice — in TypeScript for the extension
and in Python for the backend — and both must pass the identical table. Two properties matter:

- **Jobs only move forward.** A duplicate or late event (a replayed webhook, a retried task)
  can never knock a finished job backward.
- **Each step records its own "done" flag.** Retries resume from the first unfinished step
  instead of redoing work.

## How it will connect to the backend (and why this architecture)

1. **Step 5 — upload:** the extension uploads the OPFS segments *directly* to Google Drive
   using resumable upload sessions (saved byte offset → a crash resumes mid-file). The backend
   never touches the gigabytes — important because our server tier caps request sizes at 32 MB,
   and relaying would double transfer time and cost.
2. **Step 6 — sign-in:** Google OAuth via the extension; the backend keeps the long-lived token.
3. **Steps 7+ — pipeline:** the extension tells the backend "job X is uploaded." The backend
   runs a queue of short, retry-safe stages: pull the file from Drive → extract a small audio
   track with ffmpeg → send it to AssemblyAI → AssemblyAI calls *us* back when done (no server
   waits two hours) → write a Google Doc → email you the link. The extension just polls job
   status and shows the chips you already see in the popup.

The point of the whole design: **the recording is safe on disk before anything else is
attempted, every later step can fail and retry without losing work, and no component ever
holds gigabytes in memory or waits on a slow job.**

## Where it can still go wrong (honest list)

- **Not yet proven in a long real-world run.** A full 2-hour recording (~2.7 GB) hasn't been
  exercised end-to-end in a real Chrome session yet.
- **The bubble has blind spots.** It can't appear on Chrome's own pages (`chrome://…`, Web
  Store), and if the tab navigates to another site mid-recording the bubble vanishes — the
  recording continues (toolbar badge stays) but on-page controls are gone.
- **Widget start can be refused.** Chrome only lets us capture a tab the extension was invoked
  on; after an extension reload you must click the icon on that tab again before the ball works.
- **Deleting the extension deletes not-yet-uploaded recordings.** OPFS belongs to the
  extension — remove it or clear browsing data and anything that hasn't reached Drive is gone.
  (After a verified upload this no longer matters; Drive holds the durable copy.)
- **Last ~5 seconds can be lost in a crash.** By design (chunk interval), bounded but nonzero.
- **Stitched files show no duration in some players.** MediaRecorder chunks lack the final
  duration metadata; playback works, but the seek bar may be odd until the backend remuxes it
  (ffmpeg reads it fine — cosmetic, accepted).
- **Mic level is whatever your mic gives.** There's no gain boost yet; a quiet mic records quiet.
- **Disk-space checks are estimates.** Chrome's free-space figure can be optimistic; a recording
  could still die on a truly full disk.
- **Only the one tab is recorded.** Switching tabs keeps recording the original tab, not your
  screen — system-wide audio/video is out of scope by design.
