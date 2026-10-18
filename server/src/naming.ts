import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { slugify } from './format.ts';
import { NOTES_FILE, workPath } from './layout.ts';

/**
 * 講義の名前（§14、2026-10-18）。フォルダ名・notes.md と lecture.md の見出し・拡張の一覧に出す名前は、
 * 利用者が付けた名前（session.json の name。拡張の一覧で見出しをクリックして付ける）があればそれ、なければページの題名（title）。
 * 1 つのページに動画がいくつもあると、ページの題名だけでは全部同じ名前になって区別できないため
 */
export type SessionInfo = {
  sessionId?: string;
  title?: string;
  url?: string;
  startedAt?: string;
  name?: string;
  [key: string]: unknown;
};

/** 利用者が付ける名前の長さの上限（文字数）。フォルダ名には slugify でさらに短くして使う */
export const NAME_MAX_CHARS = 100;

/** 名前もページの題名も無い講義の見出し（buildNotesMarkdown・buildLectureMarkdown と同じ） */
const UNTITLED = 'ノート';

export const SESSION_FILE = 'session.json';

/** 一覧・見出し・フォルダ名に使う名前。どちらも無ければ undefined（フォルダ名は ID だけ、見出しは「ノート」） */
export function displayName(session: SessionInfo | undefined): string | undefined {
  for (const v of [session?.name, session?.title]) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (s) return s;
  }
  return undefined;
}

/**
 * 利用者が送ってきた名前を整える。空文字・null は「名前を外す」（ページの題名に戻す）で null。
 * 文字列でない、長すぎる、制御文字を含む（改行で見出しやフォルダ名が壊れる）ものは undefined（受け付けない）
 */
export function cleanName(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim();
  if (name === '') return null;
  const chars = Array.from(name);
  if (chars.some((c) => c.codePointAt(0)! < 0x20 || c.codePointAt(0) === 0x7f)) return undefined;
  if (chars.length > NAME_MAX_CHARS) return undefined;
  return name;
}

/** フォルダ名。Finder で並べたときに名前で探せるよう、名前を先に、ID を後ろに付ける（ID で探せるように必ず残す） */
export function folderNameFor(sessionId: string, name: string | undefined): string {
  const slug = slugify(name);
  return slug ? `${slug}_${sessionId}` : sessionId;
}

export async function readSessionInfo(dir: string): Promise<SessionInfo | undefined> {
  try {
    const parsed = JSON.parse(await readFile(workPath(dir, SESSION_FILE), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SessionInfo) : undefined;
  } catch {
    return undefined;
  }
}

export async function writeSessionInfo(dir: string, info: SessionInfo): Promise<void> {
  await writeFile(workPath(dir, SESSION_FILE), JSON.stringify(info, null, 2));
}

/** Markdown の 1 行目の見出し（# …）を書き換える。ファイルが無い・1 行目が見出しでなければ何もしない */
export async function setHeading(file: string, title: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return false;
  }
  const newline = content.indexOf('\n');
  const first = newline < 0 ? content : content.slice(0, newline);
  if (!first.startsWith('# ')) return false;
  const next = `# ${title}`;
  if (first === next) return false;
  await writeFile(file, next + (newline < 0 ? '' : content.slice(newline)));
  return true;
}

/**
 * 名前をフォルダに反映する。notes.md と lecture.md の見出しを書き換え（名前が無ければ「ノート」）、フォルダ名が違えば付け替える。
 * 付け替えた先のフォルダを返す（変わらなければ dir のまま）。付け替え先がもうあれば付け替えない
 * （同じ ID のフォルダは 1 つのはずなので、起きるのは利用者が手で作ったときだけ）。
 * 処理中のフォルダには使わない（書き込み先がずれる）。呼ぶのは HTTP の受け口で、処理中でないと確かめたときだけ
 */
export async function applyName(dir: string, sessionId: string, name: string | undefined): Promise<string> {
  await setHeading(path.join(dir, NOTES_FILE), name ?? UNTITLED);
  await setHeading(workPath(dir, 'lecture.md'), name ?? UNTITLED);
  const target = path.join(path.dirname(dir), folderNameFor(sessionId, name));
  if (target === dir) return dir;
  if (await stat(target).then(() => true).catch(() => false)) return dir;
  await rename(dir, target);
  return target;
}
