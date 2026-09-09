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
  /** 直近の判定履歴（診断用。DETECT_STOP の応答で返す） */
  verdicts: VerdictLog[];
  /** 直近の「静止していた」フレーム。切り替わりを検知したときに、前のスライドの最終状態として使う */
  stable: { frame: Frame; videoTime: number; t: number; at: number } | null;
  /** そのフレームのフル解像度（stable と同時に描く） */
  fullCanvas: HTMLCanvasElement | null;
  /** 最後に保存（または上書き）したスライド。最終状態との比較に使う */
  lastSaved: { seq: number; frame: Frame; at: number } | null;
  finalizing: boolean;
  /** ページ上のフィードバック表示 */
  toastHost: HTMLElement | null;
  toastTimer: number;
  lastTimeline: TimelineEvent | undefined;
  lastFrameAt: number | null;
  taintFree: boolean | null;
  heartbeat: number;
  frameCallback: number | null;
  /** フレーム取得中（同時に 2 枚は撮らない） */
  /** 保存は 1 枚ずつ順番に行う（サンプリングは止めない） */
  grabQueue: Promise<unknown>;
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
  // probe のセレクタが一意でない（'video' など）ときは、同じ並びの index 番目を取る
  const matches = Array.from(document.querySelectorAll(selector)).filter((el): el is HTMLVideoElement => el instanceof HTMLVideoElement);
  if (matches.length === 1) return matches[0];
  if (matches[index]) return matches[index];
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
    verdicts: [],
    stable: null,
    fullCanvas: null,
    lastSaved: null,
    finalizing: false,
    toastHost: null,
    toastTimer: 0,
    lastTimeline: undefined,
    lastFrameAt: null,
    taintFree: null,
    heartbeat: 0,
    frameCallback: null,
    grabQueue: Promise.resolve(),
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
  // 今映っている画面が最後のスライドの最終状態。保存済みと違えば上書きしてから止める
  if (canSample(current)) {
    rememberStable(current, grayFrame(current));
    await finalizePrevious(current).catch(() => undefined);
  }
  current.toastHost?.remove();
  // 録音停止より先に書き終えたいので、stop だけは応答前に送り切る
  await sendToOffscreen.timelineEvent(current.sessionId, timelineEvent(current, 'stop')).catch(() => undefined);
  return { verdicts: current.verdicts };
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
  if (session !== current) return false;
  if (video.readyState < 2 || video.videoWidth === 0) return false;
  if (current.taintFree === null) current.taintFree = checkTaint(video);
  return current.taintFree === true;
}

/** sampleIntervalMs ごとの変化検知（SPEC §9.2）。一時停止中は何もしない */
function sampleOnce(current: Session): void {
  if (!canSample(current) || current.video.paused || current.video.ended) return;
  const frame = grayFrame(current);
  const wasWatching = current.lastVerdict === null || current.lastVerdict.state === 'watching';
  const verdict = current.detector.sample(frame, Date.now());
  current.lastVerdict = verdict;
  logVerdict(current, 'sample', verdict);
  if (verdict.state === 'stabilizing' && wasWatching) {
    // 切り替わりを検知した瞬間: 直前まで静止していたフレームが前のスライドの最終状態
    void finalizePrevious(current).catch(() => undefined);
  } else if (verdict.state === 'watching' && !verdict.save && verdict.diffPrev < current.detect.changeThreshold) {
    // 切り替わりではない小さな変化（ワイプの動き、文字が 1 行増えた）も含めて「同じスライドの最新の画面」として持つ
    rememberStable(current, frame);
  }
  if (verdict.save) void grabFrame(current, 'change').catch(() => undefined);
}

/** 静止しているフレームをフル解像度で取っておく（切り替わりのときに前のスライドの最終状態として使う） */
function rememberStable(current: Session, frame: Frame): void {
  if (!current.slide.finalState) return;
  const { video, slide } = current;
  const scale = slide.maxSlideWidth > 0 && video.videoWidth > slide.maxSlideWidth ? slide.maxSlideWidth / video.videoWidth : 1;
  const width = Math.round(video.videoWidth * scale);
  const height = Math.round(video.videoHeight * scale);
  if (width === 0 || height === 0) return;
  current.fullCanvas ??= document.createElement('canvas');
  const canvas = current.fullCanvas;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, width, height);
  const now = Date.now();
  current.stable = { frame, videoTime: video.currentTime, t: (now - current.recorderStartEpochMs) / 1000, at: now };
  logVerdict(current, 'stable', { save: false, state: 'watching', diffPrev: 0, cells: 0, stillFraction: 1 }, `${width}x${height}`);
}

