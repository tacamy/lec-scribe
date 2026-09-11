import { bindCopyButton } from '../../src/clipboard';
import { authHeaders, loadConfig, serverEnabled } from '../../src/config';
import { fetchHealth, outdatedMessage, serverOutdated } from '../../src/health';
import { toErrorInfo } from '../../src/errors';
import { formatBytes, formatElapsed, formatSessionId } from '../../src/format';
import { sendToBackground, sendToOffscreen, type CaptureStats, type ProbeSummary } from '../../src/messages';
import { listSessions, setSessionHidden, type StoredSession } from '../../src/opfs/session-store';
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
const dots = $('dots');
const audioValue = $('audioValue');
// 録音していないときは中身のない行（Audio / Video / Slides / Tab）を出さない。Server 行だけ常に出す
const videoRow = $('videoRow');
const detailRows = [$('audioRow'), $('meter'), videoRow, $('slidesRow'), $('tabRow')];
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
const pairBtn = $<HTMLButtonElement>('pairBtn');
const setupSection = $('setup');
const setupStatus = $('setupStatus');
const installHint = $('installHint');
const installCmd = $('installCmd');
const copyCmdBtn = $<HTMLButtonElement>('copyCmdBtn');
/** Mac 側サーバーを入れる 1 行（README の「利用者向け」と同じ） */
const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/tacamy/lec-scribe/main/install.sh | bash';
installCmd.textContent = INSTALL_COMMAND;
const sessionsSection = $('sessions');
const sessionList = $<HTMLUListElement>('sessionList');
const hiddenToggle = $<HTMLButtonElement>('hiddenToggle');
const footer = $('footer');
// 未接続のときに隠す通常 UI
const mainSections = [$('status'), $('rows'), $('actions'), footer, sessionsSection];

/**
 * 一覧の行のタイトルは幅の都合で省略されることがあるので、省略されているときだけ、タイトルに乗せる（かボタンに Tab で入る）と全文を出す。
 * 1 つの要素を使い回して行の上に重ねる（ポップアップでは一覧の中がスクロールするので、行の中に置くと切れる）
 */
const sessionTip = document.createElement('div');
sessionTip.className = 'sessionTip';
sessionTip.setAttribute('role', 'tooltip');
sessionTip.hidden = true;
document.body.append(sessionTip);
let tipShowTimer = 0;
let tipHideTimer = 0;

/** タイトル（anchor）のすぐ上にタイトル全文を出す。幅は行（row）まで。文字は選んでコピーできる */
function showSessionTip(anchor: HTMLElement, row: HTMLElement, title: string) {
  window.clearTimeout(tipHideTimer);
  sessionTip.textContent = title;
  sessionTip.hidden = false;
  // 行の左端にそろえ、行の幅を最大幅にする。タイトルの上に出す（三角の分を含めて 6px。下に出すと同じ行のボタンを覆って押せなくなる）。上に収まらなければ下に
  const a = anchor.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  sessionTip.style.left = `${r.left}px`;
  sessionTip.style.maxWidth = `${r.width}px`;
  const height = sessionTip.offsetHeight;
  const above = a.top - height - 6;
  const fitsAbove = above >= 8;
  sessionTip.classList.toggle('below', !fitsAbove);
  sessionTip.style.top = `${fitsAbove ? above : Math.min(a.bottom + 6, window.innerHeight - height - 8)}px`;
}

/** 少し待ってから消す（ツールチップの上に移動してコピーを押せるように）。soon=false ですぐ消す */
function hideSessionTip(soon = true) {
  window.clearTimeout(tipShowTimer);
  window.clearTimeout(tipHideTimer);
  if (!soon) {
    sessionTip.hidden = true;
    return;
  }
  tipHideTimer = window.setTimeout(() => (sessionTip.hidden = true), 250);
}
sessionTip.addEventListener('mouseenter', () => window.clearTimeout(tipHideTimer));
sessionTip.addEventListener('mouseleave', () => hideSessionTip());
sessionList.addEventListener('scroll', () => hideSessionTip(false));
// サイドパネルでは一覧ではなくパネル全体が動くので、そちらのスクロールでも閉じる（位置がずれたまま残らないように）
window.addEventListener('scroll', () => hideSessionTip(false), true);
window.addEventListener('resize', () => hideSessionTip(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSessionTip(false);
});

