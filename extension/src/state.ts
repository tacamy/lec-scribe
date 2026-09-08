import type { ErrorInfo } from './errors';

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

export type WarningCode = 'PLAYBACK_RATE' | 'TAB_HIDDEN' | 'SERVER_UNREACHABLE' | 'DRM' | 'NAVIGATED';

export type SessionSummary = {
  sessionId: string;
  startedAt?: string;
  durationMs: number;
  audioBytes: number;
  endedBy: string;
  exported?: boolean;
};

export type ExportProgress = {
  sessionId: string;
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
  /** The session that just finished (COMPLETED / ERROR) or the previous one (IDLE). */
  lastSession?: SessionSummary;
  /** An export (chrome.downloads) in flight. */
  exporting?: ExportProgress;
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
