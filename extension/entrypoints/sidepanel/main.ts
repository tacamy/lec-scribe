import { toErrorInfo } from '../../src/errors';
import { formatBytes, formatElapsed, formatSessionId } from '../../src/format';
import { sendToBackground, sendToOffscreen, type CaptureStats } from '../../src/messages';
import { listSessions, type StoredSession } from '../../src/opfs/session-store';
import { INITIAL_STATE, isActive, onStateChange, type SessionState } from '../../src/state';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The same page is the action popup (`?mode=popup`) and the side panel. */
const isPopup = new URLSearchParams(location.search).get('mode') === 'popup';
if (isPopup) document.body.classList.add('popup');
const dot = $('dot');
const stateLabel = $('stateLabel');
const elapsed = $('elapsed');
const audioValue = $('audioValue');
const meterFill = $('meterFill');
const tabValue = $('tabValue');
const message = $('message');
const startBtn = $<HTMLButtonElement>('startBtn');
const stopBtn = $<HTMLButtonElement>('stopBtn');
const sessionsSection = $('sessions');
const sessionList = $<HTMLUListElement>('sessionList');
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
  const active = isActive(state);
  dot.dataset.state = state.state;
  stateLabel.textContent = state.exporting ? 'Exporting…' : STATE_LABEL[state.state];
  tabValue.textContent = state.title ?? '—';
  tabValue.title = state.title ?? '';

  startBtn.hidden = active;
  stopBtn.hidden = !active;
  startBtn.disabled = !!state.exporting;
  stopBtn.disabled = state.state === 'STOPPING';

  if (state.error) {
    showMessage(`${state.error.message} (${state.error.code})`);
  } else {
    message.hidden = true;
  }

  if (!active) {
    const last = state.lastSession;
    audioValue.textContent =
      state.state === 'COMPLETED' && last
        ? `録音完了 ${formatElapsed(last.durationMs)} / ${formatBytes(last.audioBytes)}${last.exported ? '（エクスポート済み）' : ''}`
        : '—';
  }

  if (state.state === 'CAPTURING') {
    footer.textContent = '音声を録音中です。スピーカーや AirPods から聞こえ、二重になっていないか確認してください。';
  } else if (state.state === 'COMPLETED') {
    footer.textContent = 'エクスポートすると ~/Downloads/LecScribe/<セッション>/ に audio.webm が保存されます。';
  } else if (state.exporting) {
    footer.textContent = 'ダウンロード中です…';
  } else if (isPopup) {
    footer.textContent = '講義ページで動画を再生した状態で Start を押してください。開始後はサイドパネルで状態を確認できます。';
  } else {
    footer.textContent = '録音を始めるにはツールバーの LecScribe アイコンから Start を押してください。';
  }

  if (state.state === 'CAPTURING') startStatsLoop();
  else stopStatsLoop();

  if (active) sessionsSection.hidden = true;
  else void renderSessions();
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
    ? `録音中 ${formatBytes(stats.audioBytes)}${stats.passthrough ? '' : '（パススルー off）'}${stats.silent ? ' — 無音' : ''}`
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
}

async function renderSessions() {
  let sessions: StoredSession[] = [];
  try {
    sessions = (await listSessions()).slice(0, 5);
  } catch {
    // OPFS unavailable; nothing to list.
  }
  sessionsSection.hidden = sessions.length === 0;
  sessionList.replaceChildren(...sessions.map(sessionItem));
}

function sessionItem(session: StoredSession): HTMLLIElement {
  const li = document.createElement('li');
  const main = document.createElement('div');
  main.className = 'sessionMain';
  const id = document.createElement('span');
  id.textContent = formatSessionId(session.sessionId);
  id.title = session.meta?.title ?? session.sessionId;
  const meta = document.createElement('span');
  meta.className = 'sessionMeta';
  const parts = [formatBytes(session.audioBytes)];
  if (session.status?.durationMs !== undefined) parts.unshift(formatElapsed(session.status.durationMs));
  meta.textContent = parts.join(' · ');
  main.append(id, meta);

  const btns = document.createElement('div');
  btns.className = 'sessionBtns';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'primary';
  exportBtn.textContent = 'エクスポート';
  const discardBtn = document.createElement('button');
  discardBtn.type = 'button';
  discardBtn.textContent = '破棄';
  const busy = !!current.exporting;
  exportBtn.disabled = busy;
  discardBtn.disabled = busy;
  exportBtn.addEventListener('click', () => void act(() => sendToBackground.export(session.sessionId)));
  discardBtn.addEventListener('click', () => {
    if (confirm(`${formatSessionId(session.sessionId)} の録音を削除します。よろしいですか？`)) {
      void act(() => sendToBackground.discard(session.sessionId));
    }
  });
  btns.append(exportBtn, discardBtn);
  if (session.status?.stage === 'capturing') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '中断';
    btns.append(tag);
  } else if (session.status?.stage === 'error') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'エラー';
    tag.title = session.status.error ?? '';
    btns.append(tag);
  }
  li.append(main, btns);
  return li;
}

async function act(run: () => Promise<{ state: SessionState }>) {
  message.hidden = true;
  try {
    render((await run()).state);
  } catch (e) {
    const info = toErrorInfo(e);
    showMessage(`${info.message} (${info.code})`);
    render(current);
  }
}

startBtn.addEventListener('click', () => {
  startBtn.disabled = true;
  void act(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error('アクティブなタブがありません。');
    if (isPopup) {
      // Must run while the click's user activation is still fresh, so before
      // the round-trip to the worker. The panel then follows the shared state.
      await chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
    }
    const result = await sendToBackground.start(tab.id);
    if (isPopup) window.close();
    return result;
  });
});

stopBtn.addEventListener('click', () => {
  stopBtn.disabled = true;
  void act(() => sendToBackground.stop());
});

onStateChange(render);
void sendToBackground.getState().then(({ state }) => render(state));
