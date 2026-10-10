import { expect, it } from 'vitest';
import { canRetryBackend, chipLabel, humanError, STATUS_LABELS } from './status';
import type { Job, LocalStatus, RemoteStatus } from './state/types';

function job(overrides: Partial<Job>): Job {
  return {
    jobId: 'j',
    name: 'n',
    createdAt: '2026-10-10T10:00:00Z',
    mode: 'video',
    sources: { tab: true, mic: true },
    localStatus: 'pending_upload',
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
    ...overrides,
  };
}

it('every local status renders a label', () => {
  const statuses: LocalStatus[] = [
    'recording', 'pending_upload', 'uploading', 'uploaded',
    'queued_for_transcription', 'transcribing', 'completed', 'failed', 'needs_sign_in',
  ];
  for (const localStatus of statuses) {
    expect(chipLabel(job({ localStatus }))).toBeTruthy();
    expect(STATUS_LABELS[localStatus]).toBeTruthy();
  }
});

it('backend stages get specific chip labels', () => {
  const expectations: [RemoteStatus, string][] = [
    ['extracting_audio', 'Preparing audio'],
    ['transcribing', 'Transcribing'],
    ['generating_doc', 'Writing the transcript'],
    ['emailing', 'Sending the email'],
  ];
  for (const [remoteStatus, label] of expectations) {
    expect(chipLabel(job({ localStatus: 'transcribing', remoteStatus }))).toBe(label);
  }
});

it('humanError maps known codes, HTTP codes, and unknowns', () => {
  expect(humanError({ code: 'QUOTA_EXCEEDED', message: '', retryable: false })).toBe(
    'Google Drive is full',
  );
  expect(humanError({ code: 'HTTP_500', message: '', retryable: true })).toBe('Upload failed');
  expect(humanError({ code: 'WHO_KNOWS', message: '', retryable: false })).toBe(
    'Something went wrong',
  );
});

it('backend retry only offered once the file reached Drive', () => {
  expect(canRetryBackend(job({ localStatus: 'transcribing', driveFileId: 'd' }))).toBe(true);
  expect(canRetryBackend(job({ localStatus: 'transcribing', driveFileId: null }))).toBe(false);
  expect(canRetryBackend(job({ localStatus: 'uploading', driveFileId: 'd' }))).toBe(false);
});
