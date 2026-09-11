import { defineBackground } from 'wxt/utils/define-background';
import { authHeaders, loadConfig, saveConfig, serverEnabled, type Config } from '../src/config';
import { LecError, toErrorInfo, type ErrorInfo } from '../src/errors';
import { makeSessionId } from '../src/format';
import {
  hasTarget,
  replyWith,
  sendToContent,
  sendToOffscreen,
  type CaptureStopResult,
  type ProbeSummary,
  type SessionMeta,
  type ToBackground,
} from '../src/messages';
import { chooseCandidate, probeVideos, type ProbeResult, type VideoStatus } from '../src/probe';
import {
  INITIAL_STATE,
  isActive,
  readState,
  writeState,
  type ProcessingProgress,
  type SessionState,
  type SessionSummary,
  type WarningCode,
} from '../src/state';

/**
 * Service worker: owns the state machine and wires popup ⇄ offscreen ⇄ content.
 * It may be terminated at any time, so nothing here is kept in memory
 * across events; the live state is in chrome.storage.session and the
 * MediaStream lives in the offscreen document.
 */
export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!hasTarget(msg, 'sw')) return false;
    return replyWith((m: ToBackground, s) => serialized(() => handleMessage(m, s)))(msg, sender, sendResponse);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void serialized(async () => {
      const state = await readState();
      if (state.tabId === tabId && isActive(state)) await stop('tab closed');
    });
  });

  // 録音中のタブがページ遷移すると content script が消える。録音は続ける。
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') void serialized(() => onTabNavigated(tabId));
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state) void serialized(() => onDownloadSettled());
  });

  // The icon opens the popup (that click grants activeTab for the tab, which
  // getMediaStreamId needs; an open side panel would not). Start in the popup
  // opens the side panel for monitoring. Reset the persisted behaviour in
  // case an earlier build set it to open the panel directly.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  // サイドパネルは録音を始めたタブにだけ出す（Start 時にそのタブ向けに有効化する）。
  // 全タブ共通のパネルは無効にして、他のタブでは画面を広く使えるようにする
  void chrome.sidePanel.setOptions({ enabled: false }).catch(() => undefined);

  void serialized(reconcile);
});

/**
 * Every handler reads, mutates and writes the stored state; running them
 * one at a time keeps concurrent events (three downloads finishing at once,
 * a tab closing during Stop) from clobbering each other's writes.
 */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * 送信に失敗した行列を時間を置いて送り直す（#8）。service worker は止まることがあるので setTimeout ではなく
 * chrome.alarms を使う（下限が 30 秒）。成功すれば upload() が次を順に送り、また失敗すれば upload() が掛け直す
 */
const RETRY_ALARM = 'retry-upload';
const RETRY_DELAY_MINUTES = 0.5;

async function scheduleRetry(): Promise<void> {
  await chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_DELAY_MINUTES });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RETRY_ALARM) return;
  void serialized(async () => {
    const current = await readState();
    const [head, ...rest] = current.pendingUploads ?? [];
    if (!head) return;
    // 別のことが動いている間は手を出さない。アラームは 1 回きりなので、掛け直さないと二度と起きない
    if (current.processing || current.exporting) {
      await scheduleRetry();
      return;
    }
    try {
      await upload(head, rest);
    } catch {
      // 送信そのものの失敗は upload() が状態に書き、次のアラームも掛けている。
      // ただし upload() が try に入る前に投げる経路（エクスポート中・未接続）では何も掛からないので、
      // 行列が残っていればここで掛け直す（掛け忘れると行列が誰にも拾われなくなる）
      if ((await readState()).pendingUploads?.length) await scheduleRetry();
    }
  });
});

async function handleMessage(msg: ToBackground, sender: chrome.runtime.MessageSender): Promise<object> {
  switch (msg.type) {
    case 'START':
      return { state: await start(msg.tabId) };
    case 'STOP':
      return { state: await stop('user') };
    case 'GET_STATE':
      return { state: await readState() };
    case 'PAIR':
      return pair();
    case 'EXPORT':
      return { state: await exportSession(msg.sessionId) };
    case 'DISCARD':
      return { state: await discardSession(msg.sessionId, msg) };
    case 'PROBE':
      return { probe: await runProbe(msg.tabId) };
    case 'DETECT_STATUS':
      return onDetectStatus(msg.sessionId, msg.status, sender.frameId);
    case 'CAPTURE_FRAME':
      return captureFrame();
    case 'UPLOAD':
      return { state: await upload(msg.sessionId) };
    case 'PROCESS_STATUS':
      return onProcessStatus(msg.sessionId, msg.progress);
    case 'CAPTURE_ENDED':
      return { state: await stop(`capture ended: ${msg.reason}`) };
    case 'CAPTURE_ERROR':
      return { state: await stop('error', msg.error) };
  }
}