// 末尾の「…」は CSS のアニメーション（.dots）で 1 文字ずつ増やす
const STATE_LABEL: Record<SessionState['state'], string> = {
  IDLE: 'Ready',
  STARTING: 'Starting',
  CAPTURING: 'Capturing',
  STOPPING: 'Stopping',
  UPLOADING: 'Uploading',
  PROCESSING: 'Transcribing',
  COMPLETED: 'Done',
  ERROR: 'Error',
};
const BUSY_STATES: ReadonlySet<SessionState['state']> = new Set(['STARTING', 'STOPPING', 'UPLOADING', 'PROCESSING']);

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
  NO_VIDEO: 'このページには動画が見つかりません。音声のみ録音します。',
  CROSS_ORIGIN_IFRAME: '別ドメインの iframe 内の動画は現在未対応です。',
  DRM: 'DRM 保護された動画のため、スライド画像は取得できません。',
  TAINTED: 'この動画からはスライド画像を取得できません（cross-origin）。音声のみ録音します。',
  SERVER_UNREACHABLE: 'ローカルサーバーに接続できません。',
};

let current: SessionState = INITIAL_STATE;
let statsTimer: number | undefined;
/** サーバーに送れる状態か（承認済みかトークンあり。送信ボタンの表示に使う） */
let serverConfigured = false;
let serverTarget = { port: 47321, token: '', paired: false };

async function refreshConfig() {
  const config = await loadConfig();
  serverTarget = config.server;
  serverConfigured = serverEnabled(config);
}


/** 未接続画面で、Mac 側にサーバーがいるかを先に見せる（いなければ接続ボタンを押しても意味がないため） */
let presenceChecked = false;
async function checkServerPresence() {
  if (presenceChecked) return;
  presenceChecked = true;
  try {
    const body = await fetchHealth(serverTarget, { auth: false, timeoutMs: 2000 });
    const missing = [!body.whisperkit && 'whisperkit-cli', !body.ffmpeg && 'ffmpeg'].filter(Boolean);
    setupStatus.textContent =
      missing.length > 0
        ? `Mac 側の LecScribe サーバーは動いていますが、${missing.join(' と ')} が見つかりません。ターミナルで brew install whisperkit-cli ffmpeg を実行してください。`
        : `Mac 側の LecScribe サーバーが見つかりました（v${body.version ?? '?'}）。`;
    installHint.hidden = true;
    pairBtn.hidden = false;
    pairBtn.disabled = false;
  } catch {
    setupStatus.textContent = 'Mac 側の LecScribe サーバーが見つかりません。';
    installHint.hidden = false;
    pairBtn.hidden = true;
  }
}

bindCopyButton(copyCmdBtn, INSTALL_COMMAND);

