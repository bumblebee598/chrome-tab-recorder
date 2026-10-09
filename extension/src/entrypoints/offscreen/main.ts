// MV3 recording host. The service worker cannot run MediaRecorder/getUserMedia,
// so this offscreen document (reason USER_MEDIA) consumes the tabCapture stream
// ID minted by the popup's click handler.
//
// Audio routing: tab -> ChannelMerger input 0 (left), mic -> input 1 (right),
// merger -> MediaStreamAudioDestination. The tab source is also connected to
// ctx.destination so the user keeps hearing the tab while recording. With a
// single audio source we record mono (channels=1 in the manifest).

import { db } from '@/lib/db';
import { applyEvent, nowIso } from '@/lib/jobs';
import { writeManifest, writeSegment } from '@/lib/opfs';
import type {
  MessageResponse,
  OffscreenMessage,
  StartRecordingPayload,
} from '@/lib/messages';

const TIMESLICE_MS = 5000;

interface ActiveRecording {
  jobId: string;
  recorder: MediaRecorder;
  audioContext: AudioContext | null;
  streams: MediaStream[];
  startedAt: number;
  startedAtIso: string;
  mimeType: string;
  channels: number;
  segmentCount: number;
  totalBytes: number;
  writeChain: Promise<void>;
  stopping: boolean;
}

let active: ActiveRecording | null = null;

browser.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: MessageResponse) => void) => {
    const msg = message as OffscreenMessage;
    if (msg?.target !== 'offscreen') return;

    if (msg.type === 'REC_START') {
      startRecording(msg.payload).then(
        () => sendResponse({ ok: true }),
        (error: unknown) => sendResponse({ ok: false, error: describe(error) }),
      );
      return true;
    }

    if (msg.type === 'REC_STOP') {
      stopRecording();
      sendResponse({ ok: true });
    }
  },
);

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function pickMimeType(mode: 'video' | 'audio'): string {
  if (mode === 'audio') return 'audio/webm;codecs=opus';
  const vp9 = 'video/webm;codecs=vp9,opus';
  return MediaRecorder.isTypeSupported(vp9) ? vp9 : 'video/webm;codecs=vp8,opus';
}

