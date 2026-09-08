import type { Config } from '../../src/config';
import { LecError, toErrorInfo } from '../../src/errors';
import {
  hasTarget,
  replyWith,
  sendToBackground,
  type CaptureStartResult,
  type CaptureStats,
  type CaptureStopResult,
  type ExportFile,
  type ExportResult,
  type SessionMeta,
  type SlideSaveResult,
  type ToOffscreen,
} from '../../src/messages';
import {
  AUDIO_FILE,
  SESSION_FILE,
  SESSIONS_DIR,
  SLIDES_DIR,
  SLIDES_FILE,
  STATUS_FILE,
  TIMELINE_FILE,
  deleteSession,
  listFiles,
  readFile,
  sessionDir,
  writeJson,
  type SessionStatus,
  type SlideMeta,
} from '../../src/opfs/session-store';
import type { TimelineEvent } from '../../src/timeline';
import type { WriterRequest, WriterResponse } from '../../src/opfs/writer.worker';

/**
 * Offscreen document: the only extension context with a DOM, so it owns the
 * MediaStream. It captures the tab audio, plays it back through the default
 * output device (Phase 1) and records it chunk by chunk into OPFS (Phase 2).
 */
const RECORDER_MIME = 'audio/webm;codecs=opus';
const LEVEL_SAMPLE_MS = 100;
const SILENCE_AFTER_MS = 1000;
const NOISE_FLOOR = 0.001;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Serialises chunk writes to the OPFS file through the writer worker. */
class AudioFileWriter {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (bytes: number) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  bytes = 0;

  constructor() {
    this.worker = new Worker(new URL('../../src/opfs/writer.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WriterResponse>) => {
      const waiter = this.pending.get(e.data.id);
      if (!waiter) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) waiter.resolve(e.data.bytes);
      else waiter.reject(new LecError('STORAGE_FAILED', e.data.error));
    };
    this.worker.onerror = (e) => {
      for (const waiter of this.pending.values()) waiter.reject(new LecError('STORAGE_FAILED', e.message));
      this.pending.clear();
    };
  }

  private request(req: DistributiveOmit<WriterRequest, 'id'>, transfer: Transferable[] = []): Promise<number> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id } as WriterRequest, transfer);
    });
  }

  async open(path: string[]): Promise<number> {
    this.bytes = await this.request({ type: 'OPEN', path });
    return this.bytes;
  }

  /** Chunks are appended strictly in arrival order, even though reading a Blob is asynchronous. */
  append(chunk: Blob, onError: (e: Error) => void): void {
    this.queue = this.queue
      .then(async () => {
        const buffer = await chunk.arrayBuffer();
        this.bytes = await this.request({ type: 'APPEND', buffer }, [buffer]);
      })
      .catch(onError);
  }

  async close(): Promise<number> {
    await this.queue;
    try {
      this.bytes = await this.request({ type: 'CLOSE' });
    } finally {
      this.worker.terminate();
    }
    return this.bytes;
  }
}

type Capture = {
  sessionId: string;
  stream: MediaStream;
  startedEpochMs: number;
  passthrough: boolean;
  context: AudioContext;
  analyser: AnalyserNode;
  levelBuffer: Float32Array<ArrayBuffer>;
  levelTimer: number;
  peakLevel: number;
  lastLoudAt: number;
  recorder: MediaRecorder;
  writer: AudioFileWriter;
  dir: FileSystemDirectoryHandle;
  slidesDir: FileSystemDirectoryHandle | null;
  slides: SlideMeta[];
  timeline: TimelineEvent[];
  /** timeline.json の書き込みを直列にする（古い内容で上書きしないため） */
  timelineWrite: Promise<void>;
  stopping: boolean;
};

let capture: Capture | null = null;
const exportUrls = new Set<string>();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!hasTarget(msg, 'offscreen')) return false;
  return replyWith(handleMessage)(msg, sender, sendResponse);
});

