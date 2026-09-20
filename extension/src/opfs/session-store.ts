import type { SessionMeta } from '../messages';

/**
 * Layout inside the extension origin's OPFS (SPEC §11.1):
 *
 *   sessions/<sessionId>/session.json   SessionMeta + config + mimeType
 *   sessions/<sessionId>/audio.webm     appended by the writer worker
 *   sessions/<sessionId>/status.json    SessionStatus
 */
export const SESSIONS_DIR = 'sessions';
export const AUDIO_FILE = 'audio.webm';
export const SESSION_FILE = 'session.json';
export const STATUS_FILE = 'status.json';
export const SLIDES_DIR = 'slides';
export const SLIDES_FILE = 'slides.json';
export const TIMELINE_FILE = 'timeline.json';

/** slides.json の要素（SPEC §14） */
export type SlideMeta = {
  filename: string;
  seq: number;
  /** video.currentTime */
  videoTime: number;
  /** 録音開始からの秒 */
  t: number;
  capturedAt: string;
  width: number;
  height: number;
  source: 'direct';
  /** 何をきっかけに保存したか（initial / manual / change） */
  reason: string;
  bytes: number;
  /** どの数値で保存を決めたか（閾値を実データで詰めるための記録） */
  trigger?: { diffPrev: number; diffSaved?: number; cells: number; stillFraction: number };
  /** 切り替わる直前の状態（最終状態）で画像を上書きしたか */
  updated?: boolean;
  /** 上書きした画像の動画時刻・録音時刻 */
  finalVideoTime?: number;
  finalT?: number;
};

export type SessionStatus = {
  /** capturing → captured → (サーバー送信後) done。error は録音自体の失敗 */
  stage: 'capturing' | 'captured' | 'done' | 'error';
  audioBytes?: number;
  durationMs?: number;
  slideCount?: number;
  endedAt?: string;
  error?: string;
  /** サーバーに送った時刻と、サーバー側の出力先 */
  uploadedAt?: string;
  outputDir?: string;
  /** 文字起こしが終わった時刻 */
  transcribedAt?: string;
  /** 一覧で隠している（録音のデータは残す） */
  hidden?: boolean;
  /**
   * 文字起こしはできたが、ノートを整えられなかった（failed: 全体が文字起こしのまま / partial: 一部の節だけ /
   * stopped: ノート作成中に利用者が「中止」した。§11.3）。
   * Codex の利用上限に当たったときなど。「やり直す」で整えられたら消える（§13.5、2026-09-20）
   */
  notesProblem?: 'failed' | 'partial' | 'stopped';
  /** 整えられなかった理由（サーバーが返した文）。一覧の注意書きのツールチップに出す */
  notesError?: string;
};

export type StoredSession = {
  sessionId: string;
  meta?: SessionMeta;
  status?: SessionStatus;
  audioBytes: number;
  slideCount: number;
};

export async function sessionsRoot(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(SESSIONS_DIR, { create });
}

export async function sessionDir(sessionId: string, create = false): Promise<FileSystemDirectoryHandle> {
  const sessions = await sessionsRoot(create);
  return sessions.getDirectoryHandle(sessionId, { create });
}

export async function writeJson(dir: FileSystemDirectoryHandle, name: string, value: unknown): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(value, null, 2));
  await writable.close();
}

export async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<File | undefined> {
  try {
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch {
    return undefined;
  }
}

export async function readJson<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | undefined> {
  const file = await readFile(dir, name);
  if (!file) return undefined;
  try {
    return JSON.parse(await file.text()) as T;
  } catch {
    return undefined;
  }
}

/** ディレクトリ直下のファイルを名前順に返す */
export async function listFiles(dir: FileSystemDirectoryHandle): Promise<File[]> {
  const files: File[] = [];
  for await (const [, handle] of dir.entries()) {
    if (handle.kind === 'file') files.push(await (handle as FileSystemFileHandle).getFile());
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** 一覧で隠す・戻す（status.json の hidden）。録音のデータは残す */
export async function setSessionHidden(sessionId: string, hidden: boolean): Promise<void> {
  const dir = await sessionDir(sessionId);
  const status = (await readJson<SessionStatus>(dir, STATUS_FILE)) ?? { stage: 'captured' as const };
  await writeJson(dir, STATUS_FILE, { ...status, hidden });
}

/**
 * ノートを整えられなかった印（status.json の notesProblem / notesError）を、サーバーの今の状態に合わせて直す。
 * 印は処理の完了を見届けた offscreen が書くが、見届けられなかったとき（途中でブラウザを閉じた、など）は古いまま残る。
 * 一覧がサーバーに聞いた結果と食い違っていたら、ここで書き直す（§11.3）。problem が undefined なら印を消す
 */
export async function setNotesProblem(sessionId: string, problem: SessionStatus['notesProblem'], error?: string): Promise<void> {
  const dir = await sessionDir(sessionId);
  const status = (await readJson<SessionStatus>(dir, STATUS_FILE)) ?? { stage: 'captured' as const };
  const { notesProblem: _oldProblem, notesError: _oldError, ...rest } = status;
  await writeJson(dir, STATUS_FILE, { ...rest, ...(problem ? { notesProblem: problem, ...(error ? { notesError: error } : {}) } : {}) });
}

export async function deleteSession(sessionId: string): Promise<void> {
  const sessions = await sessionsRoot(false);
  await sessions.removeEntry(sessionId, { recursive: true });
}

/** Newest first. Safe to call from any extension page; the audio file may be locked while capturing. */
export async function listSessions(): Promise<StoredSession[]> {
  let sessions: FileSystemDirectoryHandle;
  try {
    sessions = await sessionsRoot(false);
  } catch {
    return [];
  }
  const out: StoredSession[] = [];
  for await (const [name, handle] of sessions.entries()) {
    if (handle.kind !== 'directory') continue;
    const dir = handle as FileSystemDirectoryHandle;
    const meta = await readJson<SessionMeta>(dir, SESSION_FILE);
    const status = await readJson<SessionStatus>(dir, STATUS_FILE);
    const audio = await readFile(dir, AUDIO_FILE);
    const slides = await readJson<SlideMeta[]>(dir, SLIDES_FILE);
    out.push({
      sessionId: name,
      meta,
      status,
      audioBytes: audio?.size ?? status?.audioBytes ?? 0,
      slideCount: Array.isArray(slides) ? slides.length : 0,
    });
  }
  return out.sort((a, b) => (a.sessionId < b.sessionId ? 1 : -1));
}
