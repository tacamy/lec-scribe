import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { LecError } from '../src/errors';
import { hasTarget, replyWith, sendToBackground, type DetectStartResult, type ToContent } from '../src/messages';
import type { VideoStatus } from '../src/probe';

/**
 * 検知用 content script（SPEC §6.2, §8）。
 *
 * Start 時に service worker が動画のある frame にだけ注入する
 * （chrome.scripting.executeScript + files）。Phase 3 では対象の <video> を
 * 追跡して状態を service worker へ報告するところまで。フレーム取得と
 * 変化検知は Phase 4〜5、タイムライン記録は Phase 6 で足す。
 */
const HEARTBEAT_MS = 5000;
const VIDEO_EVENTS = [
  'play',
  'pause',
  'seeked',
  'ratechange',
  'waiting',
  'playing',
  'ended',
  'loadedmetadata',
  'emptied',
] as const;

type Session = {
  sessionId: string;
  video: HTMLVideoElement;
  selector: string;
  recorderStartEpochMs: number;
  lastFrameAt: number | null;
  taintFree: boolean | null;
  heartbeat: number;
  frameCallback: number | null;
  onEvent: (event: Event) => void;
  onVisibility: () => void;
};

/** 再生が（再）開始されるイベント。ここから「フレームが来ない時間」を測り直す */
const RESTART_EVENTS = new Set(['play', 'playing', 'seeked']);

let session: Session | null = null;

declare global {
  interface Window {
    __lecscribeDetector?: { dispose(): void };
  }
}

export default defineUnlistedScript(() => {
  // 同じ frame に二重に注入された場合は前のリスナーを外す
  window.__lecscribeDetector?.dispose();

  const listener = (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
    if (!hasTarget(msg, 'content')) return false;
    return replyWith(handleMessage)(msg, sender, sendResponse);
  };
  chrome.runtime.onMessage.addListener(listener);
  window.__lecscribeDetector = {
    dispose() {
      stopDetection();
      chrome.runtime.onMessage.removeListener(listener);
    },
  };
});

async function handleMessage(msg: ToContent): Promise<object | void> {
  switch (msg.type) {
    case 'DETECT_START':
      return startDetection(msg);
    case 'DETECT_STOP':
      return stopDetection();
  }
}

function area(video: HTMLVideoElement): number {
  const rect = video.getBoundingClientRect();
  return Math.max(rect.width * rect.height, video.videoWidth * video.videoHeight);
}

/** probe が返したセレクタで探し、だめなら位置、最後は最大面積の <video> に倒す */
function findVideo(selector: string, index: number): HTMLVideoElement | undefined {
  const bySelector = document.querySelector(selector);
  if (bySelector instanceof HTMLVideoElement) return bySelector;
  const all = Array.from(document.querySelectorAll('video'));
  return all[index] ?? [...all].sort((a, b) => area(b) - area(a))[0];
}

function startDetection(msg: Extract<ToContent, { type: 'DETECT_START' }>): DetectStartResult {
  stopDetection();
  const video = findVideo(msg.selector, msg.index);
  if (!video) throw new LecError('NO_VIDEO', '動画要素が見つかりません。');

  const current: Session = {
    sessionId: msg.sessionId,
    video,
    selector: msg.selector,
    recorderStartEpochMs: msg.recorderStartEpochMs,
    lastFrameAt: null,
    taintFree: null,
    heartbeat: 0,
    frameCallback: null,
    onEvent: (event) => {
      // 一時停止中に経過した時間を「非表示でフレームが止まった」と誤判定しないよう、
      // 再生の再開やシークの時点でフレーム時刻を今にそろえる（SPEC §8.6）。
      if (RESTART_EVENTS.has(event.type)) current.lastFrameAt = Date.now();
      void report(current);
    },
    onVisibility: () => void report(current),
  };
  for (const name of VIDEO_EVENTS) video.addEventListener(name, current.onEvent);
  document.addEventListener('visibilitychange', current.onVisibility);
  current.heartbeat = window.setInterval(() => void report(current), HEARTBEAT_MS);

  // 描画されたフレームの時刻を追う。非表示タブでは止まるので、
  // 「再生中なのにフレームが来ない」= TAB_HIDDEN の判定に使う（SPEC §8.6）。
  if (typeof video.requestVideoFrameCallback === 'function') {
    const tick = () => {
      if (session !== current) return;
      current.lastFrameAt = Date.now();
      current.frameCallback = video.requestVideoFrameCallback(tick);
    };
    current.frameCallback = video.requestVideoFrameCallback(tick);
  }

  session = current;
  return { status: snapshot(current) };
}

function stopDetection(): object {
  const current = session;
  session = null;
  if (!current) return {};
  for (const name of VIDEO_EVENTS) current.video.removeEventListener(name, current.onEvent);
  document.removeEventListener('visibilitychange', current.onVisibility);
  window.clearInterval(current.heartbeat);
  if (current.frameCallback !== null && typeof current.video.cancelVideoFrameCallback === 'function') {
    current.video.cancelVideoFrameCallback(current.frameCallback);
  }
  return {};
}

/** canvas に描けるか（tainted でないか）を一度だけ判定する */
function checkTaint(video: HTMLVideoElement): boolean | null {
  if (video.readyState < 2 || video.videoWidth === 0) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function snapshot(current: Session): VideoStatus {
  const { video } = current;
  if (current.taintFree === null) current.taintFree = checkTaint(video);
  return {
    selector: current.selector,
    player: video.classList.contains('vjs-tech') ? 'video.js' : 'html5',
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    currentTime: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : null,
    paused: video.paused,
    ended: video.ended,
    playing: !video.paused && !video.ended && video.readyState > 2,
    playbackRate: video.playbackRate,
    readyState: video.readyState,
    visible: document.visibilityState === 'visible',
    lastFrameAt: current.lastFrameAt,
    taintFree: current.taintFree,
    drm: video.mediaKeys !== null && video.mediaKeys !== undefined,
    updatedAt: Date.now(),
  };
}

async function report(current: Session): Promise<void> {
  if (session !== current) return;
  try {
    await sendToBackground.detectStatus(current.sessionId, snapshot(current));
  } catch {
    // service worker が起動中、または拡張が再読み込みされた。次の報告で回復する。
  }
}