async function handleMessage(msg: ToOffscreen): Promise<object | void> {
  switch (msg.type) {
    case 'CAPTURE_START':
      return startCapture(msg.streamId, msg.config, msg.meta);
    case 'CAPTURE_STOP':
      return stopCapture();
    case 'GET_STATS':
      return getStats();
    case 'EXPORT':
      return exportSession(msg.sessionId);
    case 'REVOKE':
      return revokeUrls(msg.urls);
    case 'DISCARD':
      return discardSession(msg.sessionId);
    case 'SLIDE':
      return saveSlide(msg);
    case 'TIMELINE_EVENT':
      return recordTimelineEvent(msg.sessionId, msg.event);
  }
}

/** 再生イベントを timeline.json に追記する（SPEC §10.1） */
async function recordTimelineEvent(sessionId: string, event: TimelineEvent): Promise<void> {
  const current = capture;
  if (!current || current.sessionId !== sessionId) {
    throw new LecError('NOT_CAPTURING', 'このセッションはキャプチャ中ではありません。');
  }
  current.timeline.push(event);
  const snapshot = current.timeline.slice();
  current.timelineWrite = current.timelineWrite.then(() => writeJson(current.dir, TIMELINE_FILE, snapshot)).catch(() => undefined);
  await current.timelineWrite;
}

async function startCapture(streamId: string, config: Config, meta: SessionMeta): Promise<CaptureStartResult> {
  if (capture) throw new LecError('BUSY', 'すでにキャプチャ中です。');

  // Non-standard constraints understood by Chrome for tab capture; the
  // stream id comes from chrome.tabCapture.getMediaStreamId in the worker.
  const constraints = {
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    video: false,
  } as unknown as MediaStreamConstraints;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    throw new LecError('CAPTURE_FAILED', `タブ音声を取得できません: ${toErrorInfo(e).message}`);
  }
  return startFromStream(stream, config, meta);
}

/** Everything after the stream exists. Also used by scripts/smoke-extension.mjs with a synthetic stream. */
async function startFromStream(stream: MediaStream, config: Config, meta: SessionMeta): Promise<CaptureStartResult> {
  if (capture) throw new LecError('BUSY', 'すでにキャプチャ中です。');
  const [track] = stream.getAudioTracks();
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new LecError('CAPTURE_FAILED', '取得したストリームに音声トラックがありません。');
  }

  // Capturing a tab silences it locally; route the audio back to the default
  // output device (SPEC D-02). The analyser only feeds the popup level meter.
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  if (config.audio.passthrough) source.connect(context.destination);
  await context.resume();

  let dir: FileSystemDirectoryHandle;
  let writer: AudioFileWriter | undefined;
  let recorder: MediaRecorder;
  try {
    dir = await sessionDir(meta.sessionId, true);
    const mimeType = MediaRecorder.isTypeSupported(RECORDER_MIME) ? RECORDER_MIME : '';
    await writeJson(dir, SESSION_FILE, { ...meta, config, mimeType: mimeType || 'default' });
    await writeJson(dir, STATUS_FILE, { stage: 'capturing' } satisfies SessionStatus);

    writer = new AudioFileWriter();
    await writer.open([SESSIONS_DIR, meta.sessionId, AUDIO_FILE]);

    recorder = new MediaRecorder(new MediaStream([track]), {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: config.audio.bitsPerSecond,
    });
  } catch (e) {
    await writer?.close().catch(() => undefined);
    stream.getTracks().forEach((t) => t.stop());
    await context.close().catch(() => undefined);
    const info = toErrorInfo(e);
    throw new LecError(info.code === 'INTERNAL' ? 'STORAGE_FAILED' : info.code, `録音を準備できません: ${info.message}`);
  }

  const current: Capture = {
    sessionId: meta.sessionId,
    stream,
    startedEpochMs: 0,
    passthrough: config.audio.passthrough,
    context,
    analyser,
    levelBuffer: new Float32Array(analyser.fftSize),
    levelTimer: 0,
    peakLevel: 0,
    lastLoudAt: 0,
    recorder,
    writer,
    dir,
    slidesDir: null,
    slides: [],
    timeline: [],
    timelineWrite: Promise.resolve(),
    stopping: false,
  };
  capture = current;

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) current.writer.append(e.data, (err) => void fail(current, 'RECORD_FAILED', err.message));
  };
  recorder.onerror = (e) => {
    const err = (e as ErrorEvent).error as Error | undefined;
    void fail(current, 'RECORD_FAILED', err?.message ?? 'MediaRecorder error');
  };
  track.addEventListener('ended', () => void onTrackEnded(current, 'track ended'));

  recorder.start(config.audio.timesliceMs);
  current.startedEpochMs = Date.now();
  current.lastLoudAt = current.startedEpochMs;
  current.levelTimer = window.setInterval(() => sampleLevel(current), LEVEL_SAMPLE_MS);

  const settings = track.getSettings();
  return {
    recorderStartEpochMs: current.startedEpochMs,
    sampleRate: settings.sampleRate ?? context.sampleRate,
    channelCount: settings.channelCount ?? 0,
    mimeType: recorder.mimeType,
  };
}

