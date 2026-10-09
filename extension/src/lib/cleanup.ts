// Once Drive confirms the upload, Drive is the durable copy — the backend
// reads from there, never from this machine — so the local OPFS copy only
// costs disk. Rule: verify size parity with Drive, wait out a 24h grace
// period, then delete the local segments. (The review suggested md5Checksum
// too, but WebCrypto has no MD5 and hashing multi-GB files in a service
// worker isn't worth it; Drive already integrity-checks resumable uploads.)

import { auth } from './auth';
import { db } from './db';
import { deleteRecording, segmentStats } from './opfs';
import type { LocalStatus } from './state/types';

const GRACE_MS = 24 * 60 * 60 * 1000;

const VERIFIABLE: LocalStatus[] = [
  'uploaded',
  'queued_for_transcription',
  'transcribing',
  'completed',
];

export interface CleanupDeps {
  now: () => number;
  localBytes: (jobId: string) => Promise<number>;
  /** Drive-reported size; null when it cannot be verified right now (signed out, offline). */
  driveBytes: (fileId: string) => Promise<number | null>;
  deleteLocal: (jobId: string) => Promise<void>;
}

const defaultDeps: CleanupDeps = {
  now: () => Date.now(),
  localBytes: async (jobId) => (await segmentStats(jobId)).bytes,
  driveBytes: fetchDriveSize,
  deleteLocal: deleteRecording,
};

async function fetchDriveSize(fileId: string): Promise<number | null> {
  const token = await auth.getAccessToken();
  if (!token) return null;
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=size`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json()) as { size?: string };
  return body.size !== undefined ? Number(body.size) : null;
}

export async function sweepVerifiedUploads(deps: CleanupDeps = defaultDeps): Promise<void> {
  const candidates = await db.jobs.where('localStatus').anyOf(VERIFIABLE).toArray();
  for (const job of candidates) {
    if (job.segmentCount === 0 || !job.driveFileId) continue;
    const uploadedAt = job.stages.upload?.completedAt;
    if (!uploadedAt || deps.now() - Date.parse(uploadedAt) < GRACE_MS) continue;

    const local = await deps.localBytes(job.jobId);
    const remote = await deps.driveBytes(job.driveFileId);
    if (remote === null || remote !== local) continue; // cannot verify -> keep the local copy

    await deps.deleteLocal(job.jobId);
    await db.jobs.update(job.jobId, { segmentCount: 0 });
  }
}
