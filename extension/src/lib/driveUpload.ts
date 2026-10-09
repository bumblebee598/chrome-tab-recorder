// Google Drive resumable upload, straight from OPFS segments.
//
// Order of operations (duplicate-free by construction):
//   1. driveFileId already set            -> done
//   2. driveSessionUri set                -> probe it (PUT "bytes */total");
//      308 = resume from committed offset, 200 = already finished,
//      404/410/4xx = session expired -> fall through to 3
//   3. files.list by appProperties.jobId  -> adopt the file a previous
//      attempt finished but never recorded
//   4. open a new resumable session, persist the Location URI immediately
//   5. PUT 8 MiB chunks (32 x 256 KiB; Drive requires 256 KiB multiples),
//      persist uploadedBytes after every 308
//   6. 200/201 -> record driveFileId
//
// Any 401 anywhere: force-refresh the token and retry that same request once;
// a second 401 pauses the job at needs_sign_in.

import { db } from './db';
import { applyEvent, nowIso } from './jobs';
import { recordingBlob } from './opfs';
import type { TokenProvider } from './auth';
import type { Job } from './state/types';

export const CHUNK_BYTES = 8 * 1024 * 1024;
const DRIVE_UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_NAME = 'Tab Recorder';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export type UploadOutcome = 'completed' | 'needs_sign_in' | 'retry_scheduled' | 'failed';

export interface UploadDeps {
  auth: TokenProvider;
  /** called after every committed chunk so the queue lease stays fresh */
  renew: () => Promise<unknown>;
}

class AuthFailure extends Error {}

export async function uploadJob(job: Job, deps: UploadDeps): Promise<UploadOutcome> {
  try {
    if (job.driveFileId) {
      await complete(job.jobId, job.driveFileId);
      return 'completed';
    }

    const media = await recordingBlob(job.jobId);
    if (!media) {
      await fail(job.jobId, 'NO_LOCAL_DATA', 'Local recording segments are missing', false);
      return 'failed';
    }
    const { blob, mimeType } = media;
    const total = blob.size;

    let folderId = job.driveFolderId;
    if (!folderId) {
      folderId = await ensureFolder(deps.auth);
      await db.jobs.update(job.jobId, { driveFolderId: folderId });
    }

    let sessionUri = job.driveSessionUri;
    let offset = 0;

    if (sessionUri) {
      const probe = await probeSession(deps.auth, sessionUri, total);
      if (probe.state === 'done' && probe.fileId) {
        await complete(job.jobId, probe.fileId);
        return 'completed';
      }
      if (probe.state === 'resume') {
        offset = probe.committed;
      } else {
        sessionUri = null;
        await db.jobs.update(job.jobId, { driveSessionUri: null });
      }
    }

    if (!sessionUri) {
      const existing = await findFileForJob(deps.auth, job.jobId);
      if (existing) {
        await complete(job.jobId, existing);
        return 'completed';
      }
      sessionUri = await createSession(deps.auth, {
        name: `${job.name}.webm`,
        mimeType,
        total,
        folderId,
        jobId: job.jobId,
      });
      await db.jobs.update(job.jobId, { driveSessionUri: sessionUri });
    }

    await applyEvent(job.jobId, { type: 'UPLOAD_STARTED', occurredAt: nowIso() });

    while (offset < total) {
      const end = Math.min(offset + CHUNK_BYTES, total);
      const response = await authorizedFetch(deps.auth, sessionUri, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
        body: blob.slice(offset, end),
      });

      if (response.status === 308) {
        offset = parseCommitted(response.headers.get('Range')) ?? end;
        await applyEvent(job.jobId, {
          type: 'UPLOAD_PROGRESS',
          occurredAt: nowIso(),
          uploadedBytes: offset,
        });
        await deps.renew();
        continue;
      }

      if (response.ok) {
        const body = (await response.json()) as { id?: string };
        await complete(job.jobId, body.id ?? null);
        return 'completed';
      }

      if (response.status === 404 || response.status === 410) {
        await db.jobs.update(job.jobId, { driveSessionUri: null });
        await fail(job.jobId, 'SESSION_EXPIRED', 'Drive upload session expired', true);
        return 'retry_scheduled';
      }

      const bodyText = await safeText(response);
      if (response.status === 403 && /quotaExceeded|storageQuotaExceeded/i.test(bodyText)) {
        await fail(job.jobId, 'QUOTA_EXCEEDED', 'Google Drive storage is full', false);
        return 'failed';
      }

      const retryable = response.status >= 500 || response.status === 429;
      await fail(job.jobId, `HTTP_${response.status}`, bodyText, retryable);
      return retryable ? 'retry_scheduled' : 'failed';
    }

    await fail(job.jobId, 'UPLOAD_INCOMPLETE', 'Upload ended without completion response', true);
    return 'retry_scheduled';
  } catch (error) {
    if (error instanceof AuthFailure) {
      await applyEvent(job.jobId, { type: 'AUTH_REQUIRED', occurredAt: nowIso() });
      return 'needs_sign_in';
    }
    await fail(job.jobId, 'NETWORK', error instanceof Error ? error.message : String(error), true);
    return 'retry_scheduled';
  }
}

