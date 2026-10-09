import { useEffect, useRef, useState } from 'react';
import { retryJob } from '@/lib/api';
import { getAuthState, signOut } from '@/lib/auth';
import { db } from '@/lib/db';
import { applyEvent, createRecordingJob, nowIso } from '@/lib/jobs';
import {
  DEFAULT_PREFS,
  REC_STATE_KEY,
  type MessageResponse,
  type RecSessionState,
  type RecordingPrefs,
} from '@/lib/messages';
import { checkQuota, formatBytes, type QuotaCheck } from '@/lib/quota';
import { chipLabel, driveLink, formatWhen, humanError, retryLine } from '@/lib/status';
import { formatElapsed } from '@/lib/time';
import type { Job, LocalStatus } from '@/lib/state/types';

const SAVEABLE: LocalStatus[] = ['pending_upload', 'uploading', 'uploaded', 'completed', 'failed'];

function TabAudioIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [prefs, setPrefs] = useState<RecordingPrefs>(DEFAULT_PREFS);
  const [recState, setRecState] = useState<RecSessionState | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [quota, setQuota] = useState<QuotaCheck | null>(null);
  const [micPermission, setMicPermission] = useState<PermissionState>('prompt');
  const [error, setError] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const tabRef = useRef<{ id: number; title: string } | null>(null);

  const refreshJobs = () =>
    db.jobs.orderBy('createdAt').reverse().limit(5).toArray().then(setJobs);

  useEffect(() => {
    void refreshJobs();
    void navigator.storage.persist();
    void getAuthState().then((state) => setAuthEmail(state.email));

    void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id !== undefined) {
        tabRef.current = { id: tab.id, title: tab.title ?? '' };
        // Plant the on-page widget so start/stop works without reopening the
        // popup. Fails on pages Chrome won't script (chrome:// etc.) — the
        // popup covers everything there, so no need to bother the user.
        void browser.scripting
          .executeScript({ target: { tabId: tab.id }, files: ['/widget.js'] })
          .catch((err: unknown) => {
            console.warn('[tab-recorder] widget injection failed:', err);
          });
      }
    });

    void browser.storage.session
      .get(REC_STATE_KEY)
      .then((stored) => setRecState((stored[REC_STATE_KEY] as RecSessionState | undefined) ?? null));

    void browser.storage.local.get('recordingPrefs').then((stored) => {
      if (stored.recordingPrefs) setPrefs(stored.recordingPrefs as RecordingPrefs);
    });

    void navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        setMicPermission(status.state);
        status.onchange = () => setMicPermission(status.state);
      })
      .catch(() => setMicPermission('prompt'));

    const onSessionChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && REC_STATE_KEY in changes) {
        setRecState((changes[REC_STATE_KEY].newValue as RecSessionState | undefined) ?? null);
        void refreshJobs();
      }
    };
    browser.storage.onChanged.addListener(onSessionChange);

    // Back online: poke the queue so stalled uploads resume immediately
    const onOnline = () => {
      void browser.runtime.sendMessage({ target: 'background', type: 'KICK_QUEUE' });
    };
    window.addEventListener('online', onOnline);

    const poll = setInterval(refreshJobs, 2000);
    return () => {
      browser.storage.onChanged.removeListener(onSessionChange);
      window.removeEventListener('online', onOnline);
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    void checkQuota(prefs.mode).then(setQuota);
    void browser.storage.local.set({ recordingPrefs: prefs });
  }, [prefs]);

  useEffect(() => {
    if (!recState) return;
    const timer = setInterval(() => setElapsed(Date.now() - recState.startedAt), 500);
    setElapsed(Date.now() - recState.startedAt);
    return () => clearInterval(timer);
  }, [recState]);

  const noSources = prefs.mode === 'audio' && !prefs.tab && !prefs.mic;
  const canRecord = !recState && !noSources && quota?.ok !== false && tabRef.current !== null;

  async function onRecord() {
    setError(null);
    const tab = tabRef.current;
    if (!tab) return;

    if (prefs.mic && micPermission !== 'granted') {
      await browser.tabs.create({ url: browser.runtime.getURL('/permissions.html') });
      window.close();
      return;
    }

    try {
      // getMediaStreamId first: it must run inside the click gesture
      let streamId: string | null = null;
      if (prefs.mode === 'video' || prefs.tab) {
        streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      }

      const jobId = crypto.randomUUID();
      const name = tab.title || `Recording ${new Date().toLocaleString()}`;
      await db.jobs.put(
        createRecordingJob({
          jobId,
          name,
          mode: prefs.mode,
          sources: { tab: prefs.tab, mic: prefs.mic },
        }),
      );

      const response = (await browser.runtime.sendMessage({
        target: 'background',
        type: 'START_RECORDING',
        payload: {
          jobId,
          streamId,
          name,
          mode: prefs.mode,
          sources: { tab: prefs.tab, mic: prefs.mic },
          tabId: tab.id,
        },
      })) as MessageResponse | undefined;

      if (!response?.ok) {
        await applyEvent(jobId, {
          type: 'RECORDING_FAILED',
          occurredAt: nowIso(),
          code: 'START_REJECTED',
          message: response?.error ?? 'Recording could not start',
        });
        setError(response?.error ?? 'Recording could not start');
        void refreshJobs();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onStop() {
    await browser.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
    void refreshJobs();
  }

  async function onRetry(job: Job) {
    await applyEvent(job.jobId, { type: 'RETRY', occurredAt: nowIso() });
    if (job.driveFileId) {
      void retryJob(job.jobId); // backend stage failed -> ask it to re-run too
    }
    void browser.runtime.sendMessage({ target: 'background', type: 'KICK_QUEUE' });
    void refreshJobs();
  }

  async function onSignIn() {
    setSigningIn(true);
    setError(null);
    const response = (await browser.runtime
      .sendMessage({ target: 'background', type: 'SIGN_IN' })
      .catch((err: unknown) => ({ ok: false, error: String(err) }))) as MessageResponse;
    setSigningIn(false);
    if (response.ok && response.email) {
      setAuthEmail(response.email);
      void refreshJobs();
    } else {
      setError(response.error ?? 'Sign-in failed');
    }
  }

  async function onSignOut() {
    await signOut();
    setAuthEmail(null);
  }

  return (
    <main>
      <header className="app-header">
        <span className="brand-dot" />
        <h1>Tab Recorder</h1>
        {recState && <span className="live-chip">REC</span>}
      </header>

      {recState ? (
        <section className="recording-card">
          <div className="rec-top">
            <span className="rec-dot" />
            <span className="rec-timer">{formatElapsed(elapsed)}</span>
          </div>
          <p className="rec-name" title={recState.name}>
            {recState.name}
          </p>
          <button className="btn stop" onClick={() => void onStop()}>
            Stop recording
          </button>
        </section>
      ) : (
        <section className="controls">
          <div className="segmented" role="tablist" aria-label="Recording mode">
            <button
              className={prefs.mode === 'video' ? 'active' : ''}
              onClick={() => setPrefs({ ...prefs, mode: 'video' })}
            >
              Video + audio
            </button>
            <button
              className={prefs.mode === 'audio' ? 'active' : ''}
              onClick={() => setPrefs({ ...prefs, mode: 'audio' })}
            >
              Audio only
            </button>
          </div>

          <p className="section-label">Audio sources</p>
          <div className="sources">
            <div className="source-row">
              <span className="source-icon">
                <TabAudioIcon />
              </span>
              <span className="source-text">
                <span>Tab audio</span>
                <small>Sound playing in this tab</small>
              </span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={prefs.tab}
                  onChange={(e) => setPrefs({ ...prefs, tab: e.target.checked })}
                />
                <span className="slider" />
              </label>
            </div>
            <div className="source-row">
              <span className="source-icon">
                <MicIcon />
              </span>
              <span className="source-text">
                <span>Microphone</span>
                <small>Your voice and narration</small>
              </span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={prefs.mic}
                  onChange={(e) => setPrefs({ ...prefs, mic: e.target.checked })}
                />
                <span className="slider" />
              </label>
            </div>
          </div>

          <button className="btn record" disabled={!canRecord} onClick={() => void onRecord()}>
            <span className="record-dot" />
            Record this tab
          </button>

          {noSources && (
            <p className="hint">Turn on tab audio or the microphone to record audio-only.</p>
          )}
          {prefs.mic && micPermission !== 'granted' && (
            <p className="hint">First recording opens a one-time microphone permission page.</p>
          )}
          {quota?.warning && <p className={quota.ok ? 'hint warn' : 'hint error'}>{quota.warning}</p>}
        </section>
      )}

      <div className="auth-row">
        {authEmail ? (
          <>
            <span className="auth-email" title={authEmail}>
              {authEmail}
            </span>
            <button className="link-btn" onClick={() => void onSignOut()}>
              Sign out
            </button>
          </>
        ) : (
          <button className="btn signin" disabled={signingIn} onClick={() => void onSignIn()}>
            {signingIn ? 'Waiting for Google…' : 'Sign in with Google'}
          </button>
        )}
      </div>
      {!authEmail && jobs.some((j) => j.localStatus === 'needs_sign_in') && (
        <p className="hint warn">Sign in to resume paused uploads.</p>
      )}

      {error && <p className="hint error">{error}</p>}

      <div className="section-row">
        <p className="section-label">Recent recordings</p>
        <a
          className="view-all"
          href={browser.runtime.getURL('/dashboard.html')}
          target="_blank"
          rel="noreferrer"
        >
          View all
        </a>
      </div>
      {jobs.length === 0 ? (
        <p className="empty">Nothing recorded yet — pick a tab and hit record.</p>
      ) : (
        <ul className="job-list">
          {jobs.map((job) => (
            <li key={job.jobId}>
              <div className="job-main">
                <span className="job-name" title={job.name}>
                  {job.name}
                </span>
                <span className={`chip chip-${job.localStatus}`}>
                  {chipLabel(job)}
                  {job.recovered ? ' · recovered' : ''}
                </span>
              </div>
              <div className="job-meta">
                <span>{formatWhen(job.createdAt)}</span>
                {job.totalBytes !== null && <span>{formatBytes(job.totalBytes)}</span>}
                {job.mode === 'audio' && <span>audio</span>}
                {driveLink(job) && (
                  <a href={driveLink(job)!} target="_blank" rel="noreferrer">
                    Drive
                  </a>
                )}
                {SAVEABLE.includes(job.localStatus) && job.segmentCount > 0 && (
                  <a
                    href={browser.runtime.getURL(`/save.html?jobId=${job.jobId}`)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Save to Downloads
                  </a>
                )}
                {job.localStatus === 'failed' && (
                  <button className="link-btn" onClick={() => void onRetry(job)}>
                    Retry
                  </button>
                )}
                {job.localStatus === 'failed' && job.lastError && (
                  <span
                    className="job-error"
                    title={`${job.lastError.code}: ${job.lastError.message}`}
                  >
                    {humanError(job.lastError)}
                  </span>
                )}
              </div>
              {retryLine(job) && <div className="job-retry">{retryLine(job)}</div>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
