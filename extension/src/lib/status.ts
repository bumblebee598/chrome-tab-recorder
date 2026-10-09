import { MAX_AUTO_ATTEMPTS } from './state/transition';
import type { Job, LocalStatus } from './state/types';

export const STATUS_LABELS: Record<LocalStatus, string> = {
  recording: 'Recording',
  pending_upload: 'Ready to upload',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  queued_for_transcription: 'Queued',
  transcribing: 'Transcribing',
  completed: 'Completed',
  failed: 'Failed',
  needs_sign_in: 'Sign-in needed',
};

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Human retry status, e.g. "attempt 3 · next try in 2m" */
export function retryLine(job: Job, now: number = Date.now()): string | null {
  if (job.localStatus === 'failed') {
    if (job.lastError?.retryable && job.attempts >= MAX_AUTO_ATTEMPTS) {
      return 'Stopped after 10 tries — press Retry';
    }
    return null;
  }
  if (!job.nextRetryAt || job.attempts === 0) return null;
  const dueMs = Date.parse(job.nextRetryAt) - now;
  const due = dueMs <= 0 ? 'now' : dueMs < 60_000 ? `in ${Math.ceil(dueMs / 1000)}s` : `in ${Math.ceil(dueMs / 60_000)}m`;
  return `attempt ${job.attempts} · next try ${due}`;
}

const ERROR_MESSAGES: Record<string, string> = {
  NETWORK: 'Connection lost',
  SESSION_EXPIRED: 'Upload link expired',
  UPLOAD_INCOMPLETE: "Upload didn't finish",
  QUOTA_EXCEEDED: 'Google Drive is full',
  NO_DATA: 'Nothing was captured',
  NO_LOCAL_DATA: 'Local recording is missing',
  CAPTURE_START: "Recording couldn't start",
  START_REJECTED: "Recording couldn't start",
  SEGMENT_WRITE: 'Ran out of disk space while recording',
  RECORDING_ERROR: 'Recording stopped unexpectedly',
  AUTH_EXPIRED: 'Signed out — sign in again',
  USER_AUTH: 'Google access expired — sign in again',
  NO_AUDIO: 'Recording has no audio to transcribe',
  FFMPEG_CRASH: 'Processing failed',
  TRANSCRIPT_ERROR: 'Transcription failed',
  TRANSCRIPT_TIMEOUT: 'Transcription timed out',
  DOC_FAILED: "Couldn't create the transcript Doc",
  EMAIL_FAILED: "Couldn't send the email",
  BACKEND_UNREACHABLE: "Couldn't reach the server",
  BACKEND_FAILED: 'Processing failed',
};

/** Short, human description of a failure. Raw code+message belong in tooltips/console only. */
export function humanError(error: Job['lastError']): string {
  if (!error) return '';
  if (ERROR_MESSAGES[error.code]) return ERROR_MESSAGES[error.code];
  if (error.code.startsWith('HTTP_')) return 'Upload failed';
  return 'Something went wrong';
}

const STAGE_DETAILS: Partial<Record<NonNullable<Job['remoteStatus']>, string>> = {
  queued: 'Waiting in line',
  extracting_audio: 'Preparing audio',
  transcribing: 'Transcribing',
  generating_doc: 'Writing the transcript',
  emailing: 'Sending the email',
};

/** Chip text: specific backend stage when one is active, plain status otherwise. */
export function chipLabel(job: Job): string {
  if (
    (job.localStatus === 'transcribing' || job.localStatus === 'queued_for_transcription') &&
    job.remoteStatus &&
    STAGE_DETAILS[job.remoteStatus]
  ) {
    return STAGE_DETAILS[job.remoteStatus]!;
  }
  return STATUS_LABELS[job.localStatus];
}

/** Backend-active jobs can wedge if queue retries run out; offer manual retry. */
export function canRetryBackend(job: Job): boolean {
  return (
    job.driveFileId !== null &&
    (job.localStatus === 'queued_for_transcription' || job.localStatus === 'transcribing')
  );
}

export function driveLink(job: Job): string | null {
  return job.driveFileId ? `https://drive.google.com/file/d/${job.driveFileId}/view` : null;
}

export function docLink(job: Job): string | null {
  return job.docId ? `https://docs.google.com/document/d/${job.docId}/edit` : null;
}
