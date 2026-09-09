import type { Config } from './config';
import type { ErrorInfo } from './errors';
import { LecError, toErrorInfo } from './errors';
import type { SlideMeta } from './opfs/session-store';
import type { VideoCandidate, VideoStatus } from './probe';
import type { ProcessingProgress, SessionState } from './state';
import type { TimelineEvent } from './timeline';

/** サーバーへの接続情報（Config['server'] と同じ） */
export type ServerTarget = { port: number; token: string; paired: boolean };

/** サーバーの GET /sessions/:id/status と同じ形 */
export type ServerStatus = {
  stage: ProcessingProgress['stage'] | 'uploaded';
  outputDir?: string;
  error?: string;
  result?: { segments: number; durationSec: number; hasTimeline: boolean };
};

/** Written to session.json when a capture starts. */
export type SessionMeta = {
  sessionId: string;
  title?: string;
  url?: string;
  startedAt: string;
};

/** Start 前に走らせる probe の要約（SPEC §6.3 手順 3） */
export type ProbeSummary = {
  chosen?: VideoCandidate;
  videoCount: number;
  frames: number;
  crossOriginIframes: string[];
};

/**
 * All contexts share chrome.runtime.onMessage, so every message names its
 * target. Listeners ignore messages addressed to someone else.
 */
export type ToBackground =
  | { target: 'sw'; type: 'START'; tabId: number }
  | { target: 'sw'; type: 'STOP' }
  | { target: 'sw'; type: 'GET_STATE' }
  /** ローカルサーバーと接続する（サーバーが Mac のダイアログで承認を求め、拡張専用トークンを返す） */
  | { target: 'sw'; type: 'PAIR' }
  | { target: 'sw'; type: 'EXPORT'; sessionId: string }
  | { target: 'sw'; type: 'DISCARD'; sessionId: string }
  /** 指定タブの <video> を調べる（Start 前の表示用） */
  | { target: 'sw'; type: 'PROBE'; tabId: number }
  /** 検知用 content script からの動画の状態 */
  | { target: 'sw'; type: 'DETECT_STATUS'; sessionId: string; status: VideoStatus }
  /** パネルの「スクショを保存」。今のフレームを 1 枚保存する */
  | { target: 'sw'; type: 'CAPTURE_FRAME' }
  /** セッションをサーバーへ送って文字起こしする（Stop 後は自動、失敗時はパネルから再送） */
  | { target: 'sw'; type: 'UPLOAD'; sessionId: string }
  /** offscreen が送信・処理の進捗を知らせる */
  | { target: 'sw'; type: 'PROCESS_STATUS'; sessionId: string; progress: Omit<ProcessingProgress, 'sessionId' | 'startedAt'> }
  /** Sent by the offscreen document when the captured track ends on its own (tab closed, capture revoked). */
  | { target: 'sw'; type: 'CAPTURE_ENDED'; reason: string }
  /** Sent by the offscreen document when recording fails mid-session. */
  | { target: 'sw'; type: 'CAPTURE_ERROR'; error: ErrorInfo };

export type ToOffscreen =
  | { target: 'offscreen'; type: 'CAPTURE_START'; streamId: string; config: Config; meta: SessionMeta }
  | { target: 'offscreen'; type: 'CAPTURE_STOP' }
  | { target: 'offscreen'; type: 'GET_STATS' }
  | { target: 'offscreen'; type: 'EXPORT'; sessionId: string }
  | { target: 'offscreen'; type: 'REVOKE'; urls: string[] }
  | { target: 'offscreen'; type: 'DISCARD'; sessionId: string }
  /** 検知用 content script が取得したフレーム（SPEC §6.6 SLIDE）。offscreen が OPFS に保存する */
  | {
      target: 'offscreen';
      type: 'SLIDE';
      sessionId: string;
      videoTime: number;
      t: number;
      capturedAt: string;
      width: number;
      height: number;
      mime: string;
      dataBase64: string;
      reason: SlideReason;
    }
  /** 検知用 content script からの再生イベント（SPEC §10）。offscreen が timeline.json に書く */
  | { target: 'offscreen'; type: 'TIMELINE_EVENT'; sessionId: string; event: TimelineEvent }
  /** OPFS のセッションをサーバーへ送り、finalize まで行う。以後は status を polling して PROCESS_STATUS を送る */
  | { target: 'offscreen'; type: 'UPLOAD'; sessionId: string; server: ServerTarget }
  /** 送信中なら中断し、polling をやめる（サーバー側の中止は service worker が頼む） */
  | { target: 'offscreen'; type: 'CANCEL_UPLOAD'; sessionId: string };

