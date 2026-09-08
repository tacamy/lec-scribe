import { toErrorInfo } from '../../src/errors';
import { formatElapsed } from '../../src/format';
import { sendToBackground, sendToOffscreen, type CaptureStats } from '../../src/messages';
import { INITIAL_STATE, onStateChange, type SessionState } from '../../src/state';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dot = $('dot');
const stateLabel = $('stateLabel');
const elapsed = $('elapsed');
const audioValue = $('audioValue');
const meterFill = $('meterFill');
const tabValue = $('tabValue');
const message = $('message');
const startBtn = $<HTMLButtonElement>('startBtn');
const stopBtn = $<HTMLButtonElement>('stopBtn');
const footer = $('footer');

const STATE_LABEL: Record<SessionState['state'], string> = {
  IDLE: 'Ready',
  STARTING: 'Starting…',
  CAPTURING: 'Capturing',
  STOPPING: 'Stopping…',
  UPLOADING: 'Uploading…',
  PROCESSING: 'Transcribing…',
  COMPLETED: 'Done',
  ERROR: 'Error',
};

let current: SessionState = INITIAL_STATE;
let statsTimer: number | undefined;

function render(state: SessionState) {
  current = state;
  dot.dataset.state = state.state;
  stateLabel.textContent = STATE_LABEL[state.state];
  tabValue.textContent = state.title ?? '—';
  tabValue.title = state.title ?? '';

  const active = state.state === 'STARTING' || state.state === 'CAPTURING' || state.state === 'STOPPING';
  startBtn.hidden = active;
  stopBtn.hidden = !active;
  startBtn.disabled = false;
  stopBtn.disabled = state.state === 'STOPPING';

  if (state.state === 'ERROR' && state.error) {
    showMessage(`${state.error.message} (${state.error.code})`);
  } else {
    message.hidden = true;
  }

  if (state.state === 'IDLE' && state.lastSession) {
    footer.textContent = `前回: ${formatElapsed(state.lastSession.durationMs)} キャプチャ（${state.lastSession.endedBy}）。Phase 1 では保存しません。`;
  } else if (state.state === 'CAPTURING') {
    footer.textContent = 'AirPods 等から音声が聞こえ、二重になっていないか確認してください。';
  } else {
    footer.textContent = '講義ページで動画を再生した状態で Start を押してください。';
  }

  if (state.state === 'CAPTURING') startStatsLoop();
  else stopStatsLoop();
}

function showMessage(text: string) {
  message.textContent = text;
  message.hidden = false;
}

function applyStats(stats: CaptureStats) {
  elapsed.textContent = formatElapsed(stats.elapsedMs);
  // RMS of speech sits around 0.02–0.2; stretch it so the meter is readable.
  const percent = Math.min(100, Math.round(Math.sqrt(stats.audioLevel) * 100));
  meterFill.style.width = `${percent}%`;
  audioValue.textContent = stats.capturing
    ? `録音中${stats.passthrough ? '' : '（パススルー off）'}${stats.audioLevel < 0.001 ? ' — 無音' : ''}`
    : '—';
}

function startStatsLoop() {
  if (statsTimer !== undefined) return;
  const tick = async () => {
    try {
      applyStats(await sendToOffscreen.getStats());
    } catch {
      // Offscreen document not reachable yet (or already closed).
    }
  };
  void tick();
  statsTimer = window.setInterval(() => void tick(), 500);
}

function stopStatsLoop() {
  if (statsTimer !== undefined) window.clearInterval(statsTimer);
  statsTimer = undefined;
  elapsed.textContent = '';
  meterFill.style.width = '0';
  audioValue.textContent = '—';
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  message.hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('No active tab.');
    render((await sendToBackground.start(tab.id)).state);
  } catch (e) {
    const info = toErrorInfo(e);
    showMessage(`${info.message} (${info.code})`);
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  try {
    render((await sendToBackground.stop()).state);
  } catch (e) {
    const info = toErrorInfo(e);
    showMessage(`${info.message} (${info.code})`);
  }
});

onStateChange(render);
void sendToBackground.getState().then(({ state }) => render(state));
