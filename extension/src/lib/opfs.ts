// OPFS layout: /recordings/{jobId}/seg-000000.webm ... + manifest.json
// One file per MediaRecorder timeslice: FileSystemWritableFileStream only
// commits on close(), so short-lived per-segment writers bound crash loss to
// one timeslice (~5s) instead of the whole recording.

const RECORDINGS_DIR = 'recordings';
const MANIFEST_NAME = 'manifest.json';
const SEGMENT_PATTERN = /^seg-\d{6}\.webm$/;

export interface RecordingManifest {
  jobId: string;
  mimeType: string;
  /** 0 = no audio, 1 = mono single source, 2 = stereo L=tab / R=mic */
  channels: number;
  segmentCount: number;
  totalBytes: number;
  /** wall-clock duration; null when the recording was recovered after a crash */
  durationMs: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  recovered: boolean;
}

export interface SegmentInfo {
  name: string;
  size: number;
}

export function segmentName(index: number): string {
  return `seg-${String(index).padStart(6, '0')}.webm`;
}

async function jobDir(jobId: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const recordings = await root.getDirectoryHandle(RECORDINGS_DIR, { create });
  return recordings.getDirectoryHandle(jobId, { create });
}

type IterableDir = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

export async function writeSegment(jobId: string, index: number, data: Blob): Promise<void> {
  const dir = await jobDir(jobId, true);
  const file = await dir.getFileHandle(segmentName(index), { create: true });
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function writeManifest(jobId: string, manifest: RecordingManifest): Promise<void> {
  const dir = await jobDir(jobId, true);
  const file = await dir.getFileHandle(MANIFEST_NAME, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(manifest, null, 2));
  await writable.close();
}

export async function readManifest(jobId: string): Promise<RecordingManifest | null> {
  try {
    const dir = await jobDir(jobId, false);
    const handle = await dir.getFileHandle(MANIFEST_NAME);
    const file = await handle.getFile();
    return JSON.parse(await file.text()) as RecordingManifest;
  } catch {
    return null;
  }
}

export async function listSegments(jobId: string): Promise<SegmentInfo[]> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await jobDir(jobId, false);
  } catch {
    return [];
  }
  const segments: SegmentInfo[] = [];
  for await (const [name, handle] of (dir as IterableDir).entries()) {
    if (handle.kind === 'file' && SEGMENT_PATTERN.test(name)) {
      const file = await (handle as FileSystemFileHandle).getFile();
      segments.push({ name, size: file.size });
    }
  }
  segments.sort((a, b) => a.name.localeCompare(b.name));
  return segments;
}

export async function segmentStats(jobId: string): Promise<{ count: number; bytes: number }> {
  const segments = await listSegments(jobId);
  return { count: segments.length, bytes: segments.reduce((sum, s) => sum + s.size, 0) };
}

/** Disk-backed Files in order, suitable as lazy Blob parts for playback/download. */
export async function segmentFiles(jobId: string): Promise<File[]> {
  const dir = await jobDir(jobId, false);
  const names = (await listSegments(jobId)).map((s) => s.name);
  const files: File[] = [];
  for (const name of names) {
    const handle = await dir.getFileHandle(name);
    files.push(await handle.getFile());
  }
  return files;
}

/** The whole recording as one lazy, disk-backed Blob (safe for multi-GB files). */
export async function recordingBlob(
  jobId: string,
): Promise<{ blob: Blob; mimeType: string } | null> {
  const files = await segmentFiles(jobId).catch(() => []);
  if (files.length === 0) return null;
  const manifest = await readManifest(jobId);
  const mimeType = manifest?.mimeType ?? 'video/webm';
  return { blob: new Blob(files, { type: mimeType }), mimeType };
}

export async function deleteRecording(jobId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const recordings = await root.getDirectoryHandle(RECORDINGS_DIR, { create: false });
    await recordings.removeEntry(jobId, { recursive: true });
  } catch {
    // already gone
  }
}