/**
 * 前のスライドの最終状態（切り替わる直前に静止していたフレーム）が保存済みの画像と違えば、
 * その画像を上書きする。文字が 1 行ずつ出るスライドで、全部出た状態を残すため（SPEC §9.2）
 */
async function finalizePrevious(current: Session): Promise<void> {
  const { stable, lastSaved, fullCanvas } = current;
  const note = (why: string) => logVerdict(current, 'final', { save: false, state: 'watching', diffPrev: 0, cells: 0, stillFraction: 1 }, why);
  if (!current.slide.finalState) return;
  if (!stable || !lastSaved || !fullCanvas || current.finalizing) {
    note(`skip stable=${!!stable} saved=${!!lastSaved} canvas=${!!fullCanvas} finalizing=${current.finalizing}`);
    return;
  }
  if (stable.at <= lastSaved.at) {
    note(`skip older stable=${stable.at} saved=${lastSaved.at}`);
    return; // 保存より前のフレームなら、保存した画像のほうが新しい
  }
  const diff = current.detector.diffFromSaved(stable.frame, lastSaved.frame);
  if (diff < current.slide.updateThreshold) {
    note(`skip diff=${diff.toFixed(4)} < ${current.slide.updateThreshold}`);
    return;
  }
  note(`update seq=${lastSaved.seq} diff=${diff.toFixed(4)}`);
  current.finalizing = true;
  try {
    const mime = current.slide.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
    // toBlob はこの時点の内容を写す。以後 rememberStable が描き直しても影響しない
    const blob = await new Promise<Blob | null>((resolve) => fullCanvas.toBlob(resolve, mime, current.slide.jpegQuality));
    if (!blob) return;
    const thumb = thumbnailOf(fullCanvas);
    const saved = await sendToOffscreen.slideUpdate({
      sessionId: current.sessionId,
      seq: lastSaved.seq,
      videoTime: stable.videoTime,
      t: stable.t,
      mime,
      dataBase64: await blobToBase64(blob),
    });
    current.detector.replaceSaved(stable.frame);
    current.lastSaved = { seq: saved.seq, frame: stable.frame, at: stable.at };
    current.stable = null;
    showToast(current, thumb);
  } finally {
    current.finalizing = false;
  }
}

// ---- ページ上のフィードバック（SPEC §15.3）: 保存した瞬間にサムネイルを動画の右下に出す

const TOAST_MS = 2500;
/** サムネイルの表示サイズと枠の余白。右下に置く座標の計算にも使うので定数にしておく */
const TOAST_THUMB_W = 112;
const TOAST_THUMB_H = 63;
const TOAST_PAD = 3;
/** 動画の右下からの余白 */
const TOAST_MARGIN = 8;

function thumbnailOf(source: CanvasImageSource): string {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 90;
  c.getContext('2d')?.drawImage(source, 0, 0, 160, 90);
  return c.toDataURL('image/jpeg', 0.7);
}

