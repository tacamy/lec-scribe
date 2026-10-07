import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * セッションフォルダの配置（SPEC §14）。
 *
 *   <session>/notes.md            ユーザー向けのノート
 *   <session>/slides/             notes.md に載せた画像（正本からの写し。notes.md から相対参照）
 *   <session>/.lecscribe/         作業ファイル: 音声、文字起こし、timeline、session、pipeline など
 *   <session>/.lecscribe/slides/  画像の正本（拡張が送った全画像。場面まとめ・救出はここから選ぶ）
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

/** 画像の正本（.lecscribe/slides/）のパス。処理が画像を読むときはこちら */
export function slidesSourcePath(sessionDir: string, ...parts: string[]): string {
  return workPath(sessionDir, SLIDES_DIR, ...parts);
}

export async function ensureLayout(sessionDir: string): Promise<void> {
  // 録音・文字起こし・ノートが入るので、新しく作るセッションフォルダは本人だけが読めるようにする。
  // ホームは同じ Mac の別のアカウント（グループ staff）が通れる権限なので、既定の 755 だと中身を読まれる
  await mkdir(workPath(sessionDir), { recursive: true, mode: 0o700 });
  await mkdir(slidesSourcePath(sessionDir), { recursive: true });
  await mkdir(path.join(sessionDir, SLIDES_DIR), { recursive: true });
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
 * 旧配置を新配置へ移す。
 *
 * - 作業ファイルがトップレベルにある（2026-09-09 より前）→ `.lecscribe/` へ。新配置の同名ファイルがあれば
 *   トップレベル側は残さず上書きしない（古い方を捨てる）
 * - 画像の正本が `slides/` にある（2026-10-07 より前は全画像が `slides/`）→ `.lecscribe/slides/` へ。新配置では
 *   `slides/` の画像は正本の写しで正本にも同じ名前があるので、正本に無い画像だけを移す（何度呼んでも同じ）。
 *   移したあと `slides/` は空になるので、呼び出し側は `syncSlides` で notes.md に合わせて写し直す
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
  const inSource = new Set(await slideFiles(slidesSourcePath(sessionDir)));
  const images = (await slideFiles(path.join(sessionDir, SLIDES_DIR))).filter((name) => !inSource.has(name));
  if (toMove.length === 0 && images.length === 0) return moved;
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
  for (const name of images) {
    await rename(path.join(sessionDir, SLIDES_DIR, name), slidesSourcePath(sessionDir, name));
    moved.push(`${SLIDES_DIR}/${name}`);
  }
  return moved;
}

/**
 * ノートが参照している slides/ の画像の名前。`slides/slide_NNN.png` の出現を全部拾う（Markdown の `](slides/…)` も、
 * 利用者が書き換えた `<img src="slides/…">` も）。余分に残す損はないので形は問わない
 */
export function slidesInNotes(notes: string): Set<string> {
  const used = new Set<string>();
  for (const m of notes.matchAll(SLIDE_IN_NOTES)) used.add(m[1]!);
  return used;
}
/** `slides/` に続く画像の名前（SLIDE_FILE と同じ形。定義を 1 つにして、拡張子などを変えたときにずれないように） */
const SLIDE_IN_NOTES = new RegExp(`slides/(${SLIDE_FILE.source.replace(/^\^|\$$/g, '')})`, 'g');

export type SlidesSync = {
  /** 正本から写した枚数 */
  copied: number;
  /** 写しが正本と同じなので触らなかった枚数 */
  kept: number;
  /** notes.md に無いので slides/ から消した枚数 */
  removed: number;
  /** notes.md にはあるが正本に無い名前の数（写せないので、古い写しがあればそのまま） */
  missing: number;
};

/**
 * 正本の写しを作る。macOS では `cp -c`（clonefile）で APFS のクローンにして容量を増やさない。
 * Node の `copyFile` は macOS でクローンを実装していない（`COPYFILE_FICLONE_FORCE` が ENOSYS、`COPYFILE_FICLONE` は
 * 黙って普通のコピーになる。libuv 1.52 で確認）ので使わない。cp が失敗したら（APFS 以外、ほかの OS）普通のコピー
 */
async function cloneFile(src: string, dst: string): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('/bin/cp', ['-c', src, dst]);
      return;
    } catch {
      // クローンできない場所。普通のコピーに落とす
    }
  }
  await copyFile(src, dst);
}

/**
 * slides/ を notes.md に合わせる（§14）: 載せた画像を正本から写し、載せていない画像を slides/ から消す。
 * notes.md を書いたあとと、旧配置を移したあとに呼ぶ。notes.md が無ければ何もしない（null）。
 * 写しは APFS ではクローンなので容量は増えない（`cloneFile`）。正本が送り直されて変わっていれば（大きさか更新時刻が違う）写し直す
 */
export async function syncSlides(sessionDir: string): Promise<SlidesSync | null> {
  let notes: string;
  try {
    notes = await readFile(path.join(sessionDir, NOTES_FILE), 'utf8');
  } catch (e) {
    // 無いときだけ「まだノートがない」。読めない（権限など）なら黙って古いままにせず投げる
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const used = slidesInNotes(notes);
  const slidesDir = path.join(sessionDir, SLIDES_DIR);
  await mkdir(slidesDir, { recursive: true });
  const result: SlidesSync = { copied: 0, kept: 0, removed: 0, missing: 0 };
  // 1 枚で失敗しても残りは続け、最後にまとめて投げる（途中で止めると残りが写らないまま）
  const failed: string[] = [];
  for (const name of await slideFiles(slidesDir)) {
    if (used.has(name)) continue;
    try {
      await rm(path.join(slidesDir, name), { force: true });
      result.removed++;
    } catch (e) {
      failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const name of [...used].sort()) {
    const src = slidesSourcePath(sessionDir, name);
    const dst = path.join(slidesDir, name);
    const source = await stat(src).catch(() => null);
    if (!source) {
      result.missing++;
      continue;
    }
    const copy = await stat(dst).catch(() => null);
    if (copy && copy.size === source.size && copy.mtimeMs >= source.mtimeMs) {
      result.kept++;
      continue;
    }
    try {
      // クローンは既にあるファイルの上には作れないので先に消す
      await rm(dst, { force: true });
      await cloneFile(src, dst);
      result.copied++;
    } catch (e) {
      failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failed.length > 0) throw new Error(`${failed.length} 枚を写せませんでした（${failed.join(', ')}）`);
  return result;
}

/**
 * 旧配置の移行のあと、画像を正本へ移していれば slides/ を notes.md に合わせる（移した直後は slides/ が空のため）。
 * 受け付け（POST /sessions・/finalize）と処理の始めから呼ぶ
 */
export async function migrateLayoutAndSync(sessionDir: string): Promise<string[]> {
  const moved = await migrateLayout(sessionDir);
  if (moved.some((name) => name.startsWith(`${SLIDES_DIR}/`))) await syncSlides(sessionDir);
  return moved;
}
