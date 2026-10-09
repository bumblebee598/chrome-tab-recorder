import { signIn } from '@/lib/auth';
import { sweepVerifiedUploads } from '@/lib/cleanup';
import { db } from '@/lib/db';
import { applyEvent, createRecordingJob, nowIso } from '@/lib/jobs';
import { runQueue } from '@/lib/queue';
import { recoverInterruptedJobs } from '@/lib/recovery';
import {
  DEFAULT_PREFS,
  REC_STATE_KEY,
  type BackgroundMessage,
  type MessageResponse,
  type RecSessionState,
  type RecordingPrefs,
  type StartRecordingPayload,
} from '@/lib/messages';

interface SenderInfo {
  tab?: { id?: number; title?: string };
}

export default defineBackground(() => {
  void browser.alarms.create('job-heartbeat', { periodInMinutes: 1 });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'job-heartbeat') void heartbeat();
  });

  browser.runtime.onStartup.addListener(() => void heartbeat());
  browser.runtime.onInstalled.addListener(() => void heartbeat());

  browser.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse: (response: MessageResponse) => void) => {
      const msg = message as BackgroundMessage;
      if (msg?.target !== 'background') return;

      const handled = (async (): Promise<Partial<MessageResponse> | void> => {
        switch (msg.type) {
          case 'START_RECORDING':
            return startRecording(msg.payload);
          case 'START_FROM_WIDGET':
            return startFromWidget(sender as SenderInfo);
          case 'STOP_RECORDING':
            return handleStop();
          case 'GET_REC_STATE': {
            const recState = await getRecState();
            const senderTabId = (sender as SenderInfo).tab?.id;
            return {
              recState,
              isRecordingThisTab:
                recState !== null && senderTabId !== undefined && recState.tabId === senderTabId,
            };
          }
          case 'KICK_QUEUE':
            void runQueue();
            return;
          case 'SIGN_IN': {
            const { email } = await signIn();
            void runQueue(); // paused jobs just resumed
            return { email };
          }
          case 'RECORDING_STOPPED':
          case 'RECORDING_ERROR':
            await clearRecordingState();
            await browser.offscreen.closeDocument().catch(() => {});
            void runQueue(); // freshly finished recording -> try uploading now
            return;
        }
      })();

      handled.then(
        (extra) => sendResponse({ ok: true, ...extra }),
        (error: unknown) =>
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
      return true;
    },
  );
});

async function heartbeat(): Promise<void> {
  const activeJobId = (await getRecState())?.jobId ?? null;
  await recoverInterruptedJobs(activeJobId);
  await runQueue();
  await sweepVerifiedUploads().catch(() => {});
}

async function getRecState(): Promise<RecSessionState | null> {
  const stored = await browser.storage.session.get(REC_STATE_KEY);
  return (stored[REC_STATE_KEY] as RecSessionState | undefined) ?? null;
}

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;
  await browser.offscreen.createDocument({
    url: '/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification:
      'MediaRecorder and getUserMedia for tab + microphone capture must run outside the service worker.',
  });
}

async function startRecording(payload: StartRecordingPayload): Promise<void> {
  if (await getRecState()) throw new Error('A recording is already in progress');

  await ensureOffscreenDocument();
  const response = (await browser.runtime.sendMessage({
    target: 'offscreen',
    type: 'REC_START',
    payload,
  })) as MessageResponse | undefined;
  if (!response?.ok) {
    throw new Error(response?.error ?? 'Offscreen document failed to start recording');
  }

  const recState: RecSessionState = {
    jobId: payload.jobId,
    name: payload.name,
    startedAt: Date.now(),
    mode: payload.mode,
    sources: payload.sources,
    tabId: payload.tabId,
  };
  await browser.storage.session.set({ [REC_STATE_KEY]: recState });
  await browser.action.setBadgeText({ text: 'REC' });
  await browser.action.setBadgeBackgroundColor({ color: '#d93025' });

  // On-page widget; not available on pages we cannot script (chrome:// etc.)
  await browser.scripting
    .executeScript({ target: { tabId: payload.tabId }, files: ['/widget.js'] })
    .catch((error: unknown) => {
      console.warn('[tab-recorder] widget injection failed:', error);
    });
  void browser.tabs
    .sendMessage(payload.tabId, {
      target: 'widget',
      type: 'STATE',
      recording: true,
      startedAt: recState.startedAt,
    })
    .catch(() => {});
}

/** The on-page ball was clicked: build the payload the popup would have sent. */
async function startFromWidget(sender: SenderInfo): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) throw new Error('Could not identify this tab');
  if (await getRecState()) throw new Error('Already recording — stop the current recording first');

  const stored = await browser.storage.local.get('recordingPrefs');
  const prefs = (stored.recordingPrefs as RecordingPrefs | undefined) ?? DEFAULT_PREFS;
  if (prefs.mode === 'audio' && !prefs.tab && !prefs.mic) {
    throw new Error('Enable tab audio or microphone in the extension popup first');
  }

  let streamId: string | null = null;
  if (prefs.mode === 'video' || prefs.tab) {
    streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
  }

  const jobId = crypto.randomUUID();
  const name = sender.tab?.title || `Recording ${new Date().toLocaleString()}`;
  await db.jobs.put(
    createRecordingJob({
      jobId,
      name,
      mode: prefs.mode,
      sources: { tab: prefs.tab, mic: prefs.mic },
    }),
  );

  try {
    await startRecording({
      jobId,
      streamId,
      name,
      mode: prefs.mode,
      sources: { tab: prefs.tab, mic: prefs.mic },
      tabId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await applyEvent(jobId, {
      type: 'RECORDING_FAILED',
      occurredAt: nowIso(),
      code: 'START_REJECTED',
      message,
    });
    if (prefs.mic && message.includes('NotAllowed')) {
      void browser.tabs.create({ url: browser.runtime.getURL('/permissions.html') });
      throw new Error('Microphone permission needed — grant it on the page that just opened');
    }
    throw error;
  }
}

async function handleStop(): Promise<void> {
  try {
    const response = (await browser.runtime.sendMessage({
      target: 'offscreen',
      type: 'REC_STOP',
    })) as MessageResponse | undefined;
    if (!response?.ok) throw new Error(response?.error ?? 'stop failed');
  } catch {
    // Offscreen document is gone (crashed/reloaded): salvage what's on disk.
    await clearRecordingState();
    await recoverInterruptedJobs(null);
  }
}

async function clearRecordingState(): Promise<void> {
  const state = await getRecState();
  if (state) {
    void browser.tabs
      .sendMessage(state.tabId, { target: 'widget', type: 'STATE', recording: false })
      .catch(() => {});
  }
  await browser.storage.session.remove(REC_STATE_KEY);
  await browser.action.setBadgeText({ text: '' });
}
