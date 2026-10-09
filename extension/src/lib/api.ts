// Backend client. All job endpoints require the session JWT from sign-in;
// calls are graceful no-ops when the backend or session is missing, so the
// queue leaves jobs at `uploaded` instead of failing them.

import { DEFAULT_API_BASE } from './config';
import type { Job, RemoteStatus } from './state/types';

const API_BASE_KEY = 'apiBaseUrl';

export interface RemoteJobStatus {
  jobId: string;
  remoteStatus: RemoteStatus;
  transcriptId?: string | null;
  docId?: string | null;
  error?: { code: string; message: string } | null;
}

export async function getApiBase(): Promise<string | null> {
  const stored = await browser.storage.local.get(API_BASE_KEY);
  const base = (stored[API_BASE_KEY] as string | undefined) || DEFAULT_API_BASE;
  return base ? base.replace(/\/$/, '') : null;
}

async function sessionHeaders(): Promise<Record<string, string> | null> {
  const stored = await browser.storage.local.get('authSession');
  const session = stored.authSession as { sessionToken: string } | undefined;
  return session ? { Authorization: `Bearer ${session.sessionToken}` } : null;
}

/** 2 = tab+mic on separate channels, 1 = single source, 0 = silent video */
export function channelsFor(job: Job): number {
  return (job.sources.tab ? 1 : 0) + (job.sources.mic ? 1 : 0);
}

/** Hand an uploaded job to the backend. Returns true when the backend accepted it. */
export async function enqueueJob(job: Job): Promise<boolean> {
  const base = await getApiBase();
  const headers = await sessionHeaders();
  if (!base || !headers || !job.driveFileId) return false;
  const response = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: job.jobId,
      driveFileId: job.driveFileId,
      name: job.name,
      createdAt: job.createdAt,
      channels: channelsFor(job),
    }),
  });
  return response.ok;
}

export async function fetchStatuses(jobIds: string[]): Promise<RemoteJobStatus[]> {
  const base = await getApiBase();
  const headers = await sessionHeaders();
  if (!base || !headers || jobIds.length === 0) return [];
  const response = await fetch(`${base}/v1/jobs?ids=${jobIds.join(',')}`, { headers });
  if (!response.ok) return [];
  const body = (await response.json()) as { jobs?: RemoteJobStatus[] };
  return body.jobs ?? [];
}

/** Ask the backend to re-run its failed stage (generation bump + re-enqueue). */
export async function retryJob(jobId: string): Promise<boolean> {
  const base = await getApiBase();
  const headers = await sessionHeaders();
  if (!base || !headers) return false;
  const response = await fetch(`${base}/v1/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
    headers,
  });
  return response.ok;
}
