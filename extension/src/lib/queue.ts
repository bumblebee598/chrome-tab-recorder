// The durable job queue runner. Invoked by the heartbeat alarm, browser
// startup, online events, and explicit kicks (recording stopped, manual
// retry). A storage.session lease guarantees single-flight: concurrent
// wakeups see the lease and bail. All state lives in IndexedDB/OPFS — the
// MV3 service worker can die at any moment.

import { enqueueJob } from './api';
import { auth } from './auth';
import { db } from './db';
import { uploadJob } from './driveUpload';
import { applyEvent, nowIso } from './jobs';
import { acquireLease, releaseLease, renewLease } from './lease';
import type { Job, LocalStatus } from './state/types';

const LEASE_KEY = 'queue-runner';
const LEASE_TTL_MS = 90_000;
const JITTER_WINDOW_MS = 30_000;

const ELIGIBLE_STATUSES: LocalStatus[] = ['pending_upload', 'uploading', 'uploaded'];

export interface QueueDeps {
  isOnline: () => boolean;
  now: () => number;
  upload: typeof uploadJob;
  enqueue: typeof enqueueJob;
}

const defaultDeps: QueueDeps = {
  isOnline: () => navigator.onLine,
  now: () => Date.now(),
  upload: uploadJob,
  enqueue: enqueueJob,
};

/**
 * Deterministic per-attempt jitter (0..30s) added to nextRetryAt at
 * scheduling time. Keeps retries of many jobs from aligning on the same tick
 * without making the state machine non-deterministic.
 */
export function jitterMs(jobId: string, attempts: number): number {
  let hash = attempts + 1;
  for (let i = 0; i < jobId.length; i++) {
    hash = (hash * 31 + jobId.charCodeAt(i)) >>> 0;
  }
  return hash % JITTER_WINDOW_MS;
}

export function isDue(job: Job, now: number): boolean {
  if (!job.nextRetryAt) return true;
  return Date.parse(job.nextRetryAt) + jitterMs(job.jobId, job.attempts) <= now;
}

/** Oldest eligible job: pending/resumable upload, or uploaded awaiting backend handoff. */
export async function pickNextJob(
  now: number,
  exclude: Set<string> = new Set(),
): Promise<Job | undefined> {
  const candidates = await db.jobs
    .where('localStatus')
    .anyOf(ELIGIBLE_STATUSES)
    .sortBy('createdAt');
  return candidates.find((job) => !exclude.has(job.jobId) && isDue(job, now));
}

export async function runQueue(deps: QueueDeps = defaultDeps): Promise<void> {
  if (!deps.isOnline()) return;

  const lease = await acquireLease(LEASE_KEY, LEASE_TTL_MS);
  if (!lease) return;

  try {
    const touched = new Set<string>();
    for (;;) {
      const job = await pickNextJob(deps.now(), touched);
      if (!job) break;
      touched.add(job.jobId);

      if (job.localStatus === 'uploaded') {
        const accepted = await deps.enqueue(job).catch(() => false);
        if (accepted) {
          await applyEvent(job.jobId, { type: 'JOB_ENQUEUED', occurredAt: nowIso() });
        }
        // Not accepted (backend absent/unreachable): stays `uploaded`, retried next tick.
        continue;
      }

      await deps.upload(job, {
        auth,
        renew: () => renewLease(lease, LEASE_TTL_MS),
      });
      await renewLease(lease, LEASE_TTL_MS);
    }
  } finally {
    await releaseLease(lease);
  }
}