const UNSUPPORTED_URL = /^(chrome|chrome-extension|edge|about|devtools):/;
const DETECTOR_SCRIPT = 'detector.js';

async function start(tabId: number): Promise<SessionState> {
  const current = await readState();
  if (isActive(current)) throw new LecError('BUSY', 'すでにキャプチャ中です。');
  if (current.exporting) throw new LecError('BUSY', 'エクスポートが終わるまでお待ちください。');
  // 前のセッションの文字起こし（processing）は録音と独立に続く。offscreen document は共用

  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new LecError('NO_TAB', '対象のタブが見つかりません。');
  if (tab.url && UNSUPPORTED_URL.test(tab.url)) {
    throw new LecError('UNSUPPORTED_PAGE', 'このページはキャプチャできません。動画ページを開いてから Start してください。');
  }

  const meta: SessionMeta = {
    sessionId: makeSessionId(),
    title: tab.title,
    url: tab.url,
    startedAt: new Date().toISOString(),
  };
  const starting: SessionState = {
    ...INITIAL_STATE,
    state: 'STARTING',
    sessionId: meta.sessionId,
    tabId,
    title: tab.title,
    lastSession: current.lastSession,
    processing: current.processing,
    pendingUploads: current.pendingUploads,
  };
  await writeState(starting);

  try {
    // 動画が見つからなくても音声だけは録る（警告で知らせる）
    const probe = await runProbe(tabId).catch(() => undefined);

    await ensureOffscreenDocument();
    // Requires the extension to have been invoked on this tab (activeTab is
    // granted when the popup opens on it). The id is single-use and short-lived.
    let streamId: string;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (e) {
      const reason = toErrorInfo(e).message;
      const hint = /invoked/i.test(reason)
        ? ' 動画のタブを表示した状態でツールバーの LecScribe アイコンをクリックしてパネルを開き直してから、もう一度 Start してください。'
        : '';
      throw new LecError('CAPTURE_FAILED', `タブのキャプチャを開始できません: ${reason}${hint}`);
    }
    const config = await loadConfig();
    const result = await sendToOffscreen.captureStart(streamId, config, meta);
    const detection = await startDetection(tabId, probe, meta.sessionId, result.recorderStartEpochMs, config);
    const capturing: SessionState = {
      ...starting,
      ...detection,
      state: 'CAPTURING',
      startedAt: new Date(result.recorderStartEpochMs).toISOString(),
    };
    await writeState(capturing);
    return capturing;
  } catch (e) {
    const failed: SessionState = { ...starting, state: 'ERROR', error: toErrorInfo(e) };
    await writeState(failed);
    await closeOffscreenIfIdle();
    throw e;
  }
}

/** 全 frame で probe を走らせて候補を 1 つ選ぶ（SPEC §6.3 手順 3） */
async function runProbe(tabId: number): Promise<ProbeSummary> {
  let results: chrome.scripting.InjectionResult<ProbeResult>[];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probeVideos });
  } catch (e) {
    throw new LecError('PROBE_FAILED', `ページ内の動画を調べられません: ${toErrorInfo(e).message}`);
  }
  const frames = results.map((r) => ({ frameId: r.frameId, result: r.result ?? undefined }));
  return {
    chosen: chooseCandidate(frames),
    videoCount: frames.reduce((n, f) => n + (f.result?.videos.length ?? 0), 0),
    frames: frames.length,
    crossOriginIframes: [...new Set(frames.flatMap((f) => f.result?.crossOriginIframes ?? []))],
  };
}

type Detection = Pick<SessionState, 'frameSource' | 'frameId' | 'video' | 'warnings'>;

