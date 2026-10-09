// Assembles OPFS segments into one Blob and triggers a download. Runs in a
// full tab (not the popup) because the blob URL must outlive the download, and
// the popup dies the moment it loses focus. Blob parts are disk-backed Files,
// so multi-GB recordings do not load into memory.

import { db } from '@/lib/db';
import { readManifest, segmentFiles } from '@/lib/opfs';

const statusEl = document.getElementById('status')!;

async function run(): Promise<void> {
  const jobId = new URLSearchParams(location.search).get('jobId');
  if (!jobId) {
    fail('Missing jobId in the URL.');
    return;
  }

  const job = await db.jobs.get(jobId);
  const manifest = await readManifest(jobId);
  const files = await segmentFiles(jobId).catch(() => []);
  if (files.length === 0) {
    fail('No recorded segments found for this job.');
    return;
  }

  const blob = new Blob(files, { type: manifest?.mimeType ?? 'video/webm' });
  const url = URL.createObjectURL(blob);
  const name = (job?.name ?? jobId).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name}.webm`;
  anchor.click();

  statusEl.textContent =
    `Download started (${files.length} segment${files.length === 1 ? '' : 's'}, ` +
    `${(blob.size / 1e6).toFixed(1)} MB). Keep this tab open until it finishes.`;
}

function fail(message: string): void {
  statusEl.textContent = message;
  statusEl.className = 'err';
}

void run();