function sampleLevel(current: Capture): void {
  current.analyser.getFloatTimeDomainData(current.levelBuffer);
  let sum = 0;
  for (const v of current.levelBuffer) sum += v * v;
  const rms = Math.sqrt(sum / current.levelBuffer.length);
  current.peakLevel = Math.max(current.peakLevel, rms);
  if (rms > NOISE_FLOOR) current.lastLoudAt = Date.now();
}

async function stopCapture(): Promise<CaptureStopResult> {
  const current = capture;
  if (!current) return { audioBytes: 0, durationMs: 0 };
  return finishCapture(current, undefined);
}

async function finishCapture(current: Capture, error: string | undefined): Promise<CaptureStopResult> {
  if (current.stopping) throw new LecError('BUSY', '停止処理中です。');
  current.stopping = true;
  capture = null;
  window.clearInterval(current.levelTimer);

  if (current.recorder.state !== 'inactive') {
    // The final dataavailable event fires before stop.
    await new Promise<void>((resolve) => {
      current.recorder.addEventListener('stop', () => resolve(), { once: true });
      current.recorder.stop();
    });
  }
  let audioBytes = current.writer.bytes;
  let storageError: string | undefined;
  try {
    audioBytes = await current.writer.close();
  } catch (e) {
    storageError = toErrorInfo(e).message;
  }
  await current.timelineWrite;
  const durationMs = Date.now() - current.startedEpochMs;

  current.stream.getTracks().forEach((t) => t.stop());
  await current.context.close().catch(() => undefined);

  const failure = error ?? storageError;
  const status: SessionStatus = {
    stage: failure ? 'error' : 'captured',
    audioBytes,
    durationMs,
    slideCount: current.slides.length,
    endedAt: new Date().toISOString(),
    ...(failure ? { error: failure } : {}),
  };
  await writeJson(current.dir, STATUS_FILE, status).catch(() => undefined);
  if (storageError && !error) throw new LecError('STORAGE_FAILED', `録音の保存に失敗しました: ${storageError}`);
  return { audioBytes, durationMs };
}

async function fail(current: Capture, code: 'RECORD_FAILED' | 'STORAGE_FAILED', message: string): Promise<void> {
  if (capture !== current || current.stopping) return;
  await finishCapture(current, message).catch(() => undefined);
  try {
    await sendToBackground.captureError({ code, message });
  } catch {
    // The worker will reconcile on its next wake-up.
  }
}

async function onTrackEnded(current: Capture, reason: string): Promise<void> {
  if (capture !== current || current.stopping) return;
  await finishCapture(current, undefined).catch(() => undefined);
  try {
    await sendToBackground.captureEnded(reason);
  } catch {
    // The worker will reconcile on its next wake-up.
  }
}

function getStats(): CaptureStats {
  const current = capture;
  if (!current) {
    return {
      capturing: false,
      audioLevel: 0,
      silent: true,
      passthrough: false,
      elapsedMs: 0,
      audioBytes: 0,
      slideCount: 0,
      lastSlideVideoTime: null,
    };
  }
  const now = Date.now();
  const level = Math.min(1, current.peakLevel);
  current.peakLevel = 0;
  return {
    capturing: true,
    audioLevel: level,
    silent: now - current.lastLoudAt > SILENCE_AFTER_MS,
    passthrough: current.passthrough,
    elapsedMs: now - current.startedEpochMs,
    audioBytes: current.writer.bytes,
    slideCount: current.slides.length,
    lastSlideVideoTime: current.slides[current.slides.length - 1]?.videoTime ?? null,
  };
}

