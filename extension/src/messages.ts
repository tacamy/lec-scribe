import type { Config } from './config';
import type { ErrorInfo } from './errors';
import { LecError, toErrorInfo } from './errors';
import type { SessionState } from './state';

/**
 * All contexts share chrome.runtime.onMessage, so every message names its
 * target. Listeners ignore messages addressed to someone else.
 */
export type ToBackground =
  | { target: 'sw'; type: 'START'; tabId: number }
  | { target: 'sw'; type: 'STOP' }
  | { target: 'sw'; type: 'GET_STATE' }
  /** Sent by the offscreen document when the captured track ends on its own (tab closed, capture revoked). */
  | { target: 'sw'; type: 'CAPTURE_ENDED'; reason: string };

export type ToOffscreen =
  | { target: 'offscreen'; type: 'CAPTURE_START'; sessionId: string; streamId: string; config: Config }
  | { target: 'offscreen'; type: 'CAPTURE_STOP' }
  | { target: 'offscreen'; type: 'GET_STATS' };

export type AnyMessage = ToBackground | ToOffscreen;

export type CaptureStartResult = {
  /** Date.now() taken right after capture started; the origin of the recording clock (SPEC §10). */
  recorderStartEpochMs: number;
  sampleRate: number;
  channelCount: number;
};

export type CaptureStats = {
  capturing: boolean;
  /** RMS of the captured audio in the last analysis window, 0..1. */
  audioLevel: number;
  passthrough: boolean;
  elapsedMs: number;
};

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

export const sendToBackground = {
  start: (tabId: number) => send<{ state: SessionState }>({ target: 'sw', type: 'START', tabId }),
  stop: () => send<{ state: SessionState }>({ target: 'sw', type: 'STOP' }),
  getState: () => send<{ state: SessionState }>({ target: 'sw', type: 'GET_STATE' }),
  captureEnded: (reason: string) => send<object>({ target: 'sw', type: 'CAPTURE_ENDED', reason }),
};

export const sendToOffscreen = {
  captureStart: (sessionId: string, streamId: string, config: Config) =>
    send<CaptureStartResult>({ target: 'offscreen', type: 'CAPTURE_START', sessionId, streamId, config }),
  captureStop: () => send<object>({ target: 'offscreen', type: 'CAPTURE_STOP' }),
  getStats: () => send<CaptureStats>({ target: 'offscreen', type: 'GET_STATS' }),
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