async function authorizedFetch(
  auth: TokenProvider,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  let token = await auth.getAccessToken();
  if (!token) throw new AuthFailure('No access token');
  let response = await fetch(input, withAuth(init, token));
  if (response.status === 401) {
    token = await auth.getAccessToken(true);
    if (!token) throw new AuthFailure('Token refresh failed');
    response = await fetch(input, withAuth(init, token));
    if (response.status === 401) throw new AuthFailure('Unauthorized after token refresh');
  }
  return response;
}

function withAuth(init: RequestInit, token: string): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
  };
}

async function createSession(
  auth: TokenProvider,
  meta: { name: string; mimeType: string; total: number; folderId: string | null; jobId: string },
): Promise<string> {
  const response = await authorizedFetch(auth, DRIVE_UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': meta.mimeType,
      'X-Upload-Content-Length': String(meta.total),
    },
    body: JSON.stringify({
      name: meta.name,
      mimeType: meta.mimeType,
      parents: meta.folderId ? [meta.folderId] : undefined,
      appProperties: { jobId: meta.jobId },
    }),
  });
  const location = response.headers.get('Location');
  if (!response.ok || !location) {
    throw new Error(`Could not open upload session (HTTP ${response.status})`);
  }
  return location;
}

type ProbeResult =
  | { state: 'resume'; committed: number }
  | { state: 'done'; fileId?: string }
  | { state: 'expired' };

async function probeSession(
  auth: TokenProvider,
  sessionUri: string,
  total: number,
): Promise<ProbeResult> {
  const response = await authorizedFetch(auth, sessionUri, {
    method: 'PUT',
    headers: { 'Content-Range': `bytes */${total}` },
  });
  if (response.status === 308) {
    return { state: 'resume', committed: parseCommitted(response.headers.get('Range')) ?? 0 };
  }
  if (response.ok) {
    const body = (await response.json().catch(() => ({}))) as { id?: string };
    return { state: 'done', fileId: body.id };
  }
  return { state: 'expired' };
}

/** A previous attempt may have finished the upload without us recording it. */
async function findFileForJob(auth: TokenProvider, jobId: string): Promise<string | null> {
  const query = encodeURIComponent(
    `appProperties has { key='jobId' and value='${jobId}' } and trashed=false`,
  );
  const response = await authorizedFetch(auth, `${DRIVE_FILES_URL}?q=${query}&fields=files(id)`);
  if (!response.ok) return null;
  const body = (await response.json()) as { files?: { id: string }[] };
  return body.files?.[0]?.id ?? null;
}

async function ensureFolder(auth: TokenProvider): Promise<string> {
  const query = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`,
  );
  const search = await authorizedFetch(auth, `${DRIVE_FILES_URL}?q=${query}&fields=files(id)`);
  if (search.ok) {
    const body = (await search.json()) as { files?: { id: string }[] };
    if (body.files?.[0]?.id) return body.files[0].id;
  }
  const create = await authorizedFetch(auth, `${DRIVE_FILES_URL}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: FOLDER_MIME,
      appProperties: { app: 'tabrec' },
    }),
  });
  if (!create.ok) throw new Error(`Could not create Drive folder (HTTP ${create.status})`);
  return ((await create.json()) as { id: string }).id;
}

/** Range header "bytes=0-8388607" -> 8388608 committed bytes. */
function parseCommitted(range: string | null): number | null {
  const match = range?.match(/bytes=\d+-(\d+)/);
  return match ? Number(match[1]) + 1 : null;
}

async function complete(jobId: string, driveFileId: string | null): Promise<void> {
  await applyEvent(jobId, {
    type: 'UPLOAD_COMPLETED',
    occurredAt: nowIso(),
    driveFileId: driveFileId ?? undefined,
  });
}

async function fail(
  jobId: string,
  code: string,
  message: string,
  retryable: boolean,
): Promise<void> {
  await applyEvent(jobId, { type: 'STAGE_FAILED', occurredAt: nowIso(), code, message, retryable });
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return `HTTP ${response.status}`;
  }
}
