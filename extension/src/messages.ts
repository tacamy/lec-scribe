import type { Config } from './config';
import type { ErrorInfo } from './errors';
import { LecError, toErrorInfo } from './errors';
import type { SessionState } from './state';

/** Written to session.json when a capture starts. */
export type SessionMeta = {
  sessionId: string;
  title?: string;
  url?: string;
  startedAt: string;
};

/**
 * All contexts share chrome.runtime.onMessage, so every message names its
 * target. Listeners ignore messages addressed to someone else.
 */
export type ToBackground =
  | { target: 'sw'; type: 'START'; tabId: number }
  | { target: 'sw'; type: 'STOP' }
  | { target: 'sw'; type: 'GET_STATE' }
  | { target: 'sw'; type: 'EXPORT'; sessionId: string }
  | { target: 'sw'; type: 'DISCARD'; sessionId: string }
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
  | { target: 'offscreen'; type: 'DISCARD'; sessionId: string };

export type AnyMessage = ToBackground | ToOffscreen;

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
};

export type ExportFile = { url: string; filename: string; bytes: number };
export type ExportResult = { files: ExportFile[] };

export type Reply<T> = ({ ok: true } & T) | { ok: false; error: ErrorInfo };

export function hasTarget<T extends AnyMessage['target']>(
  msg: unknown,
  target: T,
): msg is Extract<AnyMessage, { target: T }> {
  return !!msg && typeof msg === 'object' && (msg as { target?: unknown }).target === target;
}

async function send<T>(msg: AnyMessage): Promise<T> {
  let reply: Reply<T> | undefined;
  try {
    reply = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined;
  } catch (e) {
    throw new LecError('INTERNAL', `No receiver for ${msg.type}: ${toErrorInfo(e).message}`);
  }
  if (!reply) throw new LecError('INTERNAL', `Empty reply for ${msg.type}`);
  if (!reply.ok) throw new LecError(reply.error.code, reply.error.message);
  const { ok: _ok, ...rest } = reply;
  return rest as T;
}

type StateReply = { state: SessionState };

export const sendToBackground = {
  start: (tabId: number) => send<StateReply>({ target: 'sw', type: 'START', tabId }),
  stop: () => send<StateReply>({ target: 'sw', type: 'STOP' }),
  getState: () => send<StateReply>({ target: 'sw', type: 'GET_STATE' }),
  export: (sessionId: string) => send<StateReply>({ target: 'sw', type: 'EXPORT', sessionId }),
  discard: (sessionId: string) => send<StateReply>({ target: 'sw', type: 'DISCARD', sessionId }),
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
      (result) => sendResponse({ ok: true, ...(result ?? {}) }),
      (e: unknown) => sendResponse({ ok: false, error: toErrorInfo(e) }),
    );
    return true;
  };
}
