import { db } from './db';
import { transition } from './state/transition';
import type { Job, JobEvent, Mode, Sources } from './state/types';

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function createRecordingJob(opts: {
  jobId: string;
  name: string;
  mode: Mode;
  sources: Sources;
}): Job {
  return {
    jobId: opts.jobId,
    name: opts.name,
    createdAt: nowIso(),
    mode: opts.mode,
    sources: opts.sources,
    localStatus: 'recording',
    remoteStatus: null,
    uploadedBytes: 0,
    totalBytes: null,
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
}

/** Load → transition → store, atomically. Returns the updated job, or undefined if unknown. */
export async function applyEvent(jobId: string, event: JobEvent): Promise<Job | undefined> {
  return db.transaction('rw', db.jobs, async () => {
    const job = await db.jobs.get(jobId);
    if (!job) return undefined;
    const next = transition(job, event);
    await db.jobs.put(next);
    return next;
  });
}