export type UploadResult = { outputDir: string };

export type SlideReason = 'initial' | 'manual' | 'change';

/** service worker → 検知用 content script（chrome.tabs.sendMessage で frame を指定して送る） */
export type ToContent =
  | {
      target: 'content';
      type: 'DETECT_START';
      sessionId: string;
      selector: string;
      index: number;
      recorderStartEpochMs: number;
      slide: Config['slide'];
      detect: Config['detect'];
    }
  | { target: 'content'; type: 'DETECT_STOP' }
  | { target: 'content'; type: 'CAPTURE_FRAME'; reason: SlideReason };

export type AnyMessage = ToBackground | ToOffscreen | ToContent;

export type CaptureStartResult = {
  /** Date.now() taken right after the recorder started; the origin of the recording clock (SPEC §10). */
  recorderStartEpochMs: number;
  sampleRate: number;
  channelCount: number;
  mimeType: string;
};

export type CaptureStopResult = {
  audioBytes: number;
  durationMs: number;
};

export type CaptureStats = {
  capturing: boolean;
  /** Peak RMS of the captured audio since the previous poll, 0..1. */
  audioLevel: number;
  /** True when nothing above the noise floor was captured for about a second. */
  silent: boolean;
  passthrough: boolean;
  elapsedMs: number;
  audioBytes: number;
  slideCount: number;
  lastSlideVideoTime: number | null;
};

export type ExportFile = { url: string; filename: string; bytes: number };
export type ExportResult = { files: ExportFile[] };
export type DetectStartResult = { status: VideoStatus };
export type SlideSaveResult = { seq: number; filename: string; bytes: number };
export type CaptureFrameResult = { slide: SlideMeta };

export type Reply<T> = ({ ok: true } & T) | { ok: false; error: ErrorInfo };

export function hasTarget<T extends AnyMessage['target']>(
  msg: unknown,
  target: T,
): msg is Extract<AnyMessage, { target: T }> {
  return !!msg && typeof msg === 'object' && (msg as { target?: unknown }).target === target;
}

function unwrap<T>(reply: Reply<T> | undefined, type: string): T {
  if (!reply) throw new LecError('INTERNAL', `Empty reply for ${type}`);
  if (!reply.ok) throw new LecError(reply.error.code, reply.error.message);
  const { ok: _ok, ...rest } = reply;
  return rest as T;
}

async function send<T>(msg: ToBackground | ToOffscreen): Promise<T> {
  let reply: Reply<T> | undefined;
  try {
    reply = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined;
  } catch (e) {
    throw new LecError('INTERNAL', `No receiver for ${msg.type}: ${toErrorInfo(e).message}`);
  }
  return unwrap(reply, msg.type);
}

async function sendToFrame<T>(tabId: number, frameId: number, msg: ToContent): Promise<T> {
  let reply: Reply<T> | undefined;
  try {
    reply = (await chrome.tabs.sendMessage(tabId, msg, { frameId })) as Reply<T> | undefined;
  } catch (e) {
    throw new LecError('INTERNAL', `No content script for ${msg.type}: ${toErrorInfo(e).message}`);
  }
  return unwrap(reply, msg.type);
}

type StateReply = { state: SessionState };

