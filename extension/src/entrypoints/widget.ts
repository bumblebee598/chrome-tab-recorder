// Loom-style on-page widget, injected via chrome.scripting (activeTab grant).
//
// Idle: a small floating ball bottom-left — click it to start recording this
// tab without opening the popup (uses the prefs last set in the popup).
// Recording: red glow around the viewport + pill with pulsing dot, live timer,
// and stop button. Rendered in a closed shadow root so page CSS cannot touch it.

import { formatElapsed } from '@/lib/time';
import type { MessageResponse, WidgetStateMessage } from '@/lib/messages';

const HOST_ID = '__tab_recorder_widget__';

export default defineUnlistedScript(async () => {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      [hidden] { display: none !important; }
      .glow {
        position: fixed;
        inset: 0;
        pointer-events: none;
        box-shadow:
          inset 0 0 0 3px rgba(255, 59, 48, 0.7),
          inset 0 0 28px rgba(255, 59, 48, 0.28);
        animation: breathe 2.4s ease-in-out infinite;
      }
      .ball {
        position: fixed;
        left: 20px;
        bottom: 20px;
        width: 64px;
        height: 64px;
        border-radius: 50%;
        background: rgba(18, 18, 20, 0.88);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.1);
        display: grid;
        place-items: center;
        cursor: pointer;
        pointer-events: auto;
        transition: transform 0.15s ease;
      }
      .ball:hover { transform: scale(1.1); }
      .ball-dot {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: #ff3b30;
        box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.85);
      }
      .dismiss {
        position: absolute;
        top: -4px;
        right: -4px;
        width: 22px;
        height: 22px;
        border: none;
        border-radius: 50%;
        background: #3a3a3e;
        color: #fff;
        font: 700 13px/1 -apple-system, system-ui, sans-serif;
        cursor: pointer;
        display: none;
        place-items: center;
        padding: 0;
      }
      .ball:hover .dismiss { display: grid; }
      .pill {
        position: fixed;
        left: 20px;
        bottom: 20px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 16px 14px 18px;
        border-radius: 999px;
        background: rgba(18, 18, 20, 0.88);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.08);
        font: 600 16px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #fff;
        pointer-events: auto;
        user-select: none;
      }
      .dot {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #ff3b30;
        animation: blink 1.2s ease-in-out infinite;
      }
      .time {
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.4px;
        min-width: 56px;
      }
      .stop {
        width: 34px;
        height: 34px;
        border: none;
        border-radius: 50%;
        background: #fff;
        cursor: pointer;
        display: grid;
        place-items: center;
        transition: transform 0.12s ease;
      }
      .stop:hover { transform: scale(1.12); }
      .stop::before {
        content: '';
        width: 13px;
        height: 13px;
        border-radius: 3px;
        background: #e02020;
      }
      .toast {
        position: fixed;
        left: 20px;
        bottom: 96px;
        max-width: 300px;
        padding: 10px 14px;
        border-radius: 10px;
        background: rgba(18, 18, 20, 0.92);
        color: #fff;
        font: 500 13px/1.4 -apple-system, system-ui, sans-serif;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
        pointer-events: none;
      }
      @keyframes blink { 50% { opacity: 0.25; } }
      @keyframes breathe {
        50% {
          box-shadow:
            inset 0 0 0 3px rgba(255, 59, 48, 0.3),
            inset 0 0 14px rgba(255, 59, 48, 0.12);
        }
      }
    </style>
    <div class="glow" hidden></div>
    <div class="ball" title="Record this tab">
      <span class="ball-dot"></span>
      <button class="dismiss" title="Hide widget">&times;</button>
    </div>
    <div class="pill" hidden title="Tab Recorder is recording this tab">
      <span class="dot"></span>
      <span class="time">00:00</span>
      <button class="stop" title="Stop recording"></button>
    </div>
    <div class="toast" hidden></div>
  `;

  document.documentElement.appendChild(host);

  const glow = shadow.querySelector<HTMLElement>('.glow')!;
  const ball = shadow.querySelector<HTMLElement>('.ball')!;
  const pill = shadow.querySelector<HTMLElement>('.pill')!;
  const timeEl = shadow.querySelector<HTMLElement>('.time')!;
  const toast = shadow.querySelector<HTMLElement>('.toast')!;

  let interval: ReturnType<typeof setInterval> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function setRecording(startedAt: number): void {
    ball.hidden = true;
    pill.hidden = false;
    glow.hidden = false;
    if (interval) clearInterval(interval);
    const tick = () => {
      timeEl.textContent = formatElapsed(Date.now() - startedAt);
    };
    tick();
    interval = setInterval(tick, 500);
  }

  function setIdle(): void {
    if (interval) clearInterval(interval);
    interval = null;
    pill.hidden = true;
    glow.hidden = true;
    ball.hidden = false;
  }

  function showToast(message: string): void {
    toast.textContent = message;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 3500);
  }

  ball.addEventListener('click', async () => {
    const response = (await browser.runtime
      .sendMessage({ target: 'background', type: 'START_FROM_WIDGET' })
      .catch((error: unknown) => ({ ok: false, error: String(error) }))) as
      | MessageResponse
      | undefined;
    if (!response?.ok) {
      showToast(response?.error ?? 'Could not start — open the extension popup to record.');
    }
  });

  shadow.querySelector<HTMLButtonElement>('.dismiss')!.addEventListener('click', (event) => {
    event.stopPropagation();
    host.remove();
  });

  shadow.querySelector<HTMLButtonElement>('.stop')!.addEventListener('click', () => {
    void browser.runtime.sendMessage({ target: 'background', type: 'STOP_RECORDING' });
  });

  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as WidgetStateMessage;
    if (msg?.target !== 'widget' || msg.type !== 'STATE') return;
    if (msg.recording) {
      setRecording(msg.startedAt ?? Date.now());
    } else {
      setIdle();
    }
  });

  const response = (await browser.runtime
    .sendMessage({ target: 'background', type: 'GET_REC_STATE' })
    .catch(() => null)) as MessageResponse | null;
  if (response?.isRecordingThisTab && response.recState) {
    setRecording(response.recState.startedAt);
  } else {
    setIdle();
  }
});
