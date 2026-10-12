import { expect, it } from 'vitest';
import { STATUS_LABELS } from './status';

// The brief lists these status strings verbatim; the UI must use them unchanged.
it('UI status labels match the brief verbatim', () => {
  expect(STATUS_LABELS.pending_upload).toBe('Pending upload');
  expect(STATUS_LABELS.uploading).toBe('Uploading');
  expect(STATUS_LABELS.uploaded).toBe('Uploaded');
  expect(STATUS_LABELS.queued_for_transcription).toBe('Queued for transcription');
  expect(STATUS_LABELS.transcribing).toBe('Transcribing');
  expect(STATUS_LABELS.completed).toBe('Completed');
  expect(STATUS_LABELS.failed).toBe('Failed');
});
