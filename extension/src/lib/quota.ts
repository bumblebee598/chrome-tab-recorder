import type { Mode } from './state/types';

const TWO_HOURS_S = 2 * 60 * 60;
const VIDEO_BPS = 3_000_000 + 128_000;
const AUDIO_BPS = 128_000;

export function projectedBytes(mode: Mode): number {
  const bps = mode === 'video' ? VIDEO_BPS : AUDIO_BPS;
  return Math.ceil((bps / 8) * TWO_HOURS_S);
}

export interface QuotaCheck {
  ok: boolean;
  warning: string | null;
  freeBytes: number;
  projected: number;
}

/** Below this even short recordings risk dying mid-write. */
const HARD_FLOOR_BYTES = 500 * 1e6;

export async function checkQuota(mode: Mode): Promise<QuotaCheck> {
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const free = quota - usage;
  const projected = projectedBytes(mode);
  if (free < HARD_FLOOR_BYTES) {
    return {
      ok: false,
      warning: `Critically low disk space (${formatBytes(free)} free) — free up space to record.`,
      freeBytes: free,
      projected,
    };
  }
  if (free < 1.5 * projected) {
    return {
      ok: true,
      warning: `Low disk space: ${formatBytes(free)} free. A full 2-hour ${mode} recording needs ~${formatBytes(projected)} — shorter recordings are fine.`,
      freeBytes: free,
      projected,
    };
  }
  return { ok: true, warning: null, freeBytes: free, projected };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} kB`;
  return `${bytes} B`;
}