/** 選ばれた frame に検知用 content script を注入して追跡を始める。失敗しても録音は続ける。 */
async function startDetection(
  tabId: number,
  probe: ProbeSummary | undefined,
  sessionId: string,
  recorderStartEpochMs: number,
  config: Config,
): Promise<Detection> {
  const chosen = probe?.chosen;
  if (!chosen) {
    const warnings: WarningCode[] = ['NO_VIDEO'];
    if (probe?.crossOriginIframes.length) warnings.push('CROSS_ORIGIN_IFRAME');
    return { frameSource: 'none', warnings };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [chosen.frameId] }, files: [DETECTOR_SCRIPT] });
    const { status } = await sendToContent.detectStart(tabId, chosen.frameId, {
      sessionId,
      selector: chosen.selector,
      index: chosen.index,
      recorderStartEpochMs,
      slide: config.slide,
      detect: config.detect,
    });
    return { frameSource: 'direct', frameId: chosen.frameId, video: status, warnings: videoWarnings(status) };
  } catch (e) {
    console.warn('LecScribe: detector injection failed', toErrorInfo(e));
    return { frameSource: 'none', warnings: ['NO_VIDEO'] };
  }
}

const VIDEO_WARNINGS = new Set<WarningCode>([
  'PLAYBACK_RATE',
  'TAB_HIDDEN',
  'NAVIGATED',
  'NO_VIDEO',
  'CROSS_ORIGIN_IFRAME',
  'DRM',
  'TAINTED',
]);
const STALE_FRAME_MS = 5000;
const EXPORT_LOOKUP_GRACE_MS = 15_000;

function videoWarnings(status: VideoStatus): WarningCode[] {
  const warnings: WarningCode[] = [];
  if (Math.abs(status.playbackRate - 1) > 0.01) warnings.push('PLAYBACK_RATE');
  const stale = status.playing && status.lastFrameAt !== null && Date.now() - status.lastFrameAt > STALE_FRAME_MS;
  if (!status.visible || stale) warnings.push('TAB_HIDDEN');
  if (status.drm) warnings.push('DRM');
  if (status.taintFree === false) warnings.push('TAINTED');
  return warnings;
}

async function onDetectStatus(sessionId: string, status: VideoStatus, frameId: number | undefined): Promise<object> {
  const current = await readState();
  if (current.state !== 'CAPTURING' || current.sessionId !== sessionId || current.frameId !== frameId) return {};
  const others = current.warnings.filter((w) => !VIDEO_WARNINGS.has(w));
  await writeState({ ...current, frameSource: 'direct', video: status, warnings: [...others, ...videoWarnings(status)] });
  return {};
}

/** パネルの「スクショを保存」: 今のフレームを 1 枚保存する（Phase 4 の動作確認用。Phase 5 で自動化） */
async function captureFrame(): Promise<object> {
  const current = await readState();
  if (current.state !== 'CAPTURING') throw new LecError('NOT_CAPTURING', 'キャプチャ中ではありません。');
  if (current.tabId === undefined || current.frameId === undefined || current.frameSource !== 'direct') {
    throw new LecError('NO_VIDEO', '追跡中の動画がありません。');
  }
  return sendToContent.captureFrame(current.tabId, current.frameId, 'manual');
}

async function onTabNavigated(tabId: number): Promise<void> {
  const current = await readState();
  if (current.tabId !== tabId || current.state !== 'CAPTURING' || current.frameSource !== 'direct') return;
  // frameId は残す: SPA 内の遷移で content script が生きていれば次の報告で復帰する
  const warnings: WarningCode[] = [...current.warnings.filter((w) => w !== 'NAVIGATED'), 'NAVIGATED'];
  await writeState({ ...current, video: undefined, frameSource: 'none', warnings });
  // 検知スクリプトが消えるので、timeline に「ここで動画は止まった」を残す。残さないと最後の
  // playing のまま動画時刻が伸び続け、以後の文字起こしが存在しない時刻に割り当てられる
  if (current.sessionId && current.startedAt && current.video) {
    await sendToOffscreen
      .timelineEvent(current.sessionId, {
        t: (Date.now() - Date.parse(current.startedAt)) / 1000,
        videoTime: current.video.currentTime,
        rate: current.video.playbackRate,
        state: 'paused',
        type: 'pause',
      })
      .catch(() => undefined);
  }
}

