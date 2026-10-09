import { db } from './db';
import { applyEvent, nowIso } from './jobs';
import { segmentStats, readManifest, writeManifest } from './opfs';
import type { Job } from './state/types';

export interface RecoveryDeps {
  getStats: (jobId: string) => Promise<{ count: number; bytes: number }>;
  ensureManifest: (job: Job, stats: { count: number; bytes: number }) => Promise<void>;
}

const defaultDeps: RecoveryDeps = {
  getStats: segmentStats,
  ensureManifest: async (job, stats) => {
    if (await readManifest(job.jobId)) return;
    await writeManifest(job.jobId, {
      jobId: job.jobId,
      mimeType: job.mode === 'video' ? 'video/webm' : 'audio/webm',
      channels: job.sources.tab && job.sources.mic ? 2 : job.sources.tab || job.sources.mic ? 1 : 0,
      segmentCount: stats.count,
      totalBytes: stats.bytes,
      durationMs: null,
      startedAt: job.createdAt,
      stoppedAt: null,
      recovered: true,
    });
  },
};

/**
 * Salvage jobs left in `recording` after a crash or browser restart: segments
 * on disk -> Pending upload (recovered); nothing written -> failed. The job
 * currently being recorded (activeJobId) is left alone.
 */
export async function recoverInterruptedJobs(
  activeJobId: string | null,
  deps: RecoveryDeps = defaultDeps,
): Promise<void> {
  const interrupted = await db.jobs.where('localStatus').equals('recording').toArray();
  for (const job of interrupted) {
    if (job.jobId === activeJobId) continue;
    const stats = await deps.getStats(job.jobId);
    if (stats.count > 0) {
      await deps.ensureManifest(job, stats);
      await db.jobs.update(job.jobId, { segmentCount: stats.count });
      await applyEvent(job.jobId, {
        type: 'RECORDING_FINISHED',
        occurredAt: nowIso(),
        totalBytes: stats.bytes,
        recovered: true,
      });
    } else {
      await applyEvent(job.jobId, {
        type: 'RECORDING_FAILED',
        occurredAt: nowIso(),
        code: 'NO_DATA',
        message: 'Recording was interrupted before any data was saved',
      });
    }
  }
}
