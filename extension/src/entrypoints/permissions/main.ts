// One-time mic grant for the extension origin. The mic prompt cannot appear
// inside the offscreen document, so the grant happens on this visible page and
// the offscreen document reuses it.

const statusEl = document.getElementById('status')!;
const button = document.getElementById('grant') as HTMLButtonElement;

button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    statusEl.textContent = 'Microphone access granted. You can close this tab and start recording.';
    statusEl.className = 'ok';
  } catch (error) {
    statusEl.textContent =
      error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Permission denied. Click the camera/mic icon in the address bar (or Site settings) to allow the microphone, then try again.'
        : `Could not access the microphone: ${error instanceof Error ? error.message : String(error)}`;
    statusEl.className = 'err';
    button.disabled = false;
  }
});
