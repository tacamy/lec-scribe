import { loadConfig } from '../../src/config';
import { toErrorInfo } from '../../src/errors';
import { formatBytes, formatElapsed, formatSessionId } from '../../src/format';
import { sendToBackground, sendToOffscreen, type CaptureStats, type ProbeSummary } from '../../src/messages';
import { listSessions, type StoredSession } from '../../src/opfs/session-store';
import type { VideoStatus } from '../../src/probe';
import {
  INITIAL_STATE,
  isActive,
  onStateChange,
  type ProcessingProgress,
  type SessionState,
  type WarningCode,
} from '../../src/state';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The same page is the action popup (`?mode=popup`) and the side panel. */
const isPopup = new URLSearchParams(location.search).get('mode') === 'popup';
if (isPopup) document.body.classList.add('popup');
const dot = $('dot');
const stateLabel = $('stateLabel');
const elapsed = $('elapsed');
const audioValue = $('audioValue');
// 録音していないときは中身のない行（Audio / Video / Slides / Tab）を出さない。Server 行だけ常に出す
const detailRows = [$('audioRow'), $('meter'), $('videoRow'), $('slidesRow'), $('tabRow')];
const meterFill = $('meterFill');
const videoValue = $('videoValue');
const slidesValue = $('slidesValue');
const tabValue = $('tabValue');
const serverValue = $('serverValue');
const warningsList = $<HTMLUListElement>('warnings');
const message = $('message');
const startBtn = $<HTMLButtonElement>('startBtn');
const stopBtn = $<HTMLButtonElement>('stopBtn');
const snapBtn = $<HTMLButtonElement>('snapBtn');
const openBtn = $<HTMLButtonElement>('openBtn');
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

