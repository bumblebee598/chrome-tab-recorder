import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db } from './db';
import { createRecordingJob } from './jobs';
import { syncFromRemote } from './sync';
import type { Job } from './state/types';

function uploadedJob(): Job {
  const base = createRecordingJob({
    jobId: 'job-sync-1',
    name: 'Synced',
    mode: 'video',
    sources: { tab: true, mic: true },
  });
  return {
    ...base,
    localStatus: 'uploaded',
    driveFileId: 'drive-1',
    stages: {
      upload: { completedAt: '2026-10-06T10:05:00Z' },
      extractAudio: null,
      transcribe: null,
      generateDoc: null,
      email: null,
    },
  };
}

beforeEach(async () => {
  await db.jobs.clear();
  await db.jobs.put(uploadedJob());
});

it('replays the ladder up to the reported backend status', async () => {
  await syncFromRemote({
    jobId: 'job-sync-1',
    remoteStatus: 'generating_doc',
    transcriptId: 'tr-9',
  });

  const job = (await db.jobs.get('job-sync-1'))!;
  expect(job.localStatus).toBe('transcribing');
  expect(job.remoteStatus).toBe('generating_doc');
  expect(job.transcriptId).toBe('tr-9');
  expect(job.stages.extractAudio).not.toBeNull();
  expect(job.stages.transcribe).not.toBeNull();
  expect(job.stages.generateDoc).toBeNull();
});

it('is idempotent and keeps moving forward', async () => {
  const status = { jobId: 'job-sync-1', remoteStatus: 'generating_doc' as const };
  await syncFromRemote(status);
  const once = (await db.jobs.get('job-sync-1'))!;
  await syncFromRemote(status);
  expect(await db.jobs.get('job-sync-1')).toEqual(once);

  await syncFromRemote({ jobId: 'job-sync-1', remoteStatus: 'completed', docId: 'doc-7' });
  const done = (await db.jobs.get('job-sync-1'))!;
  expect(done.localStatus).toBe('completed');
  expect(done.docId).toBe('doc-7');
  expect(done.stages.email).not.toBeNull();
});

it('maps a backend failure to a non-retryable local failure', async () => {
  await syncFromRemote({
    jobId: 'job-sync-1',
    remoteStatus: 'failed',
    error: { code: 'FFMPEG_CRASH', message: 'exit 137' },
  });
  const job = (await db.jobs.get('job-sync-1'))!;
  expect(job.localStatus).toBe('failed');
  expect(job.lastError?.code).toBe('FFMPEG_CRASH');
});
