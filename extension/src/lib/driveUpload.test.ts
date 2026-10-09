import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from './db';
import { createRecordingJob } from './jobs';
import { uploadJob } from './driveUpload';
import type { TokenProvider } from './auth';
import type { Job } from './state/types';

vi.mock('./opfs', () => ({
  recordingBlob: vi.fn(async () => ({
    blob: new Blob(['0123456789'], { type: 'video/webm' }),
    mimeType: 'video/webm',
  })),
}));

const token: TokenProvider = { getAccessToken: async () => 'test-token' };
const noToken: TokenProvider = { getAccessToken: async () => null };
const renew = async () => true;

type Call = { url: string; init: RequestInit };
let calls: Call[];

function queueResponses(...list: Response[]): void {
  const responses = [...list];
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error('unexpected fetch call');
      return next;
    }),
  );
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function pendingJob(overrides: Partial<Job> = {}): Job {
  const base = createRecordingJob({
    jobId: 'job-up-1',
    name: 'My recording',
    mode: 'video',
    sources: { tab: true, mic: true },
  });
  return { ...base, localStatus: 'pending_upload', totalBytes: 10, segmentCount: 2, ...overrides };
}

beforeEach(async () => {
  await db.jobs.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('uploads a fresh job: folder, dedup check, session, chunk, completed', async () => {
  const job = pendingJob();
  await db.jobs.put(job);
  queueResponses(
    json(200, { files: [{ id: 'folder-1' }] }), // folder search
    json(200, { files: [] }), // dedup check: nothing to adopt
    new Response(null, { status: 200, headers: { Location: 'https://upload.session/1' } }),
    json(200, { id: 'drive-file-9' }),
  );

  const outcome = await uploadJob(job, { auth: token, renew });

  expect(outcome).toBe('completed');
  const stored = (await db.jobs.get(job.jobId))!;
  expect(stored.localStatus).toBe('uploaded');
  expect(stored.driveFileId).toBe('drive-file-9');
  expect(stored.driveFolderId).toBe('folder-1');
  expect(stored.stages.upload).not.toBeNull();
  expect(calls[3].init.headers).toMatchObject({ 'Content-Range': 'bytes 0-9/10' });
});

it('skips everything when driveFileId is already recorded', async () => {
  const job = pendingJob({ localStatus: 'uploading', driveFileId: 'drive-done' });
  await db.jobs.put(job);
  queueResponses(); // zero fetches allowed

  const outcome = await uploadJob(job, { auth: token, renew });

  expect(outcome).toBe('completed');
  expect((await db.jobs.get(job.jobId))?.localStatus).toBe('uploaded');
});

it('resumes an interrupted session from the committed offset', async () => {
  const job = pendingJob({
    localStatus: 'uploading',
    driveFolderId: 'folder-1',
    driveSessionUri: 'https://upload.session/resume',
    uploadedBytes: 5,
  });
  await db.jobs.put(job);
  queueResponses(
    new Response(null, { status: 308, headers: { Range: 'bytes=0-4' } }), // probe
    json(200, { id: 'drive-file-9' }),
  );

  const outcome = await uploadJob(job, { auth: token, renew });

  expect(outcome).toBe('completed');
  expect(calls[1].init.headers).toMatchObject({ 'Content-Range': 'bytes 5-9/10' });
});

it('expired session adopts the file a previous attempt already created', async () => {
  const job = pendingJob({
    localStatus: 'uploading',
    driveFolderId: 'folder-1',
    driveSessionUri: 'https://upload.session/dead',
    uploadedBytes: 5,
  });
  await db.jobs.put(job);
  queueResponses(
    new Response(null, { status: 404 }), // probe: session gone
    json(200, { files: [{ id: 'drive-adopted' }] }), // dedup query finds the file
  );

  const outcome = await uploadJob(job, { auth: token, renew });

  expect(outcome).toBe('completed');
  const stored = (await db.jobs.get(job.jobId))!;
  expect(stored.driveFileId).toBe('drive-adopted');
  expect(stored.driveSessionUri).toBeNull();
  expect(stored.localStatus).toBe('uploaded');
});

it('expired session with nothing to adopt opens a fresh session in the same run', async () => {
  const job = pendingJob({
    localStatus: 'uploading',
    driveFolderId: 'folder-1',
    driveSessionUri: 'https://upload.session/dead',
    uploadedBytes: 5,
  });
  await db.jobs.put(job);
  queueResponses(
    new Response(null, { status: 404 }), // probe
    json(200, { files: [] }), // nothing to adopt
    new Response(null, { status: 200, headers: { Location: 'https://upload.session/new' } }),
    json(200, { id: 'drive-file-9' }),
  );

  const outcome = await uploadJob(job, { auth: token, renew });

  expect(outcome).toBe('completed');
  expect(calls[3].init.headers).toMatchObject({ 'Content-Range': 'bytes 0-9/10' });
});

it('pauses to needs_sign_in without a token', async () => {
  const job = pendingJob();
  await db.jobs.put(job);
  queueResponses();

  const outcome = await uploadJob(job, { auth: noToken, renew });

  expect(outcome).toBe('needs_sign_in');
  expect((await db.jobs.get(job.jobId))?.localStatus).toBe('needs_sign_in');
});

it('retries the same chunk once with a refreshed token after a 401', async () => {
  const tokens = ['stale-token', 'fresh-token'];
  const refreshing: TokenProvider = {
    getAccessToken: async (force?: boolean) => (force ? 'fresh-token' : tokens[0]),
  };
  const job = pendingJob({ driveFolderId: 'folder-1' });
  await db.jobs.put(job);
  queueResponses(
    json(200, { files: [] }), // dedup check
    new Response(null, { status: 200, headers: { Location: 'https://upload.session/2' } }),
    new Response(null, { status: 401 }), // chunk rejected
    json(200, { id: 'drive-file-9' }), // same chunk, fresh token
  );

  const outcome = await uploadJob(job, { auth: refreshing, renew });

  expect(outcome).toBe('completed');
  expect(calls[3].init.headers).toMatchObject({
    Authorization: 'Bearer fresh-token',
    'Content-Range': 'bytes 0-9/10',
  });
});

it('a second 401 after refreshing pauses the job', async () => {
  const job = pendingJob({
    localStatus: 'uploading',
    driveFolderId: 'folder-1',
    driveSessionUri: 'https://upload.session/3',
  });
  await db.jobs.put(job);
  queueResponses(new Response(null, { status: 401 }), new Response(null, { status: 401 }));

  const outcome = await uploadJob(job, { auth: token, renew });

  expect(outcome).toBe('needs_sign_in');
  expect((await db.jobs.get(job.jobId))?.localStatus).toBe('needs_sign_in');
});
