// Pure job state machine, mirrored by backend/app/domain/transitions.py.
// Both implementations must pass shared/fixtures/transitions.json. Keep them in
// lockstep: any rule change happens in the fixtures first, then in both languages.

import type { Job, JobEvent, LocalStatus, RemoteStatus } from './types';

const LOCAL_ORDER = [
  'recording',
  'pending_upload',
  'uploading',
  'uploaded',
  'queued_for_transcription',
  'transcribing',
  'completed',
] as const;

const REMOTE_ORDER = [
  'queued',
  'extracting_audio',
  'transcribing',
  'generating_doc',
  'emailing',
  'completed',
] as const;

export const BACKOFF_BASE_SECONDS = 30;
export const BACKOFF_CAP_SECONDS = 1800;
export const MAX_AUTO_ATTEMPTS = 10;

export function transition(job: Job, event: JobEvent): Job {
  // completed is absorbing: a late webhook or retry can never move the job backward
  if (job.localStatus === 'completed') return job;
  if (job.localStatus === 'failed' && event.type !== 'RETRY') return job;
  if (job.localStatus === 'needs_sign_in' && event.type !== 'SIGNED_IN') return job;
  if (
    job.localStatus === 'recording' &&
    event.type !== 'RECORDING_FINISHED' &&
    event.type !== 'RECORDING_FAILED'
  ) {
    return job;
  }

  switch (event.type) {
    case 'RECORDING_FINISHED':
      return recordingFinished(job, event);
    case 'RECORDING_FAILED':
      return recordingFailed(job, event);
    case 'UPLOAD_STARTED':
      return uploadStarted(job);
    case 'UPLOAD_PROGRESS':
      return uploadProgress(job, event);
    case 'UPLOAD_COMPLETED':
      return uploadCompleted(job, event);
    case 'JOB_ENQUEUED':
      return jobEnqueued(job);
    case 'EXTRACT_STARTED':
      return extractStarted(job);
    case 'EXTRACT_COMPLETED':
      return extractCompleted(job, event);
    case 'TRANSCRIPT_SUBMITTED':
      return transcriptSubmitted(job, event);
    case 'TRANSCRIPT_COMPLETED':
      return transcriptCompleted(job, event);
    case 'DOC_CREATED':
      return docCreated(job, event);
    case 'EMAIL_SENT':
      return emailSent(job, event);
    case 'STAGE_FAILED':
      return stageFailed(job, event);
    case 'AUTH_REQUIRED':
      return { ...job, localStatus: 'needs_sign_in' };
    case 'SIGNED_IN':
      return signedIn(job);
    case 'RETRY':
      return retry(job);
  }
}

function localRank(status: string): number {
  return LOCAL_ORDER.indexOf(status as (typeof LOCAL_ORDER)[number]);
}

function remoteRank(status: string): number {
  return REMOTE_ORDER.indexOf(status as (typeof REMOTE_ORDER)[number]);
}

function advanceLocal(current: LocalStatus, candidate: LocalStatus): LocalStatus {
  return localRank(candidate) > localRank(current) ? candidate : current;
}

function advanceRemote(current: RemoteStatus | null, candidate: RemoteStatus): RemoteStatus {
  if (current === null || remoteRank(candidate) > remoteRank(current)) return candidate;
  return current;
}