async function stop(endedBy: string, error?: ErrorInfo): Promise<SessionState> {
  const current = await readState();
  if (!isActive(current)) return current;

  await writeState({ ...current, state: 'STOPPING' });
  if (current.tabId !== undefined && current.frameId !== undefined) {
    await sendToContent.detectStop(current.tabId, current.frameId).catch(() => undefined);
  }
  let result: CaptureStopResult | undefined;
  let stopError: ErrorInfo | undefined;
  try {
    result = await sendToOffscreen.captureStop();
  } catch (e) {
    // The offscreen document may already be gone (capture ended by Chrome);
    // whatever was flushed to OPFS is still exportable.
    stopError = toErrorInfo(e);
  }

  const durationMs = result?.durationMs || (current.startedAt ? Date.now() - Date.parse(current.startedAt) : 0);
  const summary: SessionSummary | undefined = current.sessionId
    ? { sessionId: current.sessionId, startedAt: current.startedAt, durationMs, audioBytes: result?.audioBytes ?? 0, endedBy }
    : undefined;
  const failure = error ?? (stopError && stopError.code !== 'INTERNAL' ? stopError : undefined);
  const completed = !failure && !!summary && !!current.startedAt;
  const config = await loadConfig();
  // 送る候補: 先に待っていた分 → 今回の分
  const queue = [...(current.pendingUploads ?? []), ...(completed && serverEnabled(config) ? [summary!.sessionId] : [])];

  const next: SessionState = {
    ...INITIAL_STATE,
    state: failure ? 'ERROR' : completed ? 'COMPLETED' : 'IDLE',
    title: current.title,
    error: failure,
    lastSession: summary,
    processing: current.processing,
    pendingUploads: queue.length > 0 ? queue : undefined,
  };
  if (current.processing) {
    // 前のセッションの文字起こしがまだ続いている。今回の分は送信待ちに積む
    next.state = current.processing.stage === 'uploading' ? 'UPLOADING' : 'PROCESSING';
    await writeState(next);
    return next;
  }
  await writeState(next);
  await closeOffscreenIfIdle();

  // サーバーが設定されていれば、そのまま送信して文字起こしへ（SPEC §6.4 手順 4）
  if (queue.length > 0) {
    try {
      return await upload(queue[0]!, queue.slice(1));
    } catch {
      return readState();
    }
  }
  return next;
}

/**
 * OPFS のセッションをローカルサーバーへ送り、文字起こしを待つ状態にする。
 * 録音中でも送れる（offscreen document は共用）。pending は続けて送る予定のセッション
 */
async function upload(sessionId: string, pending: string[] = []): Promise<SessionState> {
  const current = await readState();
  if (current.exporting) throw new LecError('BUSY', 'エクスポートが終わるまでお待ちください。');
  const config = await loadConfig();
  if (!serverEnabled(config)) {
    throw new LecError('SERVER_REJECTED', 'ローカルサーバーと接続されていません。設定画面で「このMacと接続」を押してください。');
  }
  // 別のセッションを処理中なら送信待ちに並べる。処理が終わり次第 onProcessStatus が順に送る
  if (current.processing) {
    if (current.processing.sessionId === sessionId) throw new LecError('BUSY', 'このセッションは処理中です。');
    const queue = [...(current.pendingUploads ?? []).filter((id) => id !== sessionId), sessionId, ...pending.filter((id) => id !== sessionId)];
    const queued: SessionState = { ...current, error: undefined, pendingUploads: [...new Set(queue)] };
    await writeState(queued);
    return queued;
  }
  // 送信に失敗して残っている行列（#8）も引き継ぐ。前は処理中にしか行列が無かったので pending だけで足りていた
  const remaining = [...new Set([...pending, ...(current.pendingUploads ?? [])])].filter((id) => id !== sessionId);

  const uploading: SessionState = {
    ...current,
    state: isActive(current) ? current.state : 'UPLOADING',
    error: undefined,
    warnings: current.warnings.filter((w) => w !== 'SERVER_UNREACHABLE'),
    processing: { sessionId, stage: 'uploading', startedAt: Date.now(), percent: 0 },
    pendingUploads: remaining.length > 0 ? remaining : undefined,
  };
  await writeState(uploading);
  try {
    await ensureOffscreenDocument();
    const { outputDir } = await sendToOffscreen.upload(sessionId, config.server);
    const processing: SessionState = {
      ...uploading,
      state: isActive(current) ? current.state : 'PROCESSING',
      processing: { sessionId, stage: 'queued', startedAt: uploading.processing!.startedAt, outputDir },
    };
    await writeState(processing);
    return processing;
  } catch (e) {
    const info = toErrorInfo(e);
    // 一時的な失敗（繋がらない、5xx）なら、失敗した分を先頭に戻して行列を残し、時間を置いて送り直す（#8）。
    // 恒久的な失敗（承認されていない、送るものが無い）は送り直しても同じなので、行列ごと手動に回す
    const retryable = info.retryable === true;
    const failed: SessionState = {
      ...uploading,
      state: isActive(current) ? current.state : 'COMPLETED',
      error: info,
      warnings: retryable ? [...current.warnings.filter((w) => w !== 'SERVER_UNREACHABLE'), 'SERVER_UNREACHABLE'] : current.warnings.filter((w) => w !== 'SERVER_UNREACHABLE'),
      processing: undefined,
      pendingUploads: retryable ? [sessionId, ...remaining] : undefined,
    };
    await writeState(failed);
    if (retryable) await scheduleRetry();
    await closeOffscreenIfIdle();
    throw e;
  }
}

