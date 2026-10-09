import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { db } from './db';
import { createRecordingJob } from './jobs';
import { acquireLease } from './lease';
import { isDue, jitterMs, pickNextJob, runQueue, type QueueDeps } from './queue';
import type { Job } from './state/types';

const sources = { tab: true, mic: true };

function job(overrides: Partial<Job>): Job {
  const base = createRecordingJob({
    jobId: overrides.jobId ?? crypto.randomUUID(),
    name: 'Test',
    mode: 'video',
    sources,
  });
  return { ...base, localStatus: 'pending_upload', ...overrides };
}

function deps(overrides: Partial<QueueDeps>): QueueDeps {
  return {
    isOnline: () => true,
    now: () => Date.now(),
    upload: vi.fn(async (j: Job) => {
      await db.jobs.update(j.jobId, { localStatus: 'completed' });
      return 'completed' as const;
    }),
    enqueue: vi.fn(async () => false),
    ...overrides,
  };
}

beforeEach(async () => {
  fakeBrowser.reset();
  await db.jobs.clear();
});

it('jitter is deterministic and bounded', () => {
  expect(jitterMs('job-a', 3)).toBe(jitterMs('job-a', 3));
  expect(jitterMs('job-a', 3)).toBeLessThan(30_000);
  expect(jitterMs('job-a', 3)).toBeGreaterThanOrEqual(0);
});

it('picks the oldest due job and skips future retries', async () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  await db.jobs.bulkPut([
    job({ jobId: 'newer', createdAt: '2026-10-06T11:00:00Z' }),
    job({ jobId: 'older', createdAt: '2026-10-06T10:00:00Z' }),
    job({
      jobId: 'waiting',
      createdAt: '2026-10-06T09:00:00Z',
      attempts: 2,
      nextRetryAt: '2026-10-06T13:00:00Z',
    }),
  ]);

  const picked = await pickNextJob(now);
  expect(picked?.jobId).toBe('older');

  const waiting = (await db.jobs.get('waiting'))!;
  expect(isDue(waiting, now)).toBe(false);
  expect(isDue(waiting, Date.parse('2026-10-06T13:01:00Z'))).toBe(true);
});

it('uploads queued jobs in age order once online', async () => {
  await db.jobs.bulkPut([
    job({ jobId: 'c', createdAt: '2026-10-06T10:03:00Z' }),
    job({ jobId: 'a', createdAt: '2026-10-06T10:01:00Z' }),
    job({ jobId: 'b', createdAt: '2026-10-06T10:02:00Z' }),
  ]);
  const order: string[] = [];
  const d = deps({
    upload: vi.fn(async (j: Job) => {
      order.push(j.jobId);
      await db.jobs.update(j.jobId, { localStatus: 'completed' });
      return 'completed' as const;
    }),
  });

  await runQueue(d);
  expect(order).toEqual(['a', 'b', 'c']);
});

it('does nothing while offline', async () => {
  await db.jobs.put(job({ jobId: 'offline-job' }));
  const d = deps({ isOnline: () => false });
  await runQueue(d);
  expect(d.upload).not.toHaveBeenCalled();
  expect((await db.jobs.get('offline-job'))?.localStatus).toBe('pending_upload');
});

it('respects the single-flight lease', async () => {
  await db.jobs.put(job({ jobId: 'locked-out' }));
  await acquireLease('queue-runner', 60_000); // someone else holds it
  const d = deps({});
  await runQueue(d);
  expect(d.upload).not.toHaveBeenCalled();
});

it('hands uploaded jobs to the backend and stops cleanly when it is absent', async () => {
  const uploadedJob = job({
    jobId: 'uploaded-1',
    localStatus: 'uploaded',
    driveFileId: 'drive-1',
    stages: {
      upload: { completedAt: '2026-10-06T10:05:00Z' },
      extractAudio: null,
      transcribe: null,
      generateDoc: null,
      email: null,
    },
  });
  await db.jobs.put(uploadedJob);

  // backend absent: enqueue false -> stays uploaded, loop terminates
  const silent = deps({});
  await runQueue(silent);
  expect((await db.jobs.get('uploaded-1'))?.localStatus).toBe('uploaded');

  // backend accepts -> queued_for_transcription
  const accepting = deps({ enqueue: vi.fn(async () => true) });
  await runQueue(accepting);
  expect((await db.jobs.get('uploaded-1'))?.localStatus).toBe('queued_for_transcription');
});