export const sendToBackground = {
  start: (tabId: number) => send<StateReply>({ target: 'sw', type: 'START', tabId }),
  stop: () => send<StateReply>({ target: 'sw', type: 'STOP' }),
  getState: () => send<StateReply>({ target: 'sw', type: 'GET_STATE' }),
  pair: () => send<StateReply & { paired: boolean }>({ target: 'sw', type: 'PAIR' }),
  export: (sessionId: string) => send<StateReply>({ target: 'sw', type: 'EXPORT', sessionId }),
  discard: (sessionId: string) => send<StateReply>({ target: 'sw', type: 'DISCARD', sessionId }),
  probe: (tabId: number) => send<{ probe: ProbeSummary }>({ target: 'sw', type: 'PROBE', tabId }),
  detectStatus: (sessionId: string, status: VideoStatus) =>
    send<object>({ target: 'sw', type: 'DETECT_STATUS', sessionId, status }),
  captureFrame: () => send<CaptureFrameResult>({ target: 'sw', type: 'CAPTURE_FRAME' }),
  upload: (sessionId: string) => send<StateReply>({ target: 'sw', type: 'UPLOAD', sessionId }),
  processStatus: (sessionId: string, progress: Omit<ProcessingProgress, 'sessionId' | 'startedAt'>) =>
    send<object>({ target: 'sw', type: 'PROCESS_STATUS', sessionId, progress }),
  captureEnded: (reason: string) => send<object>({ target: 'sw', type: 'CAPTURE_ENDED', reason }),
  captureError: (error: ErrorInfo) => send<object>({ target: 'sw', type: 'CAPTURE_ERROR', error }),
};

export const sendToOffscreen = {
  captureStart: (streamId: string, config: Config, meta: SessionMeta) =>
    send<CaptureStartResult>({ target: 'offscreen', type: 'CAPTURE_START', streamId, config, meta }),
  captureStop: () => send<CaptureStopResult>({ target: 'offscreen', type: 'CAPTURE_STOP' }),
  getStats: () => send<CaptureStats>({ target: 'offscreen', type: 'GET_STATS' }),
  export: (sessionId: string) => send<ExportResult>({ target: 'offscreen', type: 'EXPORT', sessionId }),
  revoke: (urls: string[]) => send<object>({ target: 'offscreen', type: 'REVOKE', urls }),
  discard: (sessionId: string) => send<object>({ target: 'offscreen', type: 'DISCARD', sessionId }),
  slide: (params: Omit<Extract<ToOffscreen, { type: 'SLIDE' }>, 'target' | 'type'>) =>
    send<SlideSaveResult>({ target: 'offscreen', type: 'SLIDE', ...params }),
  timelineEvent: (sessionId: string, event: TimelineEvent) =>
    send<object>({ target: 'offscreen', type: 'TIMELINE_EVENT', sessionId, event }),
  upload: (sessionId: string, server: ServerTarget) =>
    send<UploadResult>({ target: 'offscreen', type: 'UPLOAD', sessionId, server }),
  cancelUpload: (sessionId: string) => send<{ cancelled: boolean }>({ target: 'offscreen', type: 'CANCEL_UPLOAD', sessionId }),
};

export const sendToContent = {
  detectStart: (
    tabId: number,
    frameId: number,
    params: {
      sessionId: string;
      selector: string;
      index: number;
      recorderStartEpochMs: number;
      slide: Config['slide'];
      detect: Config['detect'];
    },
  ) => sendToFrame<DetectStartResult>(tabId, frameId, { target: 'content', type: 'DETECT_START', ...params }),
  detectStop: (tabId: number, frameId: number) =>
    sendToFrame<object>(tabId, frameId, { target: 'content', type: 'DETECT_STOP' }),
  captureFrame: (tabId: number, frameId: number, reason: SlideReason) =>
    sendToFrame<CaptureFrameResult>(tabId, frameId, { target: 'content', type: 'CAPTURE_FRAME', reason }),
};

/**
 * Wrap an async handler so it can be used with chrome.runtime.onMessage:
 * replies with { ok: true, ...result } or { ok: false, error } and returns
 * true to keep the channel open.
 */
export function replyWith<M>(
  handler: (msg: M, sender: chrome.runtime.MessageSender) => Promise<object | void>,
) {
  return (msg: M, sender: chrome.runtime.MessageSender, sendResponse: (r: Reply<object>) => void) => {
    handler(msg, sender).then(
      (result) => sendResponse({ ok: true, ...result }),
      (e: unknown) => sendResponse({ ok: false, error: toErrorInfo(e) }),
    );
    return true;
  };
}
