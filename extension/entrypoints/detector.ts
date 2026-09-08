import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import type { Config } from '../src/config';
import { ChangeDetector, type Frame, type Verdict } from '../src/detect';
import { LecError } from '../src/errors';
import {
  hasTarget,
  replyWith,
  sendToBackground,
  sendToOffscreen,
  type CaptureFrameResult,
  type DetectStartResult,
  type SlideReason,
  type ToContent,
} from '../src/messages';
import type { SlideMeta } from '../src/opfs/session-store';
import type { VideoStatus } from '../src/probe';
import { isDuplicateEvent, videoState, type TimelineEvent, type TimelineEventType } from '../src/timeline';

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
  slide: Config['slide'];
  detect: Config['detect'];
  detector: ChangeDetector;
  /** 比較用の縮小フレームを描く canvas */
  smallCtx: CanvasRenderingContext2D;
  sampleTimer: number;
  tickTimer: number;
  lastVerdict: Verdict | null;
  lastTimeline: TimelineEvent | undefined;
  lastFrameAt: number | null;
  taintFree: boolean | null;
  heartbeat: number;
  frameCallback: number | null;
  /** フレーム取得中（同時に 2 枚は撮らない） */
  grabbing: boolean;
  onEvent: (event: Event) => void;
  onVisibility: () => void;
  onInitial: () => void;
};

/** 再生が（再）開始されるイベント。ここから「フレームが来ない時間」を測り直す */
const RESTART_EVENTS = new Set(['play', 'playing', 'seeked']);
/** タイムラインに記録する <video> のイベント（SPEC §10.1） */
const TIMELINE_EVENTS = new Set<string>(['play', 'pause', 'seeked', 'ratechange', 'waiting', 'playing', 'ended']);

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
      void stopDetection();
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
    case 'CAPTURE_FRAME': {
      if (!session) throw new LecError('NOT_CAPTURING', '動画を追跡していません。');
      return grabFrame(session, msg.reason);
    }
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
  void stopDetection();
  const video = findVideo(msg.selector, msg.index);
  if (!video) throw new LecError('NO_VIDEO', '動画要素が見つかりません。');

  const small = document.createElement('canvas');
  small.width = msg.detect.detectWidth;
  small.height = msg.detect.detectHeight;
  const smallCtx = small.getContext('2d', { willReadFrequently: true });
  if (!smallCtx) throw new LecError('CAPTURE_FAILED', 'canvas を作成できません。');

  const current: Session = {
    sessionId: msg.sessionId,
    video,
    selector: msg.selector,
    recorderStartEpochMs: msg.recorderStartEpochMs,
    slide: msg.slide,
    detect: msg.detect,
    detector: new ChangeDetector(msg.detect),
    smallCtx,
    sampleTimer: 0,
    tickTimer: 0,
    lastVerdict: null,
    lastTimeline: undefined,
    lastFrameAt: null,
    taintFree: null,
    heartbeat: 0,
    frameCallback: null,
    grabbing: false,
    onInitial: () => void grabFrame(current, 'initial').catch(() => undefined),
    onEvent: (event) => {
      // 一時停止中に経過した時間を「非表示でフレームが止まった」と誤判定しないよう、
      // 再生の再開やシークの時点でフレーム時刻を今にそろえる（SPEC §8.6）。
      if (RESTART_EVENTS.has(event.type)) current.lastFrameAt = Date.now();
      if (TIMELINE_EVENTS.has(event.type)) recordTimeline(current, event.type as TimelineEventType);
      // 停止した瞬間の画面は確実に静止しているので、安定待ち中なら即判定する
      if (event.type === 'pause' || event.type === 'ended') flushDetection(current);
      void report(current);
    },
    onVisibility: () => void report(current),
  };
  for (const name of VIDEO_EVENTS) video.addEventListener(name, current.onEvent);
  document.addEventListener('visibilitychange', current.onVisibility);
  current.heartbeat = window.setInterval(() => void report(current), HEARTBEAT_MS);
  current.sampleTimer = window.setInterval(() => sampleOnce(current), msg.detect.sampleIntervalMs);
  // 再生中は定期的に記録して、バッファリングなどによるずれの上限を抑える
  current.tickTimer = window.setInterval(() => {
    if (!video.paused && !video.ended) recordTimeline(current, 'tick');
  }, msg.detect.tickIntervalMs);

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
  recordTimeline(current, 'start');

  // 最初の 1 枚は無条件に保存する（SPEC §9.2）。まだ読み込み中なら読み込み後に撮る
  if (video.readyState >= 2 && video.videoWidth > 0) current.onInitial();
  else video.addEventListener('loadeddata', current.onInitial, { once: true });

  return { status: snapshot(current) };
}

async function stopDetection(): Promise<object> {
  const current = session;
  session = null;
  if (!current) return {};
  for (const name of VIDEO_EVENTS) current.video.removeEventListener(name, current.onEvent);
  current.video.removeEventListener('loadeddata', current.onInitial);
  document.removeEventListener('visibilitychange', current.onVisibility);
  window.clearInterval(current.heartbeat);
  window.clearInterval(current.sampleTimer);
  window.clearInterval(current.tickTimer);
  if (current.frameCallback !== null && typeof current.video.cancelVideoFrameCallback === 'function') {
    current.video.cancelVideoFrameCallback(current.frameCallback);
  }
  // 録音停止より先に書き終えたいので、stop だけは応答前に送り切る
  await sendToOffscreen.timelineEvent(current.sessionId, timelineEvent(current, 'stop')).catch(() => undefined);
  return {};
}