/** offscreen からの進捗。done / error で処理を閉じる */
async function onProcessStatus(
  sessionId: string,
  progress: Omit<ProcessingProgress, 'sessionId' | 'startedAt'>,
): Promise<object> {
  const current = await readState();
  const processing = current.processing;
  if (!processing || processing.sessionId !== sessionId) return {};

  if (progress.stage === 'done' || progress.stage === 'error') {
    const outputDir = progress.outputDir ?? processing.outputDir;
    const lastSession =
      progress.stage === 'done' && current.lastSession?.sessionId === sessionId
        ? { ...current.lastSession, outputDir }
        : current.lastSession;
    const pending = current.pendingUploads ?? [];
    await writeState({
      ...current,
      state: isActive(current) ? current.state : 'COMPLETED',
      processing: undefined,
      lastSession,
      error: progress.stage === 'error' ? { code: 'SERVER_REJECTED', message: progress.error ?? '文字起こしに失敗しました。' } : undefined,
    });
    // 送信待ちがあれば続けて送る（失敗したら手動送信に回る）
    if (pending.length > 0) {
      try {
        await upload(pending[0]!, pending.slice(1));
      } catch {
        // upload 側で状態を書いている
      }
      return {};
    }
    await closeOffscreenIfIdle();
    return {};
  }
  // 送信中の進捗は fire-and-forget で届くので、finalize 後に遅れて処理されることがある。
  // 段階を後戻りさせない
  if (STAGE_RANK[progress.stage] < STAGE_RANK[processing.stage]) return {};
  await writeState({
    ...current,
    // 録音中なら state は録音側のまま。Server 行は processing から描く
    state: isActive(current) ? current.state : progress.stage === 'uploading' ? 'UPLOADING' : 'PROCESSING',
    processing: { ...processing, ...progress },
  });
  return {};
}

const STAGE_RANK: Record<ProcessingProgress['stage'], number> = {
  uploading: 0,
  queued: 1,
  converting: 2,
  transcribing: 3,
  merging: 4,
  polishing: 5,
  done: 6,
  error: 6,
};

/** Downloads the session files through chrome.downloads from blob: URLs minted by the offscreen document. */
async function exportSession(sessionId: string): Promise<SessionState> {
  const current = await readState();
  if (isActive(current) && current.sessionId === sessionId) throw new LecError('BUSY', '録音中のセッションは書き出せません。');
  if (current.exporting) throw new LecError('BUSY', 'エクスポート中です。');

  await ensureOffscreenDocument();
  const { files } = await sendToOffscreen.export(sessionId);
  const downloadIds: number[] = [];
  try {
    for (const file of files) {
      downloadIds.push(
        await chrome.downloads.download({ url: file.url, filename: file.filename, conflictAction: 'uniquify', saveAs: false }),
      );
    }
  } catch (e) {
    await sendToOffscreen.revoke(files.map((f) => f.url)).catch(() => undefined);
    await closeOffscreenIfIdle();
    throw new LecError('EXPORT_FAILED', `ダウンロードを開始できません: ${toErrorInfo(e).message}`);
  }
  const next: SessionState = {
    ...current,
    error: undefined,
    exporting: { sessionId, startedAt: Date.now(), downloadIds, urls: files.map((f) => f.url) },
  };
  await writeState(next);
  return next;
}