async function startRecording(payload: StartRecordingPayload): Promise<void> {
  if (active) throw new Error('A recording is already in progress');

  const streams: MediaStream[] = [];
  try {
    const { mode, sources, streamId, jobId } = payload;

    let tabStream: MediaStream | null = null;
    if (streamId && (mode === 'video' || sources.tab)) {
      const constraints = {
        audio: sources.tab
          ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
          : false,
        video:
          mode === 'video'
            ? {
                mandatory: {
                  chromeMediaSource: 'tab',
                  chromeMediaSourceId: streamId,
                  maxWidth: 1920,
                  maxHeight: 1080,
                  maxFrameRate: 30,
                },
              }
            : false,
      } as MediaStreamConstraints;
      tabStream = await navigator.mediaDevices.getUserMedia(constraints);
      streams.push(tabStream);
    }

    let micStream: MediaStream | null = null;
    if (sources.mic) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true },
      });
      streams.push(micStream);
    }

    const tabAudio = tabStream?.getAudioTracks()[0] ?? null;
    const micAudio = micStream?.getAudioTracks()[0] ?? null;
    const videoTrack = mode === 'video' ? (tabStream?.getVideoTracks()[0] ?? null) : null;

    let audioContext: AudioContext | null = null;
    let mixedTrack: MediaStreamTrack | null = null;
    let channels = 0;

    if (tabAudio || micAudio) {
      audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      if (tabAudio && micAudio) {
        channels = 2;
        destination.channelCount = 2;
        const merger = audioContext.createChannelMerger(2);
        const tabSource = audioContext.createMediaStreamSource(tabStream!);
        const micSource = audioContext.createMediaStreamSource(micStream!);
        tabSource.connect(merger, 0, 0); // left = tab
        micSource.connect(merger, 0, 1); // right = mic
        merger.connect(destination);
        tabSource.connect(audioContext.destination); // keep the tab audible
      } else {
        channels = 1;
        destination.channelCount = 1;
        const onlyStream = tabAudio ? tabStream! : micStream!;
        const source = audioContext.createMediaStreamSource(onlyStream);
        source.connect(destination);
        if (tabAudio) source.connect(audioContext.destination);
      }
      mixedTrack = destination.stream.getAudioTracks()[0] ?? null;
    }

    const tracks: MediaStreamTrack[] = [];
    if (videoTrack) tracks.push(videoTrack);
    if (mixedTrack) tracks.push(mixedTrack);
    if (tracks.length === 0) throw new Error('No tracks to record (all sources disabled)');

    const mimeType = pickMimeType(mode);
    const recorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType,
      videoBitsPerSecond: mode === 'video' ? 3_000_000 : undefined,
      audioBitsPerSecond: 128_000,
    });

    const startedAt = Date.now();
    active = {
      jobId,
      recorder,
      audioContext,
      streams,
      startedAt,
      startedAtIso: nowIso(),
      mimeType,
      channels,
      segmentCount: 0,
      totalBytes: 0,
      writeChain: Promise.resolve(),
      stopping: false,
    };

    recorder.ondataavailable = (event: BlobEvent) => {
      if (!active || active.recorder !== recorder || event.data.size === 0) return;
      const index = active.segmentCount;
      active.segmentCount += 1;
      active.totalBytes += event.data.size;
      const { segmentCount, totalBytes } = active;
      active.writeChain = active.writeChain
        .then(async () => {
          await writeSegment(jobId, index, event.data);
          await db.jobs.update(jobId, { segmentCount, totalBytes });
        })
        .catch((error: unknown) => {
          console.error('[tab-recorder] segment write failed', error);
          void failRecording(`SEGMENT_WRITE: ${describe(error)}`);
        });
    };

    recorder.onstop = () => void finalizeRecording();

    // Tab closed or capture revoked: stop cleanly with whatever we have.
    for (const track of [videoTrack, tabAudio]) {
      track?.addEventListener('ended', () => stopRecording());
    }

    recorder.start(TIMESLICE_MS);
  } catch (error) {
    for (const stream of streams) stream.getTracks().forEach((t) => t.stop());
    active = null;
    await applyEvent(payload.jobId, {
      type: 'RECORDING_FAILED',
      occurredAt: nowIso(),
      code: 'CAPTURE_START',
      message: describe(error),
    });
    throw error;
  }
}

function stopRecording(): void {
  if (!active || active.stopping) return;
  active.stopping = true;
  if (active.recorder.state !== 'inactive') {
    active.recorder.stop(); // final ondataavailable fires before onstop
  } else {
    void finalizeRecording();
  }
}

async function finalizeRecording(): Promise<void> {
  const rec = active;
  if (!rec) return;
  active = null;

  await rec.writeChain;
  cleanup(rec);

  if (rec.totalBytes === 0) {
    await applyEvent(rec.jobId, {
      type: 'RECORDING_FAILED',
      occurredAt: nowIso(),
      code: 'NO_DATA',
      message: 'Recording stopped before any data was captured',
    });
  } else {
    await writeManifest(rec.jobId, {
      jobId: rec.jobId,
      mimeType: rec.mimeType,
      channels: rec.channels,
      segmentCount: rec.segmentCount,
      totalBytes: rec.totalBytes,
      durationMs: Date.now() - rec.startedAt,
      startedAt: rec.startedAtIso,
      stoppedAt: nowIso(),
      recovered: false,
    });
    await applyEvent(rec.jobId, {
      type: 'RECORDING_FINISHED',
      occurredAt: nowIso(),
      totalBytes: rec.totalBytes,
    });
  }

  void browser.runtime.sendMessage({
    target: 'background',
    type: 'RECORDING_STOPPED',
    payload: { jobId: rec.jobId },
  });
}

async function failRecording(message: string): Promise<void> {
  const rec = active;
  if (!rec) return;
  active = null;
  cleanup(rec);
  if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  await applyEvent(rec.jobId, {
    type: 'RECORDING_FAILED',
    occurredAt: nowIso(),
    code: 'RECORDING_ERROR',
    message,
  });
  void browser.runtime.sendMessage({
    target: 'background',
    type: 'RECORDING_ERROR',
    payload: { jobId: rec.jobId, message },
  });
}

function cleanup(rec: ActiveRecording): void {
  for (const stream of rec.streams) stream.getTracks().forEach((t) => t.stop());
  void rec.audioContext?.close().catch(() => {});
}