function timelineEvent(current: Session, type: TimelineEventType): TimelineEvent {
  const { video } = current;
  return {
    t: (Date.now() - current.recorderStartEpochMs) / 1000,
    videoTime: video.currentTime,
    rate: video.playbackRate,
    state: videoState(video),
    type,
  };
}

function recordTimeline(current: Session, type: TimelineEventType): void {
  const event = timelineEvent(current, type);
  if (isDuplicateEvent(current.lastTimeline, event)) return;
  current.lastTimeline = event;
  void sendToOffscreen.timelineEvent(current.sessionId, event).catch(() => undefined);
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
    detect: current.lastVerdict
      ? { state: current.lastVerdict.state, diffPrev: current.lastVerdict.diffPrev, diffSaved: current.lastVerdict.diffSaved }
      : undefined,
    updatedAt: Date.now(),
  };
}

/** 比較用の縮小 RGBA 画像を取る（getImageData は毎回新しいバッファを返すのでそのまま保持できる） */
function grayFrame(current: Session): Frame {
  const { detectWidth: w, detectHeight: h } = current.detect;
  current.smallCtx.drawImage(current.video, 0, 0, w, h);
  return current.smallCtx.getImageData(0, 0, w, h).data;
}

function canSample(current: Session): boolean {
  const { video } = current;
  if (session !== current || current.grabbing) return false;
  if (video.readyState < 2 || video.videoWidth === 0) return false;
  if (current.taintFree === null) current.taintFree = checkTaint(video);
  return current.taintFree === true;
}

/** sampleIntervalMs ごとの変化検知（SPEC §9.2）。一時停止中は何もしない */
function sampleOnce(current: Session): void {
  if (!canSample(current) || current.video.paused || current.video.ended) return;
  const verdict = current.detector.sample(grayFrame(current), Date.now());
  current.lastVerdict = verdict;
  if (verdict.save) void grabFrame(current, 'change').catch(() => undefined);
}

/** 一時停止・終了の瞬間に安定待ちを打ち切る */
function flushDetection(current: Session): void {
  if (!canSample(current)) return;
  const verdict = current.detector.flush(grayFrame(current), Date.now());
  current.lastVerdict = verdict;
  if (verdict.save) void grabFrame(current, 'change').catch(() => undefined);
}

/**
 * <video> の今のフレームを canvas に描いて画像にし、offscreen document に保存させる
 * （SPEC §8.3）。プレイヤー UI やカーソルは映らず、解像度は動画のネイティブ値。
 */
async function grabFrame(current: Session, reason: SlideReason): Promise<CaptureFrameResult> {
  const { video, slide } = current;
  if (video.readyState < 2 || video.videoWidth === 0) throw new LecError('NO_VIDEO', '動画がまだ読み込まれていません。');
  if (current.taintFree === null) current.taintFree = checkTaint(video);
  if (current.taintFree === false) {
    throw new LecError('CAPTURE_FAILED', 'この動画は canvas に描けないため画像を取得できません（cross-origin）。');
  }
  if (current.grabbing) throw new LecError('BUSY', '前の画像の保存が終わっていません。');
  current.grabbing = true;
  try {
    const scale = slide.maxSlideWidth > 0 && video.videoWidth > slide.maxSlideWidth ? slide.maxSlideWidth / video.videoWidth : 1;
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    const videoTime = video.currentTime;
    const capturedAt = new Date();

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new LecError('CAPTURE_FAILED', 'canvas を作成できません。');
    ctx.drawImage(video, 0, 0, width, height);

    const mime = slide.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, slide.jpegQuality));
    if (!blob) throw new LecError('CAPTURE_FAILED', '画像のエンコードに失敗しました。');

    const saved = await sendToOffscreen.slide({
      sessionId: current.sessionId,
      videoTime,
      t: (capturedAt.getTime() - current.recorderStartEpochMs) / 1000,
      capturedAt: capturedAt.toISOString(),
      width,
      height,
      mime,
      dataBase64: await blobToBase64(blob),
      reason,
    });
    const meta: SlideMeta = {
      filename: saved.filename,
      seq: saved.seq,
      videoTime,
      t: (capturedAt.getTime() - current.recorderStartEpochMs) / 1000,
      capturedAt: capturedAt.toISOString(),
      width,
      height,
      source: 'direct',
      reason,
      bytes: saved.bytes,
    };
    // 手動や開始時の保存も「最後に保存した画像」として重複判定の基準にする
    current.detector.markSaved(grayFrame(current), Date.now());
    return { slide: meta };
  } finally {
    current.grabbing = false;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

async function report(current: Session): Promise<void> {
  if (session !== current) return;
  try {
    await sendToBackground.detectStatus(current.sessionId, snapshot(current));
  } catch {
    // service worker が起動中、または拡張が再読み込みされた。次の報告で回復する。
  }
}
