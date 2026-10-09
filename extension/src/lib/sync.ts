// Applies a backend-reported status onto the local job by replaying the event
// ladder up to that status. Every event is guarded and monotonic, so replaying
// the whole ladder on each poll is safe — already-applied steps are no-ops.

import { applyEvent, nowIso } from './jobs';
import type { RemoteJobStatus } from './api';
import type { RemoteStatus } from './state/types';

const REMOTE_RANK: Record<Exclude<RemoteStatus, 'failed'>, number> = {
  queued: 0,
  extracting_audio: 1,
  transcribing: 2,
  generating_doc: 3,
  emailing: 4,
  completed: 5,
};

export async function syncFromRemote(status: RemoteJobStatus): Promise<void> {
  const { jobId, remoteStatus } = status;
  const occurredAt = nowIso();

  if (remoteStatus === 'failed') {
    await applyEvent(jobId, {
      type: 'STAGE_FAILED',
      occurredAt,
      code: status.error?.code ?? 'BACKEND_FAILED',
      message: status.error?.message ?? 'The backend reported a failure',
      retryable: false,
    });
    return;
  }

  const rank = REMOTE_RANK[remoteStatus];
  if (rank >= REMOTE_RANK.queued) {
    await applyEvent(jobId, { type: 'JOB_ENQUEUED', occurredAt });
  }
  if (rank >= REMOTE_RANK.extracting_audio) {
    await applyEvent(jobId, { type: 'EXTRACT_STARTED', occurredAt });
  }
  if (rank >= REMOTE_RANK.transcribing) {
    await applyEvent(jobId, { type: 'EXTRACT_COMPLETED', occurredAt });
    await applyEvent(jobId, {
      type: 'TRANSCRIPT_SUBMITTED',
      occurredAt,
      transcriptId: status.transcriptId ?? undefined,
    });
  }
  if (rank >= REMOTE_RANK.generating_doc) {
    await applyEvent(jobId, { type: 'TRANSCRIPT_COMPLETED', occurredAt });
  }
  if (rank >= REMOTE_RANK.emailing) {
    await applyEvent(jobId, {
      type: 'DOC_CREATED',
      occurredAt,
      docId: status.docId ?? undefined,
    });
  }
  if (rank >= REMOTE_RANK.completed) {
    await applyEvent(jobId, { type: 'EMAIL_SENT', occurredAt });
  }
}
