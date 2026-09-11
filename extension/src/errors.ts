export type ErrorCode =
  | 'BUSY'
  | 'NO_TAB'
  | 'UNSUPPORTED_PAGE'
  | 'OFFSCREEN_FAILED'
  | 'CAPTURE_FAILED'
  | 'RECORD_FAILED'
  | 'STORAGE_FAILED'
  | 'NO_SESSION'
  | 'EXPORT_FAILED'
  | 'PROBE_FAILED'
  | 'NO_VIDEO'
  | 'SERVER_UNREACHABLE'
  | 'SERVER_REJECTED'
  | 'NOT_CAPTURING'
  | 'INTERNAL';

export type ErrorInfo = {
  code: ErrorCode;
  message: string;
  /** 時間を置けば通る失敗（サーバーが落ちている、5xx）。送信待ちを捨てずに送り直してよい（#8） */
  retryable?: boolean;
};

export class LecError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'LecError';
  }
}

export function toErrorInfo(e: unknown): ErrorInfo {
  if (e instanceof LecError) return { code: e.code, message: e.message, ...(e.retryable ? { retryable: true } : {}) };
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const { code, message, retryable } = e as { code: unknown; message: unknown; retryable?: unknown };
    if (typeof code === 'string' && typeof message === 'string') {
      return { code: code as ErrorCode, message, ...(retryable === true ? { retryable: true } : {}) };
    }
  }
  if (e instanceof Error) return { code: 'INTERNAL', message: e.message };
  return { code: 'INTERNAL', message: String(e) };
}