/** Idempotent: looks at the real state of every download of the export instead of trusting one delta. */
async function onDownloadSettled(): Promise<void> {
  const current = await readState();
  const exporting = current.exporting;
  if (!exporting) return;

  const items = await Promise.all(
    exporting.downloadIds.map((id) => chrome.downloads.search({ id }).then((found) => found[0])),
  );
  // 作成直後は search がまだ項目を返さないことがある。猶予時間内の「見つからない」は
  // 進行中とみなし、それを過ぎても見つからなければ（履歴から消された等）完了扱いにする。
  const withinGrace = Date.now() - exporting.startedAt < EXPORT_LOOKUP_GRACE_MS;
  const unsettled = items.some((item) => (item ? item.state === 'in_progress' : withinGrace));
  if (unsettled) return;

  const interrupted = items.find((item) => item?.state === 'interrupted');
  const error: ErrorInfo | undefined = interrupted
    ? { code: 'EXPORT_FAILED', message: `ダウンロードが中断されました: ${interrupted.error ?? 'unknown'}` }
    : current.error;
  await sendToOffscreen.revoke(exporting.urls).catch(() => undefined);
  const lastSession =
    current.lastSession?.sessionId === exporting.sessionId && !interrupted
      ? { ...current.lastSession, exported: true }
      : current.lastSession;
  await writeState({ ...current, error, exporting: undefined, lastSession });
  await closeOffscreenIfIdle();
}

/**
 * 一覧の「中止」「削除」。
 * - 処理中・送信待ち: 処理を止める。output が 'keep' でなければサーバー側のフォルダも消す（'delete' なら notes.md があっても）
 * - それ以外: output が 'delete' ならサーバー側のフォルダを消す
 * - keepRecording でなければ Chrome 側の録音（OPFS）を消す（やり直しの中止では残す）
 */
async function discardSession(sessionId: string, options: { output?: 'keep' | 'delete'; keepRecording?: boolean } = {}): Promise<SessionState> {
  let current = await readState();
  if (isActive(current) && current.sessionId === sessionId) throw new LecError('BUSY', '録音中のセッションは削除できません。');
  if (current.exporting) throw new LecError('BUSY', 'エクスポート中です。');

  const config = await loadConfig();
  const wasProcessing = current.processing?.sessionId === sessionId;
  const wasPending = current.pendingUploads?.includes(sessionId) ?? false;
  const force = options.output === 'delete';
  await ensureOffscreenDocument();
  if (wasProcessing) {
    await sendToOffscreen.cancelUpload(sessionId).catch(() => undefined);
    await cancelOnServer(sessionId, config.server, options.output !== 'keep', force);
    current = { ...current, processing: undefined, error: undefined };
  } else if (wasPending) {
    await cancelOnServer(sessionId, config.server, options.output !== 'keep', force);
  } else if (force) {
    await cancelOnServer(sessionId, config.server, true, true);
  }
  if (!options.keepRecording) {
    try {
      await sendToOffscreen.discard(sessionId);
    } catch (e) {
      await writeState(current);
      throw e;
    }
  }
  // 直前のセッションを捨てるときだけ IDLE に戻す。別のセッションを録音中なら、その録音の状態は触らない。録音を残すなら捨てていない
  const isLast = current.lastSession?.sessionId === sessionId && !options.keepRecording;
  const next: SessionState =
    isLast && !isActive(current)
      ? { ...INITIAL_STATE, title: current.title, processing: current.processing, pendingUploads: current.pendingUploads }
      : { ...current, error: undefined, lastSession: isLast ? undefined : current.lastSession };
  // 処理を中止したら、録音中でなければ「処理中」表示から抜ける（残る処理があれば upload() が state を立て直す）
  if (wasProcessing && !isActive(current)) next.state = current.lastSession ? 'COMPLETED' : 'IDLE';
  next.pendingUploads = next.pendingUploads?.filter((id) => id !== sessionId);
  if (next.pendingUploads?.length === 0) next.pendingUploads = undefined;
  await writeState(next);

  // 中止で空いたなら、送信待ちの次を進める
  if (wasProcessing && next.pendingUploads?.length) {
    const [head, ...rest] = next.pendingUploads;
    try {
      return await upload(head!, rest);
    } catch {
      return readState();
    }
  }
  await closeOffscreenIfIdle();
  return next;
}