function formatTs(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nextRetryAt(occurredAt: string, attempts: number): string {
  const delay = Math.min(BACKOFF_BASE_SECONDS * 2 ** (attempts - 1), BACKOFF_CAP_SECONDS);
  return formatTs(Date.parse(occurredAt) + delay * 1000);
}

const CLEARED = { attempts: 0, lastError: null, nextRetryAt: null } as const;

function resumeRemote(job: Job): RemoteStatus {
  const { stages } = job;
  if (stages.extractAudio === null) return 'queued';
  if (stages.transcribe === null) return 'transcribing';
  if (stages.generateDoc === null) return 'generating_doc';
  if (stages.email === null) return 'emailing';
  return 'completed';
}

function resumeLocal(job: Job, remote: RemoteStatus | null): LocalStatus {
  if (job.stages.upload === null) {
    return job.driveSessionUri ? 'uploading' : 'pending_upload';
  }
  if (remote === null) return 'uploaded';
  if (remote === 'queued') return 'queued_for_transcription';
  if (
    remote === 'extracting_audio' ||
    remote === 'transcribing' ||
    remote === 'generating_doc' ||
    remote === 'emailing'
  ) {
    return 'transcribing';
  }
  if (remote === 'completed') return 'completed';
  return 'failed';
}

function recordingFinished(job: Job, event: JobEvent): Job {
  if (job.localStatus !== 'recording') return job;
  return {
    ...job,
    localStatus: 'pending_upload',
    totalBytes: event.totalBytes ?? job.totalBytes,
    recovered: event.recovered ? true : job.recovered,
  };
}

function recordingFailed(job: Job, event: JobEvent): Job {
  if (job.localStatus !== 'recording') return job;
  return {
    ...job,
    localStatus: 'failed',
    lastError: {
      code: event.code ?? 'RECORDING_ERROR',
      message: event.message ?? '',
      retryable: false,
    },
  };
}

function uploadStarted(job: Job): Job {
  if (localRank(job.localStatus) >= localRank('uploading')) return job;
  return { ...job, localStatus: 'uploading' };
}

function uploadProgress(job: Job, event: JobEvent): Job {
  if (job.localStatus !== 'uploading' || event.uploadedBytes === undefined) return job;
  if (event.uploadedBytes <= job.uploadedBytes) return job;
  return { ...job, uploadedBytes: event.uploadedBytes };
}

function uploadCompleted(job: Job, event: JobEvent): Job {
  if (localRank(job.localStatus) >= localRank('uploaded')) return job;
  return {
    ...job,
    localStatus: 'uploaded',
    driveFileId: event.driveFileId ?? null,
    uploadedBytes: job.totalBytes ?? job.uploadedBytes,
    stages: { ...job.stages, upload: { completedAt: event.occurredAt } },
    ...CLEARED,
  };
}

function jobEnqueued(job: Job): Job {
  if (job.stages.upload === null) return job;
  if (localRank(job.localStatus) >= localRank('queued_for_transcription')) return job;
  return {
    ...job,
    localStatus: 'queued_for_transcription',
    remoteStatus: advanceRemote(job.remoteStatus, 'queued'),
    ...CLEARED,
  };
}

function extractStarted(job: Job): Job {
  if (job.remoteStatus !== null && remoteRank(job.remoteStatus) >= remoteRank('extracting_audio')) {
    return job;
  }
  return {
    ...job,
    remoteStatus: 'extracting_audio',
    localStatus: advanceLocal(job.localStatus, 'transcribing'),
    ...CLEARED,
  };
}

function extractCompleted(job: Job, event: JobEvent): Job {
  if (job.stages.extractAudio !== null) return job;
  return {
    ...job,
    stages: { ...job.stages, extractAudio: { completedAt: event.occurredAt } },
    remoteStatus: advanceRemote(job.remoteStatus, 'extracting_audio'),
    localStatus: advanceLocal(job.localStatus, 'transcribing'),
    ...CLEARED,
  };
}

function transcriptSubmitted(job: Job, event: JobEvent): Job {
  if (job.remoteStatus !== null && remoteRank(job.remoteStatus) >= remoteRank('transcribing')) {
    return job;
  }
  return {
    ...job,
    remoteStatus: 'transcribing',
    transcriptId: event.transcriptId ?? null,
    localStatus: advanceLocal(job.localStatus, 'transcribing'),
    ...CLEARED,
  };
}

function transcriptCompleted(job: Job, event: JobEvent): Job {
  if (job.stages.transcribe !== null) return job;
  return {
    ...job,
    stages: { ...job.stages, transcribe: { completedAt: event.occurredAt } },
    remoteStatus: advanceRemote(job.remoteStatus, 'generating_doc'),
    localStatus: advanceLocal(job.localStatus, 'transcribing'),
    ...CLEARED,
  };
}

function docCreated(job: Job, event: JobEvent): Job {
  if (job.stages.generateDoc !== null) return job;
  return {
    ...job,
    docId: event.docId ?? null,
    stages: { ...job.stages, generateDoc: { completedAt: event.occurredAt } },
    remoteStatus: advanceRemote(job.remoteStatus, 'emailing'),
    localStatus: advanceLocal(job.localStatus, 'transcribing'),
    ...CLEARED,
  };
}

function emailSent(job: Job, event: JobEvent): Job {
  if (job.stages.email !== null) return job;
  return {
    ...job,
    stages: { ...job.stages, email: { completedAt: event.occurredAt } },
    remoteStatus: 'completed',
    localStatus: 'completed',
    ...CLEARED,
  };
}

function stageFailed(job: Job, event: JobEvent): Job {
  const error = {
    code: event.code ?? 'UNKNOWN',
    message: event.message ?? '',
    retryable: Boolean(event.retryable),
  };
  if (event.retryable) {
    const attempts = job.attempts + 1;
    if (attempts >= MAX_AUTO_ATTEMPTS) {
      return {
        ...job,
        lastError: error,
        attempts,
        nextRetryAt: null,
        localStatus: 'failed',
        remoteStatus: job.remoteStatus !== null ? 'failed' : null,
      };
    }
    return {
      ...job,
      lastError: error,
      attempts,
      nextRetryAt: nextRetryAt(event.occurredAt, attempts),
    };
  }
  return {
    ...job,
    lastError: error,
    localStatus: 'failed',
    remoteStatus: job.remoteStatus !== null ? 'failed' : null,
  };
}

function signedIn(job: Job): Job {
  if (job.localStatus !== 'needs_sign_in') return job;
  return { ...job, localStatus: resumeLocal(job, job.remoteStatus), ...CLEARED };
}

function retry(job: Job): Job {
  if (job.localStatus !== 'failed') return job;
  const remote = job.remoteStatus !== null ? resumeRemote(job) : null;
  return {
    ...job,
    localStatus: resumeLocal(job, remote),
    remoteStatus: remote,
    ...CLEARED,
  };
}
