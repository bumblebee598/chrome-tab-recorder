import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { sweepVerifiedUploads, type CleanupDeps } from './cleanup';
import { db } from './db';
import { createRecordingJob } from './jobs';
import type { Job } from './state/types';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const OLD_ENOUGH = '2026-10-07T10:00:00Z'; // >24h before NOW
const TOO_RECENT = '2026-10-08T11:00:00Z';

function uploadedJob(overrides: Partial<Job> = {}): Job {
  const base = createRecordingJob({
    jobId: 'job-clean-1',
    name: 'Uploaded',
    mode: 'video',
    sources: { tab: true, mic: true },
  });
  return {
    ...base,
    localStatus: 'uploaded',
    driveFileId: 'drive-1',
    segmentCount: 5,
    totalBytes: 1000,
    stages: {
      upload: { completedAt: OLD_ENOUGH },
      extractAudio: null,
      transcribe: null,
      generateDoc: null,
      email: null,
    },
    ...overrides,
  };
}

function deps(overrides: Partial<CleanupDeps> = {}): CleanupDeps & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    now: () => NOW,
    localBytes: async () => 1000,
    driveBytes: async () => 1000,
    deleteLocal: async (jobId) => {
      deleted.push(jobId);
    },
    deleted,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.jobs.clear();
});

it('deletes the local copy after a verified upload past the grace period', async () => {
  await db.jobs.put(uploadedJob());
  const d = deps();

  await sweepVerifiedUploads(d);

  expect(d.deleted).toEqual(['job-clean-1']);
  expect((await db.jobs.get('job-clean-1'))?.segmentCount).toBe(0);
});

it('waits out the 24h grace period', async () => {
  await db.jobs.put(
    uploadedJob({
      stages: {
        upload: { completedAt: TOO_RECENT },
        extractAudio: null,
        transcribe: null,
        generateDoc: null,
        email: null,
      },
    }),
  );
  const d = deps();

  await sweepVerifiedUploads(d);

  expect(d.deleted).toEqual([]);
  expect((await db.jobs.get('job-clean-1'))?.segmentCount).toBe(5);
});

it('keeps the local copy when Drive reports a different size', async () => {
  await db.jobs.put(uploadedJob());
  const d = deps({ driveBytes: async () => 999 });

  await sweepVerifiedUploads(d);

  expect(d.deleted).toEqual([]);
});

it('keeps the local copy when verification is impossible (signed out)', async () => {
  await db.jobs.put(uploadedJob());
  const d = deps({ driveBytes: async () => null });

  await sweepVerifiedUploads(d);

  expect(d.deleted).toEqual([]);
});

it('never touches jobs that have not finished uploading', async () => {
  await db.jobs.put(
    uploadedJob({ localStatus: 'uploading', driveFileId: null, stages: {
      upload: null, extractAudio: null, transcribe: null, generateDoc: null, email: null,
    } }),
  );
  const d = deps();
  const spy = vi.fn(d.driveBytes);
  d.driveBytes = spy;

  await sweepVerifiedUploads(d);

  expect(d.deleted).toEqual([]);
  expect(spy).not.toHaveBeenCalled();
});
