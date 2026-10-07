import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * セッションフォルダの配置（SPEC §14）。
 *
 *   <session>/notes.md          ユーザー向けのノート
 *   <session>/slides/           notes.md に載せた画像（相対参照）
 *   <session>/.lecscribe/       作業ファイル: 音声、文字起こし、timeline、session、pipeline など
 *   <session>/.lecscribe/unused/  notes.md に載せなかった画像（処理の間は slides/ に戻す）
 *
 * 作業ファイルは隠しフォルダに寄せ、Finder で開いたときにノートと画像だけが見えるようにする。
 */
export const WORK_DIR = '.lecscribe';
export const SLIDES_DIR = 'slides';
export const UNUSED_DIR = 'unused';
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

/** フォルダの中の、拡張が付けた名前（slide_001.png の形）の画像だけ。フォルダが無ければ空。読めない（権限など）なら投げる */
async function slideFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => SLIDE_FILE.test(name)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * 片付けていた画像（.lecscribe/unused/）を slides/ に戻す。処理（場面まとめ・救出 §13.4b・c）は slides/ の
 * 全画像を読むので、処理の前に呼ぶ。同じ名前が slides/ に既にある（「文字起こしする」で送り直された）ときは
 * 片付けていた方を捨てる。戻した枚数を返す
 */
export async function restoreUnusedSlides(sessionDir: string): Promise<number> {
  const unusedDir = workPath(sessionDir, UNUSED_DIR);
  const names = await slideFiles(unusedDir);
  if (names.length === 0) return 0;
  const slidesDir = path.join(sessionDir, SLIDES_DIR);
  await mkdir(slidesDir, { recursive: true });
  let restored = 0;
  for (const name of names) {
    const from = path.join(unusedDir, name);
    const to = path.join(slidesDir, name);
    const exists = await stat(to).then(() => true).catch(() => false);
    if (exists) {
      await rm(from, { force: true });
      continue;
    }
    await rename(from, to);
    restored++;
  }
  return restored;
}

/**
 * ノートが参照している slides/ の画像の名前。`slides/slide_NNN.png` の出現を全部拾う（Markdown の `](slides/…)`、
 * lecture.md の `](../slides/…)`、利用者が書き換えた `<img src="slides/…">` も）。余分に残す損はないので形は問わない
 */
export function slidesInNotes(notes: string): Set<string> {
  const used = new Set<string>();
  for (const m of notes.matchAll(/slides\/(slide_[0-9]{3,}\.(?:png|jpg))/g)) used.add(m[1]!);
  return used;
}

/**
 * notes.md に載せなかった画像を slides/ から .lecscribe/unused/ へ移す（§14）。利用者が slides/ を丸ごと
 * コピーしても、ノートに使った画像だけになるように。処理が終わるたびに呼び、「やり直す」で載せる画像が
 * 変わっても slides/ はいつも notes.md と対応する。notes.md が無ければ何もしない（null）。
 * 作業ファイルの lecture.md が参照する画像も残す。普段は notes.md と同じ並びだが、やり直しを途中で中止すると
 * notes.md は前回のまま、lecture.md は今回の並びになっていて、lecture.md のリンクを切らないため
 */
export async function tidyUnusedSlides(sessionDir: string): Promise<{ moved: number; kept: number } | null> {
  let notes: string;
  try {
    notes = await readFile(path.join(sessionDir, NOTES_FILE), 'utf8');
  } catch {
    return null;
  }
  const used = slidesInNotes(notes);
  const lecture = await readFile(workPath(sessionDir, 'lecture.md'), 'utf8').catch(() => '');
  for (const name of slidesInNotes(lecture)) used.add(name);
  const slidesDir = path.join(sessionDir, SLIDES_DIR);
  const unusedDir = workPath(sessionDir, UNUSED_DIR);
  let moved = 0;
  let kept = 0;
  for (const name of await slideFiles(slidesDir)) {
    if (used.has(name)) {
      kept++;
      continue;
    }
    if (moved === 0) await mkdir(unusedDir, { recursive: true });
    await rename(path.join(slidesDir, name), path.join(unusedDir, name));
    moved++;
  }
  return { moved, kept };
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
