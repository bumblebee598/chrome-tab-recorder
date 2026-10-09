import { useEffect, useRef, useState } from 'react';
import { getAuthState } from '@/lib/auth';
import { fetchStatuses, getApiBase, retryJob } from '@/lib/api';
import type { MessageResponse } from '@/lib/messages';
import { db } from '@/lib/db';
import { applyEvent, createRecordingJob, nowIso } from '@/lib/jobs';
import { deleteRecording, writeManifest, writeSegment } from '@/lib/opfs';
import { formatBytes } from '@/lib/quota';
import {
  canRetryBackend,
  chipLabel,
  docLink,
  driveLink,
  formatWhen,
  humanError,
  retryLine,
} from '@/lib/status';
import { syncFromRemote } from '@/lib/sync';
import type { Job, LocalStatus } from '@/lib/state/types';

const POLLABLE: LocalStatus[] = ['uploaded', 'queued_for_transcription', 'transcribing'];

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [backendConfigured, setBackendConfigured] = useState(false);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const refresh = () => db.jobs.orderBy('createdAt').reverse().toArray().then(setJobs);

  useEffect(() => {
    void refresh();
    void getApiBase().then((base) => setBackendConfigured(base !== null));
    void getAuthState().then((state) => setAuthEmail(state.email));
    void navigator.storage
      .estimate()
      .then(({ usage = 0, quota = 0 }) => setStorage({ usage, quota }));

    const kick = () =>
      void browser.runtime.sendMessage({ target: 'background', type: 'KICK_QUEUE' });
    kick();
    window.addEventListener('online', kick);

    const tick = setInterval(async () => {
      kick();
      const current = await db.jobs.orderBy('createdAt').reverse().toArray();
      const pollable = current.filter((j) => POLLABLE.includes(j.localStatus));
      if (pollable.length > 0) {
        const statuses = await fetchStatuses(pollable.map((j) => j.jobId)).catch(() => []);
        for (const status of statuses) await syncFromRemote(status);
      }
      await refresh();
    }, 5000);

    const fast = setInterval(refresh, 2000);
    return () => {
      clearInterval(tick);
      clearInterval(fast);
      window.removeEventListener('online', kick);
    };
  }, []);

  async function onSignIn() {
    const response = (await browser.runtime
      .sendMessage({ target: 'background', type: 'SIGN_IN' })
      .catch((err: unknown) => ({ ok: false, error: String(err) }))) as MessageResponse;
    if (response.ok && response.email) setAuthEmail(response.email);
    else window.alert(response.error ?? 'Sign-in failed');
  }

  async function onRetry(job: Job) {
    await applyEvent(job.jobId, { type: 'RETRY', occurredAt: nowIso() });
    if (job.driveFileId) {
      void retryJob(job.jobId); // backend stage failed -> ask it to re-run too
    }
    void browser.runtime.sendMessage({ target: 'background', type: 'KICK_QUEUE' });
    await refresh();
  }

  /** Debug/validation path: feed a synthetic webm through the real pipeline. */
  async function onImportFile(file: File) {
    const jobId = crypto.randomUUID();
    const isAudio = (file.type || '').startsWith('audio/');
    await db.jobs.put(
      createRecordingJob({
        jobId,
        name: `Imported · ${file.name}`,
        mode: isAudio ? 'audio' : 'video',
        sources: { tab: true, mic: true },
      }),
    );

    const CHUNK = 8 * 1024 * 1024;
    let index = 0;
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      await writeSegment(jobId, index, file.slice(offset, Math.min(offset + CHUNK, file.size)));
      index += 1;
      if (index % 8 === 0) {
        setImporting(`Importing ${file.name} — ${Math.round((offset / file.size) * 100)}%`);
        await db.jobs.update(jobId, { segmentCount: index });
      }
    }
    await writeManifest(jobId, {
      jobId,
      mimeType: file.type || 'video/webm',
      channels: 2,
      segmentCount: index,
      totalBytes: file.size,
      durationMs: null,
      startedAt: nowIso(),
      stoppedAt: nowIso(),
      recovered: false,
    });
    await db.jobs.update(jobId, { segmentCount: index });
    await applyEvent(jobId, {
      type: 'RECORDING_FINISHED',
      occurredAt: nowIso(),
      totalBytes: file.size,
    });
    setImporting(null);
    void browser.runtime.sendMessage({ target: 'background', type: 'KICK_QUEUE' });
    await refresh();
  }

  return (
    <main>
      <header>
        <span className="brand-dot" />
        <h1>Tab Recorder — all recordings</h1>
        <span className="backend-state">
          {backendConfigured ? 'Backend configured' : 'Backend not configured yet'}
        </span>
        {authEmail ? (
          <span className="backend-state">{authEmail}</span>
        ) : (
          <button className="signin-btn" onClick={() => void onSignIn()}>
            Sign in with Google
          </button>
        )}
      </header>

      {storage && (
        <p className="storage-meter">
          Local recording storage: {formatBytes(storage.usage)} used ·{' '}
          {formatBytes(Math.max(0, storage.quota - storage.usage))} free. Local copies are
          removed automatically 24h after a verified upload.
          {' · '}
          <button className="import-btn" onClick={() => importRef.current?.click()}>
            Import file (debug)
          </button>
          {importing && <span> {importing}</span>}
          <input
            ref={importRef}
            type="file"
            accept="video/webm,audio/webm,.webm"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onImportFile(file);
              e.target.value = '';
            }}
          />
        </p>
      )}

      {jobs.length === 0 ? (
        <p className="empty">No recordings yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Recorded</th>
              <th>Size</th>
              <th>Status</th>
              <th>Links</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.jobId}>
                <td className="name" title={job.name}>
                  {job.name}
                  {job.mode === 'audio' && <span className="tag">audio</span>}
                  {job.recovered && <span className="tag">recovered</span>}
                </td>
                <td>{formatWhen(job.createdAt)}</td>
                <td>{job.totalBytes !== null ? formatBytes(job.totalBytes) : '—'}</td>
                <td>
                  <span className={`chip chip-${job.localStatus}`}>{chipLabel(job)}</span>
                  {retryLine(job) && <div className="retry-line">{retryLine(job)}</div>}
                  {job.localStatus === 'failed' && job.lastError && (
                    <div
                      className="error-line"
                      title={`${job.lastError.code}: ${job.lastError.message}`}
                    >
                      {humanError(job.lastError)}
                    </div>
                  )}
                </td>
                <td className="links">
                  {driveLink(job) && (
                    <a href={driveLink(job)!} target="_blank" rel="noreferrer">
                      Drive
                    </a>
                  )}
                  {docLink(job) && (
                    <a href={docLink(job)!} target="_blank" rel="noreferrer">
                      Doc
                    </a>
                  )}
                  {job.segmentCount > 0 && (
                    <a
                      href={browser.runtime.getURL(`/save.html?jobId=${job.jobId}`)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Save local
                    </a>
                  )}
                </td>
                <td className="actions">
                  {(job.localStatus === 'failed' || canRetryBackend(job)) && (
                    <button onClick={() => void onRetry(job)}>Retry</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