const STAGE_TEXT: Record<ProcessingProgress['stage'], string> = {
  uploading: '送信中',
  queued: '待機中',
  converting: '音声を変換中',
  transcribing: '文字起こし中',
  merging: '統合中',
  polishing: 'ノート作成中',
  done: '完了',
  error: 'エラー',
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
/** サーバーのトークンが設定されているか（送信ボタンの表示に使う） */
let serverConfigured = false;
let serverTarget = { port: 47321, token: '' };

async function refreshConfig() {
  const config = await loadConfig();
  serverTarget = config.server;
  serverConfigured = config.server.token.length > 0;
}

/** サーバーに頼んで出力フォルダ（または lecture.md）を Finder / 既定のアプリで開く */
async function openOutput(sessionId: string, target: 'folder' | 'lecture', fallbackPath?: string) {
  try {
    const res = await fetch(`http://127.0.0.1:${serverTarget.port}/sessions/${sessionId}/open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serverTarget.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
      throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    }
  } catch (e) {
    const reason = e instanceof TypeError ? 'サーバーが起動していないため開けません' : (e as Error).message;
    showMessage(`${reason}${fallbackPath ? `\n${shortPath(fallbackPath)}` : ''}`);
  }
}

function render(state: SessionState) {
  current = state;
  const active = isActive(state);
  dot.dataset.state = state.state;
  stateLabel.textContent = state.exporting ? 'Exporting…' : STATE_LABEL[state.state];
  tabValue.textContent = state.title ?? '—';
  tabValue.title = state.title ?? '';

  // 録音中だけ状態の行を出す。録音完了直後は Audio 行に長さとサイズを残す
  const showAudio = active || (state.state === 'COMPLETED' && !!state.lastSession);
  for (const row of detailRows) row.hidden = !(row.id === 'audioRow' ? showAudio : active);

  startBtn.hidden = active;
  stopBtn.hidden = !active;
  startBtn.disabled = !!state.exporting;
  stopBtn.disabled = state.state === 'STOPPING';
  snapBtn.hidden = !(state.state === 'CAPTURING' && state.frameSource === 'direct');
  openBtn.hidden = !(state.state === 'COMPLETED' && !state.processing && state.lastSession?.outputDir);

  if (state.error) {
    showMessage(`${state.error.message} (${state.error.code})`);
  } else {
    message.hidden = true;
  }

  if (!active) {
    const last = state.lastSession;
    audioValue.textContent =
      state.state === 'COMPLETED' && last
        ? `録音完了 ${formatElapsed(last.durationMs)} / ${formatBytes(last.audioBytes)}${last.exported ? '（Downloads に書き出し済み）' : ''}`
        : '—';
  }

  videoValue.textContent = active ? describeVideo(state) : '—';
  serverValue.textContent = describeServer(state);
  renderWarnings(active ? state.warnings : state.warnings.filter((w) => w === 'SERVER_UNREACHABLE'));

  if (state.state === 'CAPTURING') {
    footer.textContent = state.processing
      ? '録音中です。前のセッションの文字起こしは裏で続いています。'
      : '録音中です。スライドの切り替えは自動で保存されます。';
  } else if (state.processing) {
    footer.textContent = 'サーバーで処理中です。このパネルを閉じても処理は続きます。';
  } else if (state.state === 'COMPLETED' && state.lastSession?.outputDir) {
    footer.textContent = `文字起こしが終わりました: ${shortPath(state.lastSession.outputDir)}`;
  } else if (state.state === 'COMPLETED') {
    footer.textContent = serverConfigured
      ? '「文字起こしする」でサーバーへ送ると、音声・スライドと文字起こしが ~/LecScribe/ に保存されます。'
      : '「Downloads に書き出す」で ~/Downloads/LecScribe/<セッション>/ に保存されます。文字起こしするには設定でサーバーのトークンを登録してください。';
  } else if (state.exporting) {
    footer.textContent = 'ダウンロード中です…';
  } else if (isPopup) {
    footer.textContent = '講義ページで動画を再生した状態で Start を押してください。開始後はサイドパネルで状態を確認できます。';
  } else {
    footer.textContent = '録音を始めるにはツールバーの LecScribe アイコンから Start を押してください。';
  }

  if (state.state === 'CAPTURING') startStatsLoop();
  else stopStatsLoop();

  // 一覧は録音中も出す（録音中のセッション自身は除く）。動画の状態更新のたびに
  // 作り直すとボタンがちらつくので、一覧に関係する状態が変わったときだけ描き直す
  const key = [state.state, state.sessionId, state.processing?.stage, state.exporting ? 'x' : '', state.pendingUploads?.join(','), serverConfigured].join('|');
  if (key !== sessionsKey) {
    sessionsKey = key;
    void renderSessions();
  }
}

let sessionsKey = '';

function describeServer(state: SessionState): string {
  const p = state.processing;
  const pending = state.pendingUploads?.length ? ` · 送信待ち ${state.pendingUploads.length} 件` : '';
  if (p) {
    const elapsed = formatElapsed(Date.now() - p.startedAt);
    return `${STAGE_TEXT[p.stage]}${p.percent !== undefined ? ` ${p.percent}%` : ''} · ${elapsed}${pending}`;
  }
  if (pending) return `待機中${pending}`;
  if (state.state === 'COMPLETED' && state.lastSession?.outputDir) return `完了 · ${shortPath(state.lastSession.outputDir)}`;
  return serverConfigured ? '待機中' : '未設定';
}

/** /Users/<name>/… を ~/… にして短く見せる */
function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+\//, '~/');
}

function describeVideo(state: SessionState): string {
  const video = state.video;
  if (state.frameSource !== 'direct' || !video) return '動画なし（音声のみ）';
  const parts = [formatVideo(video), `${video.playbackRate}x`, videoPhase(video), formatElapsed(video.currentTime * 1000)];
  if (video.detect) parts.push(`変化 ${(video.detect.diffPrev * 100).toFixed(1)}%`);
  return parts.join(' · ');
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

function showMessage(text: string, kind: 'error' | 'info' = 'error') {
  message.textContent = text;
  message.className = kind === 'info' ? 'message info' : 'message';
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
  slidesValue.textContent = stats.capturing
    ? `${stats.slideCount} 枚${stats.lastSlideVideoTime !== null ? `（最終 ${formatElapsed(stats.lastSlideVideoTime * 1000)}）` : ''}`
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
  slidesValue.textContent = '—';
}

async function renderSessions() {
  let sessions: StoredSession[] = [];
  try {
    const activeId = isActive(current) ? current.sessionId : undefined;
    sessions = (await listSessions()).filter((s) => s.sessionId !== activeId).slice(0, 5);
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
  const parts = [formatBytes(session.audioBytes), `${session.slideCount} 枚`];
  if (session.status?.durationMs !== undefined) parts.unshift(formatElapsed(session.status.durationMs));
  meta.textContent = parts.join(' · ');
  main.append(id, meta);

  const btns = document.createElement('div');
  btns.className = 'sessionBtns';
  const done = session.status?.stage === 'done';
  const openFolderBtn = document.createElement('button');
  openFolderBtn.type = 'button';
  openFolderBtn.className = 'primary';
  openFolderBtn.textContent = 'フォルダを開く';
  openFolderBtn.title = session.status?.outputDir ?? '';
  openFolderBtn.addEventListener('click', () => void openOutput(session.sessionId, 'folder', session.status?.outputDir));
  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = done ? '' : 'primary';
  uploadBtn.textContent = done ? 'やり直す' : '文字起こしする';
  uploadBtn.title = done ? '同じフォルダに文字起こしをやり直す' : 'ローカルサーバーへ送って文字起こしする（~/LecScribe に出力）';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = serverConfigured ? '' : 'primary';
  exportBtn.textContent = 'Downloads に書き出す';
  exportBtn.title = 'サーバーを使わずに録音とスライドの生データを ~/Downloads/LecScribe に保存する';
  const discardBtn = document.createElement('button');
  discardBtn.type = 'button';
  discardBtn.textContent = '破棄';
  const busy = !!current.exporting || !!current.processing;
  const inFlight = current.processing?.sessionId === session.sessionId || (current.pendingUploads?.includes(session.sessionId) ?? false);
  // 処理中でも「文字起こしする / やり直す」は押せる（送信待ちに並ぶ）。処理中・送信待ちの本人だけ押せない
  uploadBtn.disabled = !!current.exporting || inFlight;
  exportBtn.disabled = busy;
  // 破棄は処理中でも押せる（処理を中止して消す）。エクスポート中だけ待つ
  discardBtn.disabled = !!current.exporting;
  uploadBtn.addEventListener('click', () => void act(() => sendToBackground.upload(session.sessionId)));
  exportBtn.addEventListener('click', () => void act(() => sendToBackground.export(session.sessionId)));
  discardBtn.addEventListener('click', () => {
    const text = inFlight
      ? `${formatSessionId(session.sessionId)} の文字起こしを中止して、録音とサーバー側のフォルダを削除します。よろしいですか？`
      : `${formatSessionId(session.sessionId)} の録音を拡張内のストレージから削除します。\n` +
        '文字起こしの出力（~/LecScribe）や Downloads に書き出したファイルはそのまま残ります。よろしいですか？';
    if (confirm(text)) void act(() => sendToBackground.discard(session.sessionId));
  });
  // サーバーを使う運用では生データもサーバー側に置かれるので、Downloads への書き出しは
  // サーバー未設定のときだけの回収手段として出す（SPEC D-07）
  if (serverConfigured && done) btns.append(openFolderBtn, uploadBtn);
  else if (serverConfigured) btns.append(uploadBtn);
  else btns.append(exportBtn);
  btns.append(discardBtn);
  if (inFlight) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = current.processing?.sessionId === session.sessionId ? '処理中' : '送信待ち';
    btns.append(tag);
  } else if (session.status?.stage === 'capturing') {
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
    sessionsKey = ''; // 操作後は一覧を必ず描き直す
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
    if (!isPopup) return sendToBackground.start(tab.id);
    // ポップアップはサイドパネルが開いた瞬間にフォーカスを失って閉じる。
    // 先に録音開始を投げておけば、ポップアップが消えても service worker 側で処理が続く。
    const started = sendToBackground.start(tab.id);
    started.catch(() => undefined);
    // このタブにだけパネルを出す（全体のパネルは service worker が無効にしている）。
    // クリック直後のユーザー操作が有効なうちに open を呼びたいので setOptions は待たずに続ける
    void chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true }).catch(() => undefined);
    await chrome.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
    const result = await started;
    window.close();
    return result;
  });
});

stopBtn.addEventListener('click', () => {
  stopBtn.disabled = true;
  void act(() => sendToBackground.stop());
});

openBtn.addEventListener('click', () => {
  const last = current.lastSession;
  if (last?.outputDir) void openOutput(last.sessionId, 'folder', last.outputDir);
});

// 手動保存の結果はボタン自体の表示で返す（メッセージ欄だとレイアウトが動いて読みにくい）
const SNAP_LABEL = snapBtn.textContent;
let snapRestoreTimer: number | undefined;

snapBtn.addEventListener('click', async () => {
  snapBtn.disabled = true;
  window.clearTimeout(snapRestoreTimer);
  try {
    const { slide } = await sendToBackground.captureFrame();
    snapBtn.textContent = `✓ ${slide.filename} を保存しました`;
    snapBtn.classList.add('done');
  } catch (e) {
    const info = toErrorInfo(e);
    snapBtn.textContent = `保存できませんでした: ${info.message}`;
    snapBtn.classList.add('failed');
  } finally {
    snapBtn.disabled = false;
    snapRestoreTimer = window.setTimeout(() => {
      snapBtn.textContent = SNAP_LABEL;
      snapBtn.classList.remove('done', 'failed');
    }, 2500);
  }
});

$('optionsBtn').addEventListener('click', () => void chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['config']) void refreshConfig().then(() => render(current));
});

onStateChange(render);
void refreshConfig().then(() => sendToBackground.getState()).then(({ state }) => {
  render(state);
  if (isPopup && !isActive(state)) void showProbe();
});