/**
 * ローカルサーバーと接続する。サーバーが Mac のダイアログで承認を求め、「許可」なら拡張専用のトークンを返すので保存する。
 * ポップアップはダイアログにフォーカスを取られて閉じるため、fetch はここ（service worker）で行う
 */
async function pair(): Promise<{ state: SessionState; paired: boolean }> {
  const config = await loadConfig();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${config.server.port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: chrome.runtime.getManifest().name }),
    });
  } catch (e) {
    throw new LecError(
      'SERVER_UNREACHABLE',
      `ローカルサーバーに接続できません（127.0.0.1:${config.server.port}）。サーバーを起動してください。${toErrorInfo(e).message}`,
    );
  }
  const body = (await res.json().catch(() => undefined)) as { paired?: boolean; token?: string; error?: { message?: string } } | undefined;
  if (!res.ok || !body?.paired || !body.token) {
    throw new LecError('SERVER_REJECTED', body?.error?.message ?? `接続できませんでした（HTTP ${res.status}）`);
  }
  await saveConfig({ ...config, server: { ...config.server, paired: true, token: body.token } });
  const current = await readState();
  return { state: { ...current, error: undefined, warnings: current.warnings.filter((w) => w !== 'SERVER_UNREACHABLE') }, paired: true };
}

/** サーバーの処理を止める。remove でフォルダも消す（force なら notes.md があっても）。繋がらなくても破棄は続ける */
async function cancelOnServer(sessionId: string, server: Config['server'], remove: boolean, force = false): Promise<void> {
  if (!server.paired && !server.token) return;
  try {
    // サーバーが別のセッションを処理中だと応答が遅れることがある。待ち続けると拡張のメッセージが詰まる
    await fetch(`http://127.0.0.1:${server.port}/sessions/${sessionId}/cancel`, {
      method: 'POST',
      headers: { ...authHeaders(server), 'content-type': 'application/json' },
      body: JSON.stringify({ delete: remove, force }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // サーバーが落ちていれば処理も止まっている
  }
}

/** If the worker restarted and the offscreen document is gone, the session cannot continue. */
async function reconcile(): Promise<void> {
  const state = await readState();
  if (await hasOffscreenDocument()) return;
  if (state.processing) {
    // 送信・polling は offscreen document が持っていた。再送で続きから処理できる。
    // 順番を待っていただけの分は何も失敗していないので残し、アラームで順に送る（#8）
    const pending = state.pendingUploads ?? [];
    await writeState({
      ...state,
      state: isActive(state) ? state.state : 'COMPLETED',
      processing: undefined,
      pendingUploads: pending.length > 0 ? pending : undefined,
      warnings: [...state.warnings.filter((w) => w !== 'SERVER_UNREACHABLE'), 'SERVER_UNREACHABLE'],
      error: { code: 'SERVER_UNREACHABLE', message: '拡張が再起動したため進捗を見失いました。一覧の「文字起こしする」で再開できます。' },
    });
    if (pending.length > 0) await scheduleRetry();
    if (!isActive(state)) return;
  }
  if (!isActive(state)) return;
  const summary: SessionSummary | undefined = state.sessionId
    ? {
        sessionId: state.sessionId,
        startedAt: state.startedAt,
        durationMs: state.startedAt ? Date.now() - Date.parse(state.startedAt) : 0,
        audioBytes: 0,
        endedBy: 'extension restarted',
      }
    : undefined;
  await writeState({ ...INITIAL_STATE, state: summary ? 'COMPLETED' : 'IDLE', title: state.title, lastSession: summary });
}

const OFFSCREEN_URL = 'offscreen.html';

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture the audio of the lecture tab with chrome.tabCapture, play it back to the user and record it locally.',
    });
  } catch (e) {
    throw new LecError('OFFSCREEN_FAILED', `offscreen document を作成できません: ${toErrorInfo(e).message}`);
  }
}

async function closeOffscreenDocument(): Promise<void> {
  if (!(await hasOffscreenDocument())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Already closed.
  }
}

/** 録音・送信・文字起こしの polling・エクスポートのどれも動いていないときだけ閉じる */
async function closeOffscreenIfIdle(): Promise<void> {
  const state = await readState();
  if (isActive(state) || state.processing || state.exporting) return;
  await closeOffscreenDocument();
}
