import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * セッションフォルダの配置（SPEC §14）。
 *
 *   <session>/notes.md      ユーザー向けのノート
 *   <session>/slides/       スライド画像（notes.md から相対参照）
 *   <session>/.lecscribe/   作業ファイル: 音声、文字起こし、timeline、session、pipeline など
 *
 * 作業ファイルは隠しフォルダに寄せ、Finder で開いたときにノートと画像だけが見えるようにする。
 */
export const WORK_DIR = '.lecscribe';
export const SLIDES_DIR = 'slides';
/**
 * slides/ に置く画像の名前。拡張が付ける slide_001.png / .jpg の形だけ。受け取るときと slides.json を読むときに確かめる
 * （slides.json の名前はそのままパスにして ffmpeg や Vision に渡すので、フォルダの外を指させない）
 */
export const SLIDE_FILE = /^slide_[0-9]{3,}\.(png|jpg)$/;
export const NOTES_FILE = 'notes.md';

/** 作業ファイルの名前（トップレベルから .lecscribe/ へ移す対象） */
export const WORK_FILES = [
  'audio.webm',
  'audio.wav',
  'slides.json',
  'timeline.json',
  'capture-status.json',
  'session.json',
  'pipeline.json',
  'transcript.json',
  'transcript.srt',
  'transcript.vtt',
  'transcript.txt',
  'lecture.md',
  'whisperkit',
] as const;

export function workPath(sessionDir: string, ...parts: string[]): string {
  return path.join(sessionDir, WORK_DIR, ...parts);
}

export async function ensureLayout(sessionDir: string): Promise<void> {
  // 録音・文字起こし・ノートが入るので、新しく作るセッションフォルダは本人だけが読めるようにする。
  // ホームは同じ Mac の別のアカウント（グループ staff）が通れる権限なので、既定の 755 だと中身を読まれる
  await mkdir(workPath(sessionDir), { recursive: true, mode: 0o700 });
  await mkdir(path.join(sessionDir, SLIDES_DIR), { recursive: true });
}

/**
 * 旧配置（作業ファイルがトップレベルにある）を新配置へ移す。
 * 新配置の同名ファイルがあればトップレベル側は残さず上書きしない（古い方を捨てる）。
 */
export async function migrateLayout(sessionDir: string): Promise<string[]> {
  const moved: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch {
    return moved;
  }
  const targets = new Set<string>(WORK_FILES);
  const toMove = entries.filter((name) => targets.has(name));
  if (toMove.length === 0) return moved;
  await ensureLayout(sessionDir);
  for (const name of toMove) {
    const from = path.join(sessionDir, name);
    const to = workPath(sessionDir, name);
    try {
      await stat(to);
      continue; // 新しい方が既にある
    } catch {
      // なければ移す
    }
    await rename(from, to);
    moved.push(name);
  }
  return moved;
}