/** サーバーに頼んで出力フォルダ（または lecture.md）を Finder / 既定のアプリで開く */
async function openOutput(sessionId: string, target: 'folder' | 'lecture', fallbackPath?: string) {
  try {
    const res = await fetch(`http://127.0.0.1:${serverTarget.port}/sessions/${sessionId}/open`, {
      method: 'POST',
      headers: { ...authHeaders(serverTarget), 'content-type': 'application/json' },
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
  stateLabel.textContent = state.exporting ? 'Exporting' : STATE_LABEL[state.state];
  dots.hidden = !(state.exporting || BUSY_STATES.has(state.state));
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
  // サーバーと未接続で何も動いていなければ、「このMacと接続」だけを出す（接続しないと文字起こしできない）
  const setupMode = !serverConfigured && !active && !state.processing && !state.exporting;
  setupSection.hidden = !setupMode;
  for (const el of mainSections) el.hidden = setupMode;
  if (setupMode) {
    message.hidden = true;
    warningsList.hidden = true;
    void checkServerPresence();
  }

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
  syncProcessingClock(state);
  renderWarnings(active ? state.warnings : state.warnings.filter((w) => w === 'SERVER_UNREACHABLE'));

  if (state.state === 'CAPTURING') {
    footer.textContent = state.processing
      ? '録音中です。前のセッションの文字起こしは裏で続いています。'
      : '録音中です。スライドの切り替えは自動で保存されます。';
  } else if (state.processing) {
    footer.textContent = 'サーバーで処理中です。このパネルを閉じても処理は続きます。';
  } else if (state.state === 'COMPLETED' && state.lastSession?.outputDir) {
    // 状態表示の「Done」と同じことなので何も出さない（出力先は一覧の「フォルダを開く」で開ける）
    footer.textContent = '';
  } else if (state.state === 'COMPLETED') {
    footer.textContent = '「文字起こしする」でサーバーへ送ると、音声・スライドと文字起こしが ~/LecScribe/ に保存されます。';
  } else if (state.exporting) {
    footer.textContent = 'ダウンロード中です…';
  } else if (isPopup) {
    footer.textContent = '動画ページで動画を再生した状態で Start を押してください。開始後はサイドパネルで状態を確認できます。';
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

// 処理中の経過時間は状態が変わらなくても進めたいので、1 秒ごとに Server 行だけ描き直す
let processingTimer: number | undefined;
function syncProcessingClock(state: SessionState) {
  if (state.processing) {
    if (processingTimer === undefined) {
      processingTimer = window.setInterval(() => {
        serverValue.textContent = describeServer(current);
      }, 1000);
    }
  } else if (processingTimer !== undefined) {
    window.clearInterval(processingTimer);
    processingTimer = undefined;
  }
}

function describeServer(state: SessionState): string {
  const p = state.processing;
  const pending = state.pendingUploads?.length ? ` · 送信待ち ${state.pendingUploads.length} 件` : '';
  if (p) {
    const elapsed = formatElapsed(Date.now() - p.startedAt);
    return `${STAGE_TEXT[p.stage]}${p.percent !== undefined ? ` ${p.percent}%` : ''} · ${elapsed}${pending}`;
  }
  if (pending) return `待機中${pending}`;
  if (state.state === 'COMPLETED' && state.lastSession?.outputDir) return `完了 · ${shortPath(state.lastSession.outputDir)}`;
  return serverConfigured ? '待機中' : '未接続';
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

/** サーバーが古いときの文（§12.1c）。状態機械の警告とは別に、このパネルが /health を見て決める */
let serverOutdatedText: string | null = null;

function renderWarnings(codes: WarningCode[]) {
  const texts = [...codes.map((code) => WARNING_TEXT[code]), ...(serverOutdatedText ? [serverOutdatedText] : [])];
  warningsList.replaceChildren(
    ...texts.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
  warningsList.hidden = texts.length === 0;
}

/** 接続済みなら、開いたときに 1 回だけサーバーの版を見る。繋がらなければ何も出さない（別の警告が担う） */
async function checkServerVersion() {
  if (!serverConfigured) return;
  try {
    const body = await fetchHealth(serverTarget, { timeoutMs: 3000 });
    const next = serverOutdated(body) ? outdatedMessage(body) : null;
    if (next !== serverOutdatedText) {
      serverOutdatedText = next;
      render(current);
    }
  } catch {
    // 繋がらない・応答が読めない: 版は分からないので何も言わない
  }
}

/** Start 前に現在のタブの動画を調べて表示する（ポップアップのみ。activeTab があるため） */
async function showProbe() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return;
    const { probe } = await sendToBackground.probe(tab.id);
    if (isActive(current)) return;
    // Start 前の確認用に、動画が見つかったときだけ Video 行を出す（見つからなければ警告で伝える）
    videoValue.textContent = describeProbe(probe);
    videoRow.hidden = !probe.chosen;
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

/** 「非表示」にした行も一覧に出すか（パネルを開いている間だけ覚える） */
let showHidden = false;
/**
 * 削除・中止の確認ダイアログ（HTML の <dialog>）。
 * ブラウザの confirm() はポップアップ・サイドパネルでは表示されずに閉じられることがあるので使わない
 */
const confirmDialog = $<HTMLDialogElement>('confirmDialog');
const confirmText = $('confirmText');
const confirmOk = $<HTMLButtonElement>('confirmOk');
$<HTMLButtonElement>('confirmCancel').addEventListener('click', () => confirmDialog.close(''));

/** 確認を出して、OK なら true。Esc やキャンセルで false */
function askConfirm(text: string, okLabel: string): Promise<boolean> {
  confirmText.textContent = text;
  confirmOk.textContent = okLabel;
  return new Promise((resolve) => {
    const onClose = () => {
      confirmDialog.removeEventListener('close', onClose);
      resolve(confirmDialog.returnValue === 'ok');
    };
    confirmDialog.returnValue = '';
    confirmDialog.addEventListener('close', onClose);
    confirmDialog.showModal();
  });
}
/** サーバーにフォルダがないセッション（Finder で消した、など）。行に「データなし」を出す */
const outputMissing = new Map<string, boolean>();

async function renderSessions() {
  let all: StoredSession[] = [];
  try {
    const activeId = isActive(current) ? current.sessionId : undefined;
    all = (await listSessions()).filter((s) => s.sessionId !== activeId);
  } catch {
    // OPFS unavailable; nothing to list.
  }
  const hiddenCount = all.filter((s) => s.status?.hidden).length;
  const sessions = showHidden ? all : all.filter((s) => !s.status?.hidden);
  sessionsSection.hidden = all.length === 0 || !setupSection.hidden;
  hideSessionTip(false);
  sessionList.replaceChildren(...sessions.map(sessionItem));
  hiddenToggle.hidden = hiddenCount === 0;
  hiddenToggle.textContent = showHidden ? `非表示のセッションを隠す（${hiddenCount}）` : `非表示のセッションを表示（${hiddenCount}）`;
  void checkOutputs(sessions);
}

hiddenToggle.addEventListener('click', () => {
  showHidden = !showHidden;
  void renderSessions();
});

/** 処理済みの行について、サーバーにフォルダが残っているかを一度だけ聞く。なければ描き直して「データなし」を出す */
async function checkOutputs(sessions: readonly StoredSession[]) {
  if (!serverTarget.token) return;
  const targets = sessions.filter((s) => s.status?.stage === 'done' && !outputMissing.has(s.sessionId));
  if (targets.length === 0) return;
  await Promise.all(
    targets.map(async (s) => {
      try {
        const res = await fetch(`http://127.0.0.1:${serverTarget.port}/sessions/${s.sessionId}/status`, { headers: authHeaders(serverTarget), signal: AbortSignal.timeout(3000) });
        if (res.status === 404 || res.ok) outputMissing.set(s.sessionId, res.status === 404);
      } catch {
        // サーバーが落ちていれば分からない（次に描くときにまた聞く）
      }
    }),
  );
  if (targets.some((s) => outputMissing.get(s.sessionId))) await renderSessions();
}

function sessionItem(session: StoredSession): HTMLLIElement {
  const li = document.createElement('li');
  // 1 行目は動画ページのタイトル（古い録音で無ければ日時）、2 行目に日時・長さ・サイズ・枚数
  const title = session.meta?.title?.trim() || formatSessionId(session.sessionId);
  const main = document.createElement('div');
  main.className = 'sessionMain';
  const name = document.createElement('span');
  name.className = 'sessionTitle';
  name.textContent = title;
  const parts = [formatSessionId(session.sessionId), formatBytes(session.audioBytes), `${session.slideCount} 枚`];
  if (session.status?.durationMs !== undefined) parts.splice(1, 0, formatElapsed(session.status.durationMs));
  const metaText = parts.join(' · ');
  const meta = document.createElement('div');
  meta.className = 'sessionMeta';
  meta.textContent = metaText;
  // タイトルが省略されているときだけ、タイトルに乗せる（かボタンに Tab で入る）と全文を出す
  const truncated = () => name.scrollWidth > name.clientWidth;
  name.addEventListener('mouseenter', () => {
    window.clearTimeout(tipShowTimer);
    if (truncated()) tipShowTimer = window.setTimeout(() => showSessionTip(name, li, title), 250);
  });
  name.addEventListener('mouseleave', () => hideSessionTip());
  li.addEventListener('focusin', () => {
    if (truncated()) showSessionTip(name, li, title);
  });
  li.addEventListener('focusout', () => hideSessionTip());
  main.append(name);

  const btns = document.createElement('div');
  btns.className = 'sessionBtns';
  const done = session.status?.stage === 'done';
  const hidden = session.status?.hidden === true;
  const missing = done && outputMissing.get(session.sessionId) === true;
  const inFlight = current.processing?.sessionId === session.sessionId || (current.pendingUploads?.includes(session.sessionId) ?? false);
  const button = (label: string, className = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    return b;
  };
  const tag = (label: string, title = '') => {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = label;
    t.title = title;
    return t;
  };
  // Downloads への生データ書き出しは UI から外した（サーバー側の .lecscribe/ に音声も残るため。EXPORT メッセージ自体は残している）
  if (inFlight) {
    // 処理中・送信待ち: 「中止」だけ。初回なら途中のデータごと消し、やり直し中なら止めるだけ（前回の結果と録音は残る）
    const stopBtn = button('中止');
    stopBtn.disabled = !!current.exporting;
    stopBtn.addEventListener('click', () => {
      const text = done
        ? `「${title}」のやり直しを中止します。前回の結果（~/LecScribe のフォルダ）と録音は残ります。`
        : `「${title}」の文字起こしを中止して、途中までのデータ（~/LecScribe のフォルダと録音）を削除します。`;
      void askConfirm(text, '中止する').then((ok) => {
        if (ok) void act(() => sendToBackground.discard(session.sessionId, done ? { output: 'keep', keepRecording: true } : { output: 'delete' }));
      });
    });
    btns.append(stopBtn, tag(current.processing?.sessionId === session.sessionId ? '処理中' : '送信待ち'));
  } else {
    const uploadBtn = button(done ? 'やり直す' : '文字起こしする', done ? '' : 'primary');
    uploadBtn.title = done ? '同じフォルダに文字起こしをやり直す' : 'ローカルサーバーへ送って文字起こしする（~/LecScribe に出力）';
    uploadBtn.disabled = !!current.exporting || missing;
    uploadBtn.addEventListener('click', () => void act(() => sendToBackground.upload(session.sessionId)));
    const removeBtn = button('削除', 'remove');
    removeBtn.disabled = !!current.exporting;
    removeBtn.addEventListener('click', () => {
      // サーバー側のフォルダは、拡張が「処理済み」と思っていなくても残っていることがある（送信後に拡張が止まった等）。
      // 実際に消す範囲を必ず伝える
      const text = missing
        ? `「${title}」の録音を削除します。~/LecScribe のフォルダは見つかりませんでした。元に戻せません。`
        : `「${title}」の録音と、~/LecScribe のフォルダ（あれば文字起こしの結果も）を削除します。元に戻せません。`;
      void askConfirm(text, '削除する').then((ok) => {
        if (ok) void act(() => sendToBackground.discard(session.sessionId, { output: 'delete' }));
      });
    });
    if (done) {
      const openFolderBtn = button('フォルダを開く', 'primary');
      openFolderBtn.title = session.status?.outputDir ?? '';
      openFolderBtn.disabled = missing;
      openFolderBtn.addEventListener('click', () => void openOutput(session.sessionId, 'folder', session.status?.outputDir));
      // 「非表示」は隠すだけ（データは残る）。一覧の下の「非表示のセッションを表示」で戻せる
      const hideBtn = button(hidden ? '表示' : '非表示');
      hideBtn.addEventListener('click', () => {
        void setSessionHidden(session.sessionId, !hidden)
          .catch((e: unknown) => showMessage(`表示を切り替えられませんでした: ${toErrorInfo(e).message}`))
          .then(() => renderSessions());
      });
      btns.append(openFolderBtn, uploadBtn, hideBtn, removeBtn);
    } else {
      btns.append(uploadBtn, removeBtn);
    }
    if (missing) btns.append(tag('データなし', '~/LecScribe にフォルダがありません（Finder で消した？）'));
    if (hidden) btns.append(tag('非表示'));
    if (session.status?.stage === 'capturing') btns.append(tag('中断'));
    else if (session.status?.stage === 'error') btns.append(tag('エラー', session.status.error ?? ''));
  }
  li.append(main, meta, btns);
  return li;
}

async function act(run: () => Promise<{ state: SessionState }>) {
  message.hidden = true;
  try {
    sessionsKey = ''; // 操作後は一覧を必ず描き直す
    outputMissing.clear(); // フォルダの有無も聞き直す
    render((await run()).state);
  } catch (e) {
    const info = toErrorInfo(e);
    render(current); // render は state.error が無いとメッセージを隠すので、描き直してから出す
    showMessage(`${info.message} (${info.code})`);
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

pairBtn.addEventListener('click', () => {
  pairBtn.disabled = true;
  pairBtn.textContent = 'Mac の画面で「許可」を押してください…';
  void act(async () => {
    try {
      const reply = await sendToBackground.pair();
      await refreshConfig();
      return reply;
    } finally {
      pairBtn.disabled = false;
      pairBtn.textContent = 'このMacと接続';
    }
  }).then(() => {
    if (serverConfigured) showMessage('接続しました。動画ページで Start を押すと録音が始まり、Stop で文字起こしに送られます。', 'info');
  });
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
  if (area === 'local' && changes['config']) void refreshConfig().then(() => render(current)).then(checkServerVersion);
});

onStateChange(render);
void refreshConfig().then(checkServerVersion);
void refreshConfig().then(() => sendToBackground.getState()).then(({ state }) => {
  render(state);
  if (isPopup && !isActive(state)) void showProbe();
});
