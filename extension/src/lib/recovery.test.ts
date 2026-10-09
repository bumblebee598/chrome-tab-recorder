import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from './db';
import { createRecordingJob } from './jobs';
import { recoverInterruptedJobs, type RecoveryDeps } from './recovery';
import { segmentName } from './opfs';

const sources = { tab: true, mic: true };

function deps(statsByJob: Record<string, { count: number; bytes: number }>): RecoveryDeps {
  return {
    getStats: vi.fn(async (jobId: string) => statsByJob[jobId] ?? { count: 0, bytes: 0 }),
    ensureManifest: vi.fn(async () => {}),
  };
}

beforeEach(async () => {
  await db.jobs.clear();
});

it('marks an interrupted recording with segments as pending_upload (recovered)', async () => {
  const job = createRecordingJob({ jobId: 'job-crashed', name: 'Crashed', mode: 'video', sources });
  await db.jobs.put(job);

  await recoverInterruptedJobs(null, deps({ 'job-crashed': { count: 7, bytes: 123456 } }));

  const recovered = await db.jobs.get('job-crashed');
  expect(recovered?.localStatus).toBe('pending_upload');
  expect(recovered?.recovered).toBe(true);
  expect(recovered?.totalBytes).toBe(123456);
  expect(recovered?.segmentCount).toBe(7);
});

it('fails an interrupted recording that produced no segments', async () => {
  const job = createRecordingJob({ jobId: 'job-empty', name: 'Empty', mode: 'audio', sources });
  await db.jobs.put(job);

  await recoverInterruptedJobs(null, deps({}));

  const failed = await db.jobs.get('job-empty');
  expect(failed?.localStatus).toBe('failed');
  expect(failed?.lastError?.code).toBe('NO_DATA');
});

it('leaves the actively recording job alone', async () => {
  const job = createRecordingJob({ jobId: 'job-live', name: 'Live', mode: 'video', sources });
  await db.jobs.put(job);

  await recoverInterruptedJobs('job-live', deps({ 'job-live': { count: 2, bytes: 100 } }));

  expect((await db.jobs.get('job-live'))?.localStatus).toBe('recording');
});

it('pads segment names to six digits', () => {
  expect(segmentName(0)).toBe('seg-000000.webm');
  expect(segmentName(123)).toBe('seg-000123.webm');
});
