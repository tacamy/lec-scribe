import { defineBackground } from 'wxt/utils/define-background';
import { loadConfig } from '../src/config';
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

async function handleMessage(msg: ToBackground, sender: chrome.runtime.MessageSender): Promise<object> {
  switch (msg.type) {
    case 'START':
      return { state: await start(msg.tabId) };
    case 'STOP':
      return { state: await stop('user') };
    case 'GET_STATE':
      return { state: await readState() };
    case 'EXPORT':
      return { state: await exportSession(msg.sessionId) };
    case 'DISCARD':
      return { state: await discardSession(msg.sessionId) };
    case 'PROBE':
      return { probe: await runProbe(msg.tabId) };
    case 'DETECT_STATUS':
      return onDetectStatus(msg.sessionId, msg.status, sender.frameId);
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

  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new LecError('NO_TAB', '対象のタブが見つかりません。');
  if (tab.url && UNSUPPORTED_URL.test(tab.url)) {
    throw new LecError('UNSUPPORTED_PAGE', 'このページはキャプチャできません。講義ページを開いてから Start してください。');
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
        ? ' 講義タブを表示した状態でツールバーの LecScribe アイコンをクリックしてパネルを開き直してから、もう一度 Start してください。'
        : '';
      throw new LecError('CAPTURE_FAILED', `タブのキャプチャを開始できません: ${reason}${hint}`);
    }
    const config = await loadConfig();
    const result = await sendToOffscreen.captureStart(streamId, config, meta);
    const detection = await startDetection(tabId, probe, meta.sessionId, result.recorderStartEpochMs);
    const capturing: SessionState = {
      ...starting,
      ...detection,
      state: 'CAPTURING',
      startedAt: new Date(result.recorderStartEpochMs).toISOString(),
    };
    await writeState(capturing);
    return capturing;
  } catch (e) {
    await closeOffscreenDocument();
    const failed: SessionState = { ...starting, state: 'ERROR', error: toErrorInfo(e) };
    await writeState(failed);
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

async function onTabNavigated(tabId: number): Promise<void> {
  const current = await readState();
  if (current.tabId !== tabId || current.state !== 'CAPTURING' || current.frameSource !== 'direct') return;
  // frameId は残す: SPA 内の遷移で content script が生きていれば次の報告で復帰する
  const warnings: WarningCode[] = [...current.warnings.filter((w) => w !== 'NAVIGATED'), 'NAVIGATED'];
  await writeState({ ...current, video: undefined, frameSource: 'none', warnings });
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
  await closeOffscreenDocument();

  const durationMs = result?.durationMs ?? (current.startedAt ? Date.now() - Date.parse(current.startedAt) : 0);
  const summary: SessionSummary | undefined = current.sessionId
    ? { sessionId: current.sessionId, startedAt: current.startedAt, durationMs, audioBytes: result?.audioBytes ?? 0, endedBy }
    : undefined;
  const failure = error ?? (stopError && stopError.code !== 'INTERNAL' ? stopError : undefined);
  const next: SessionState = {
    ...INITIAL_STATE,
    state: failure ? 'ERROR' : summary && current.startedAt ? 'COMPLETED' : 'IDLE',
    title: current.title,
    error: failure,
    lastSession: summary,
  };
  await writeState(next);
  return next;
}

/** Downloads the session files through chrome.downloads from blob: URLs minted by the offscreen document. */
async function exportSession(sessionId: string): Promise<SessionState> {
  const current = await readState();
  if (isActive(current)) throw new LecError('BUSY', 'キャプチャ中はエクスポートできません。');
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
    await closeOffscreenDocument();
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
  if (!isActive(current)) await closeOffscreenDocument();
  const lastSession =
    current.lastSession?.sessionId === exporting.sessionId && !interrupted
      ? { ...current.lastSession, exported: true }
      : current.lastSession;
  await writeState({ ...current, error, exporting: undefined, lastSession });
}

async function discardSession(sessionId: string): Promise<SessionState> {
  const current = await readState();
  if (isActive(current)) throw new LecError('BUSY', 'キャプチャ中は削除できません。');
  if (current.exporting) throw new LecError('BUSY', 'エクスポート中です。');

  await ensureOffscreenDocument();
  try {
    await sendToOffscreen.discard(sessionId);
  } finally {
    await closeOffscreenDocument();
  }
  const next: SessionState =
    current.lastSession?.sessionId === sessionId
      ? { ...INITIAL_STATE, title: current.title }
      : { ...current, error: undefined };
  await writeState(next);
  return next;
}

/** If the worker restarted and the offscreen document is gone, the session cannot continue. */
async function reconcile(): Promise<void> {
  const state = await readState();
  if (!isActive(state)) return;
  if (await hasOffscreenDocument()) return;
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
