// Mirrors shared/schema/job.schema.json and backend/app/domain/model.py.
// Parity is enforced by shared/fixtures/transitions.json running in both languages.

export type LocalStatus =
  | 'recording'
  | 'pending_upload'
  | 'uploading'
  | 'uploaded'
  | 'queued_for_transcription'
  | 'transcribing'
  | 'completed'
  | 'failed'
  | 'needs_sign_in';

export type RemoteStatus =
  | 'queued'
  | 'extracting_audio'
  | 'transcribing'
  | 'generating_doc'
  | 'emailing'
  | 'completed'
  | 'failed';

export type Mode = 'video' | 'audio';

export interface Sources {
  tab: boolean;
  mic: boolean;
}

export interface StageDone {
  completedAt: string;
}

export interface Stages {
  upload: StageDone | null;
  extractAudio: StageDone | null;
  transcribe: StageDone | null;
  generateDoc: StageDone | null;
  email: StageDone | null;
}

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface Job {
  jobId: string;
  name: string;
  createdAt: string;
  mode: Mode;
  sources: Sources;
  localStatus: LocalStatus;
  remoteStatus: RemoteStatus | null;
  uploadedBytes: number;
  totalBytes: number | null;
  segmentCount: number;
  recovered: boolean;
  driveSessionUri: string | null;
  driveFileId: string | null;
  driveFolderId: string | null;
  docId: string | null;
  transcriptId: string | null;
  attempts: number;
  nextRetryAt: string | null;
  lastError: JobError | null;
  stages: Stages;
}

export type EventType =
  | 'RECORDING_FINISHED'
  | 'RECORDING_FAILED'
  | 'UPLOAD_STARTED'
  | 'UPLOAD_PROGRESS'
  | 'UPLOAD_COMPLETED'
  | 'JOB_ENQUEUED'
  | 'EXTRACT_STARTED'
  | 'EXTRACT_COMPLETED'
  | 'TRANSCRIPT_SUBMITTED'
  | 'TRANSCRIPT_COMPLETED'
  | 'DOC_CREATED'
  | 'EMAIL_SENT'
  | 'STAGE_FAILED'
  | 'AUTH_REQUIRED'
  | 'SIGNED_IN'
  | 'RETRY';

export interface JobEvent {
  type: EventType;
  occurredAt: string;
  totalBytes?: number;
  recovered?: boolean;
  uploadedBytes?: number;
  driveFileId?: string;
  transcriptId?: string;
  docId?: string;
  code?: string;
  message?: string;
  retryable?: boolean;
}
