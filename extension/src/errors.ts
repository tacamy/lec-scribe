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
  | 'NOT_CAPTURING'
  | 'INTERNAL';

export type ErrorInfo = { code: ErrorCode; message: string };

export class LecError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LecError';
  }
}

export function toErrorInfo(e: unknown): ErrorInfo {
  if (e instanceof LecError) return { code: e.code, message: e.message };
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const { code, message } = e as { code: unknown; message: unknown };
    if (typeof code === 'string' && typeof message === 'string') {
      return { code: code as ErrorCode, message };
    }
  }
  if (e instanceof Error) return { code: 'INTERNAL', message: e.message };
  return { code: 'INTERNAL', message: String(e) };
}