function showToast(current: Session, thumbnail: string): void {
  if (session !== current) return;
  const parent = document.fullscreenElement ?? document.body;
  if (!current.toastHost) {
    const host = document.createElement('div');
    host.setAttribute('data-lecscribe', 'toast');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; position: fixed; z-index: 2147483647; pointer-events: none; }
        /* サムネイルだけ。文字も色分けも出さない（動画の領域を取るため） */
        .box { padding: ${TOAST_PAD}px; border-radius: 8px; background: rgba(0, 0, 0, 0.4);
               box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); opacity: 0; transform: translateY(6px); transition: opacity 180ms ease, transform 180ms ease; }
        .box.show { opacity: 1; transform: translateY(0); }
        img { display: block; width: ${TOAST_THUMB_W}px; height: ${TOAST_THUMB_H}px; object-fit: cover; border-radius: 5px; background: #000; }
      </style>
      <div class="box"><img alt="" /></div>`;
    current.toastHost = host;
  }
  const host = current.toastHost;
  if (host.parentElement !== parent) parent.appendChild(host);
  const rect = current.video.getBoundingClientRect();
  const boxW = TOAST_THUMB_W + TOAST_PAD * 2;
  const boxH = TOAST_THUMB_H + TOAST_PAD * 2;
  host.style.left = `${Math.max(TOAST_MARGIN, Math.round(rect.right - TOAST_MARGIN - boxW))}px`;
  host.style.top = `${Math.max(TOAST_MARGIN, Math.round(rect.bottom - TOAST_MARGIN - boxH))}px`;
  const root = host.shadowRoot!;
  (root.querySelector('img') as HTMLImageElement).src = thumbnail;
  const box = root.querySelector('.box') as HTMLElement;
  window.clearTimeout(current.toastTimer);
  box.classList.remove('show');
  // 連続で出したときも一度消えてから出るよう、次のフレームで表示する
  requestAnimationFrame(() => box.classList.add('show'));
  current.toastTimer = window.setTimeout(() => box.classList.remove('show'), TOAST_MS);
}

type VerdictLog = { kind: 'sample' | 'flush' | 'stable' | 'final'; t: number; videoTime: number; state: Verdict['state']; save: boolean; diffPrev: number; diffSaved?: number; note?: string };
const VERDICT_LOG_MAX = 120;
function logVerdict(current: Session, kind: VerdictLog['kind'], v: Verdict, note?: string): void {
  current.verdicts.push({
    ...(note ? { note } : {}),
    kind,
    t: Math.round((Date.now() - current.recorderStartEpochMs)) / 1000,
    videoTime: Math.round(current.video.currentTime * 1000) / 1000,
    state: v.state,
    save: v.save,
    diffPrev: Math.round(v.diffPrev * 10000) / 10000,
    ...(v.diffSaved !== undefined ? { diffSaved: Math.round(v.diffSaved * 10000) / 10000 } : {}),
  });
  if (current.verdicts.length > VERDICT_LOG_MAX) current.verdicts.splice(0, current.verdicts.length - VERDICT_LOG_MAX);
}

/** 一時停止・終了の瞬間に安定待ちを打ち切る */
function flushDetection(current: Session): void {
  if (!canSample(current)) return;
  const frame = grayFrame(current);
  const wasWatching = current.lastVerdict === null || current.lastVerdict.state === 'watching';
  const verdict = current.detector.flush(frame, Date.now());
  current.lastVerdict = verdict;
  logVerdict(current, 'flush', verdict);
  if (wasWatching && !verdict.save) {
    // 止まった画面がそのスライドの最終状態。保存済みと違えば上書きする
    rememberStable(current, frame);
  }
  void finalizePrevious(current).catch(() => undefined);
  if (verdict.save) void grabFrame(current, 'change').catch(() => undefined);
}

/**
 * <video> の今のフレームを canvas に描いて画像にし、offscreen document に保存させる
 * （SPEC §8.3）。プレイヤー UI やカーソルは映らず、解像度は動画のネイティブ値。
 */
async function grabFrame(current: Session, reason: SlideReason): Promise<CaptureFrameResult> {
  const { video } = current;
  if (video.readyState < 2 || video.videoWidth === 0) throw new LecError('NO_VIDEO', '動画がまだ読み込まれていません。');
  if (current.taintFree === null) current.taintFree = checkTaint(video);
  if (current.taintFree === false) {
    throw new LecError('CAPTURE_FAILED', 'この動画は canvas に描けないため画像を取得できません（cross-origin）。');
  }
  // 前の保存（エンコードと送信）が終わるまで待ってから撮る。待っている間もサンプリングは続く。
  // 保存に時間がかかる環境で、次のサンプルが飛んで切り替わりや最終状態を見逃さないため
  const task = current.grabQueue.catch(() => undefined).then(() => grabFrameNow(current, reason));
  current.grabQueue = task;
  return task;
}

async function grabFrameNow(current: Session, reason: SlideReason): Promise<CaptureFrameResult> {
  const { video, slide } = current;
  if (session !== current) throw new LecError('NOT_CAPTURING', '動画を追跡していません。');
  {
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
    // 重複判定の基準にする縮小フレームは、フル解像度を描いたこの瞬間に取る。
    // エンコードと送信を待ってから取ると、その間に次のスライドへ進んでいた場合に
    // 「保存した画像 = 次のスライド」と誤認して、次の切り替わりを重複として捨ててしまう
    //（CI の遅いマシンで再現。保存に 1 秒かかると 4 秒目の切り替わりを見逃した）
    const savedFrame = grayFrame(current);

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
      ...(current.lastVerdict
        ? {
            trigger: {
              diffPrev: Math.round(current.lastVerdict.diffPrev * 10000) / 10000,
              ...(current.lastVerdict.diffSaved !== undefined ? { diffSaved: Math.round(current.lastVerdict.diffSaved * 10000) / 10000 } : {}),
              cells: current.lastVerdict.cells,
              stillFraction: Math.round(current.lastVerdict.stillFraction * 1000) / 1000,
            },
          }
        : {}),
    };
    // 手動や開始時の保存も「最後に保存した画像」として重複判定の基準にする
    current.detector.markSaved(savedFrame, capturedAt.getTime());
    current.lastSaved = { seq: saved.seq, frame: savedFrame, at: capturedAt.getTime() };
    // 保存中に取れた、より新しい静止フレームは残す（最終状態の上書きに使う）
    if (current.stable && current.stable.at <= capturedAt.getTime()) current.stable = null;
    showToast(current, thumbnailOf(canvas));
    return { slide: meta };
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
