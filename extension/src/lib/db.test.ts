import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { db } from './db';
import type { Job } from './state/types';

it('persists a job record across put/get', async () => {
  const job: Job = {
    jobId: '0f1e2d3c-0000-4000-8000-000000000001',
    name: 'Weekly sync recording',
    createdAt: '2026-10-05T10:00:00Z',
    mode: 'video',
    sources: { tab: true, mic: true },
    localStatus: 'pending_upload',
    remoteStatus: null,
    uploadedBytes: 0,
    totalBytes: 1048576,
    segmentCount: 0,
    recovered: false,
    driveSessionUri: null,
    driveFileId: null,
    driveFolderId: null,
    docId: null,
    transcriptId: null,
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    stages: { upload: null, extractAudio: null, transcribe: null, generateDoc: null, email: null },
  };

  await db.jobs.put(job);
  const loaded = await db.jobs.get(job.jobId);
  expect(loaded).toEqual(job);
});
