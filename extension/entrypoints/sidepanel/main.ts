import { toErrorInfo } from '../../src/errors';
import { formatBytes, formatElapsed, formatSessionId } from '../../src/format';
import { sendToBackground, sendToOffscreen, type CaptureStats, type ProbeSummary } from '../../src/messages';
import { listSessions, type StoredSession } from '../../src/opfs/session-store';
import type { VideoStatus } from '../../src/probe';
import { INITIAL_STATE, isActive, onStateChange, type SessionState, type WarningCode } from '../../src/state';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The same page is the action popup (`?mode=popup`) and the side panel. */
const isPopup = new URLSearchParams(location.search).get('mode') === 'popup';
if (isPopup) document.body.classList.add('popup');
const dot = $('dot');
const stateLabel = $('stateLabel');
const elapsed = $('elapsed');
const audioValue = $('audioValue');
const meterFill = $('meterFill');
const videoValue = $('videoValue');
const tabValue = $('tabValue');
const warningsList = $<HTMLUListElement>('warnings');
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

const WARNING_TEXT: Record<WarningCode, string> = {
  PLAYBACK_RATE: '再生速度が 1.0x ではありません。文字起こしの精度が落ちるので 1.0x を推奨します。',
  TAB_HIDDEN: 'タブが非表示です。表示に戻るまでスライド検知は止まります（録音は継続）。',
  NAVIGATED: '動画ページから移動しました。録音は続いていますが、スライド検知は止まっています。',
  NO_VIDEO: '動画が見つかりません。音声のみ録音します。',
  CROSS_ORIGIN_IFRAME: '別ドメインの iframe 内の動画は現在未対応です。',
  DRM: 'DRM 保護された動画のため、スライド画像は取得できません。',
  TAINTED: 'この動画からはスライド画像を取得できません（cross-origin）。音声のみ録音します。',
  SERVER_UNREACHABLE: 'ローカルサーバーに接続できません。',
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

  videoValue.textContent = active ? describeVideo(state) : '—';
  renderWarnings(active ? state.warnings : []);

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

function describeVideo(state: SessionState): string {
  const video = state.video;
  if (state.frameSource !== 'direct' || !video) return '動画なし（音声のみ）';
  return `${formatVideo(video)} · ${video.playbackRate}x · ${videoPhase(video)} · ${formatElapsed(video.currentTime * 1000)}`;
}

function formatVideo(video: Pick<VideoStatus, 'player' | 'videoWidth' | 'videoHeight'>): string {
  const size = video.videoWidth > 0 ? `${video.videoWidth}×${video.videoHeight}` : '読込中';
  return `${video.player} ${size}`;
}

function videoPhase(video: VideoStatus): string {
  if (video.ended) return '終了';
  if (video.paused) return '一時停止';
  return video.playing ? '再生中' : '待機中';
}

function renderWarnings(codes: WarningCode[]) {
  warningsList.replaceChildren(
    ...codes.map((code) => {
      const li = document.createElement('li');
      li.textContent = WARNING_TEXT[code];
      return li;
    }),
  );
  warningsList.hidden = codes.length === 0;
}

/** Start 前に現在のタブの動画を調べて表示する（ポップアップのみ。activeTab があるため） */
async function showProbe() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return;
    const { probe } = await sendToBackground.probe(tab.id);
    if (isActive(current)) return;
    videoValue.textContent = describeProbe(probe);
    if (!probe.chosen) {
      const codes: WarningCode[] = ['NO_VIDEO'];
      if (probe.crossOriginIframes.length > 0) codes.push('CROSS_ORIGIN_IFRAME');
      renderWarnings(codes);
    }
  } catch {
    // 内部ページなど、調べられないタブでは何も出さない
  }
}

function describeProbe(probe: ProbeSummary): string {
  if (!probe.chosen) return '動画が見つかりません';
  const c = probe.chosen;
  const parts = [formatVideo(c), c.playing ? '再生中' : c.paused ? '一時停止' : '待機中'];
  if (probe.videoCount > 1) parts.push(`他 ${probe.videoCount - 1} 件`);
  return parts.join(' · ');
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
    if (
      confirm(
        `${formatSessionId(session.sessionId)} の録音を拡張内のストレージから削除します。\n` +
          'エクスポート済みのファイル（~/Downloads/LecScribe）はそのまま残ります。よろしいですか？',
      )
    ) {
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
void sendToBackground.getState().then(({ state }) => {
  render(state);
  if (isPopup && !isActive(state)) void showProbe();
});
