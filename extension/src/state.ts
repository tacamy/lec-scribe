import type { ErrorInfo } from './errors';
import type { VideoStatus } from './probe';

/** See docs/SPEC.md §6.5. */
export type CaptureState =
  | 'IDLE'
  | 'STARTING'
  | 'CAPTURING'
  | 'STOPPING'
  | 'UPLOADING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'ERROR';

export type WarningCode =
  | 'PLAYBACK_RATE'
  | 'TAB_HIDDEN'
  | 'NAVIGATED'
  | 'NO_VIDEO'
  | 'CROSS_ORIGIN_IFRAME'
  | 'DRM'
  | 'TAINTED'
  | 'SERVER_UNREACHABLE';

export type SessionSummary = {
  sessionId: string;
  startedAt?: string;
  durationMs: number;
  audioBytes: number;
  endedBy: string;
  exported?: boolean;
  /** サーバーで文字起こしまで終わった出力先 */
  outputDir?: string;
};

/** サーバーへの送信と文字起こしの進捗（UPLOADING / PROCESSING の間） */
export type ProcessingProgress = {
  sessionId: string;
  stage: 'uploading' | 'queued' | 'converting' | 'transcribing' | 'merging' | 'polishing' | 'done' | 'error';
  startedAt: number;
  /** 送信中のみ 0〜100 */
  percent?: number;
  outputDir?: string;
  error?: string;
};

export type ExportProgress = {
  sessionId: string;
  /** Date.now() at the time the downloads were created */
  startedAt: number;
  downloadIds: number[];
  /** Blob URLs created by the offscreen document; revoked once every download settles. */
  urls: string[];
};

export type SessionState = {
  state: CaptureState;
  sessionId?: string;
  tabId?: number;
  title?: string;
  /** ISO 8601. Set once the offscreen document has started capturing. */
  startedAt?: string;
  warnings: WarningCode[];
  error?: ErrorInfo;
  /** スライド用フレームの取得元。'direct' = content script が <video> を直接読む、'none' = 音声のみ */
  frameSource?: 'direct' | 'none';
  /** 検知用 content script を注入した frame */
  frameId?: number;
  /** 検知用 content script から届いた直近の動画の状態 */
  video?: VideoStatus;
  /** The session that just finished (COMPLETED / ERROR) or the previous one (IDLE). */
  lastSession?: SessionSummary;
  /** An export (chrome.downloads) in flight. */
  exporting?: ExportProgress;
  /** サーバー送信〜文字起こしの進行状況 */
  processing?: ProcessingProgress;
  /** 別のセッションを処理中に Stop した録音。処理が終わり次第、順に送る */
  pendingUploads?: string[];
  /** 送信をやり直した回数（セッションごと）。間隔をだんだん空け、諦める判断に使う（#8） */
  uploadAttempts?: Record<string, number>;
};

export const INITIAL_STATE: SessionState = { state: 'IDLE', warnings: [] };

export function isActive(state: SessionState): boolean {
  return state.state === 'STARTING' || state.state === 'CAPTURING' || state.state === 'STOPPING';
}

const KEY = 'session';

/** Live state lives in chrome.storage.session: it survives service-worker restarts but not browser restarts. */
export async function readState(): Promise<SessionState> {
  const stored = await chrome.storage.session.get(KEY);
  return (stored[KEY] as SessionState | undefined) ?? INITIAL_STATE;
}

export async function writeState(state: SessionState): Promise<void> {
  await chrome.storage.session.set({ [KEY]: state });
}

export function onStateChange(listener: (state: SessionState) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'session' || !changes[KEY]) return;
    listener((changes[KEY].newValue as SessionState | undefined) ?? INITIAL_STATE);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
