import type { Mode, Sources } from './state/types';

export interface RecordingPrefs {
  mode: Mode;
  tab: boolean;
  mic: boolean;
}

export const DEFAULT_PREFS: RecordingPrefs = { mode: 'video', tab: true, mic: true };

export interface StartRecordingPayload {
  jobId: string;
  /** null when no tab capture is needed (audio-only with mic as the sole source) */
  streamId: string | null;
  name: string;
  mode: Mode;
  sources: Sources;
  /** recorded tab; also receives the on-page recording indicator */
  tabId: number;
}

/** Lives in chrome.storage.session under this key while a recording is active. */
export const REC_STATE_KEY = 'recState';

export interface RecSessionState {
  jobId: string;
  name: string;
  startedAt: number;
  mode: Mode;
  sources: Sources;
  tabId: number;
}

export type BackgroundMessage =
  | { target: 'background'; type: 'START_RECORDING'; payload: StartRecordingPayload }
  | { target: 'background'; type: 'START_FROM_WIDGET' }
  | { target: 'background'; type: 'STOP_RECORDING' }
  | { target: 'background'; type: 'GET_REC_STATE' }
  | { target: 'background'; type: 'KICK_QUEUE' }
  | { target: 'background'; type: 'SIGN_IN' }
  | { target: 'background'; type: 'RECORDING_STOPPED'; payload: { jobId: string } }
  | { target: 'background'; type: 'RECORDING_ERROR'; payload: { jobId: string; message: string } };

export type OffscreenMessage =
  | { target: 'offscreen'; type: 'REC_START'; payload: StartRecordingPayload }
  | { target: 'offscreen'; type: 'REC_STOP' };

export type WidgetStateMessage = {
  target: 'widget';
  type: 'STATE';
  recording: boolean;
  startedAt?: number;
};

export type AnyMessage = BackgroundMessage | OffscreenMessage | WidgetStateMessage;

export interface MessageResponse {
  ok: boolean;
  error?: string;
  recState?: RecSessionState | null;
  /** true when the active recording belongs to the tab that asked */
  isRecordingThisTab?: boolean;
  /** set by SIGN_IN */
  email?: string;
}