/** content script から届いたフレームを slides/ に書き、slides.json を更新する */
async function saveSlide(msg: Extract<ToOffscreen, { type: 'SLIDE' }>): Promise<SlideSaveResult> {
  const current = capture;
  if (!current || current.sessionId !== msg.sessionId) {
    throw new LecError('NOT_CAPTURING', 'このセッションはキャプチャ中ではありません。');
  }
  const seq = current.slides.length + 1;
  const filename = `slide_${String(seq).padStart(3, '0')}.${msg.mime === 'image/jpeg' ? 'jpg' : 'png'}`;
  const bytes = Uint8Array.from(atob(msg.dataBase64), (c) => c.charCodeAt(0));
  try {
    current.slidesDir ??= await current.dir.getDirectoryHandle(SLIDES_DIR, { create: true });
    const file = await current.slidesDir.getFileHandle(filename, { create: true });
    const writable = await file.createWritable();
    await writable.write(bytes);
    await writable.close();
    current.slides.push({
      filename,
      seq,
      videoTime: msg.videoTime,
      t: msg.t,
      capturedAt: msg.capturedAt,
      width: msg.width,
      height: msg.height,
      source: 'direct',
      reason: msg.reason,
      bytes: bytes.byteLength,
    });
    await writeJson(current.dir, SLIDES_FILE, current.slides);
  } catch (e) {
    throw new LecError('STORAGE_FAILED', `スライド画像を保存できません: ${toErrorInfo(e).message}`);
  }
  return { seq, filename, bytes: bytes.byteLength };
}

/** Creates blob: URLs for the session files; the worker downloads them (SPEC §11.2). */
async function exportSession(sessionId: string): Promise<ExportResult> {
  if (capture?.sessionId === sessionId) throw new LecError('BUSY', 'キャプチャ中のセッションはエクスポートできません。');
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await sessionDir(sessionId);
  } catch {
    throw new LecError('NO_SESSION', `セッション ${sessionId} が見つかりません。`);
  }
  const files: ExportFile[] = [];
  const add = (file: File, relative: string) => {
    const url = URL.createObjectURL(file);
    exportUrls.add(url);
    files.push({ url, filename: `LecScribe/${sessionId}/${relative}`, bytes: file.size });
  };
  for (const name of [AUDIO_FILE, SESSION_FILE, STATUS_FILE, SLIDES_FILE, TIMELINE_FILE]) {
    const file = await readFile(dir, name);
    if (file) add(file, name);
  }
  try {
    const slidesDir = await dir.getDirectoryHandle(SLIDES_DIR);
    for (const file of await listFiles(slidesDir)) add(file, `${SLIDES_DIR}/${file.name}`);
  } catch {
    // スライドなし
  }
  if (!files.some((f) => f.filename.endsWith(AUDIO_FILE))) {
    revokeUrls(files.map((f) => f.url));
    throw new LecError('NO_SESSION', `セッション ${sessionId} に音声ファイルがありません。`);
  }
  return { files };
}

function revokeUrls(urls: string[]): void {
  for (const url of urls) {
    if (exportUrls.delete(url)) URL.revokeObjectURL(url);
  }
}

async function discardSession(sessionId: string): Promise<void> {
  if (capture?.sessionId === sessionId) throw new LecError('BUSY', 'キャプチャ中のセッションは削除できません。');
  try {
    await deleteSession(sessionId);
  } catch (e) {
    throw new LecError('STORAGE_FAILED', `セッションを削除できません: ${toErrorInfo(e).message}`);
  }
}

// Test surface used by scripts/smoke-extension.mjs, which loads this page in a
// tab and feeds it a synthetic stream because tabCapture cannot run headless.
declare global {
  interface Window {
    __lecscribe?: {
      startFromStream: typeof startFromStream;
      stop: typeof stopCapture;
      stats: typeof getStats;
      export: typeof exportSession;
      revoke: typeof revokeUrls;
      discard: typeof discardSession;
    };
  }
}
window.__lecscribe = {
  startFromStream,
  stop: stopCapture,
  stats: getStats,
  export: exportSession,
  revoke: revokeUrls,
  discard: discardSession,
};
