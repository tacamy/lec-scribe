import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec.ts';

/**
 * 拡張との接続承認（トークンの代わり）。
 * 拡張の設定画面の「このMacと接続」で POST /pair が来たら、macOS のダイアログで
 * ユーザーに許可を求め、許可されたらその拡張 ID を trusted.json に記録する。
 * 承認した拡張には専用のトークンを発行して返す（拡張はそれを保存して Bearer で送る）。
 * Origin（chrome-extension://<id>）はブラウザが付けるので Web ページや別の拡張には偽装できず、
 * トークンは承認された拡張だけが受け取る。GET 要求には Origin が付かない（host_permissions のある
 * 拡張ページからの fetch は CORS 扱いにならない）ため、認可はトークンで行う。
 */
export type TrustedEntry = { id: string; token: string; name: string; at: string };
export type Trusted = { entries: Map<string, TrustedEntry>; file: string };

export async function loadTrusted(file: string): Promise<Trusted> {
  const entries = new Map<string, TrustedEntry>();
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { extensions?: Array<Partial<TrustedEntry>> };
    for (const e of parsed.extensions ?? []) {
      if (typeof e.id === 'string' && EXTENSION_ID.test(e.id) && typeof e.token === 'string' && e.token.length >= 32) {
        entries.set(e.id, { id: e.id, token: e.token, name: e.name ?? '', at: e.at ?? '' });
      }
    }
  } catch {
    // なければ空
  }
  return { entries, file };
}

/** 拡張を承認して専用トークンを発行し、ファイルに残す */
export async function saveTrusted(trusted: Trusted, id: string, name: string): Promise<TrustedEntry> {
  const entry: TrustedEntry = { id, token: randomBytes(24).toString('base64url'), name, at: new Date().toISOString() };
  trusted.entries.set(id, entry);
  await mkdir(path.dirname(trusted.file), { recursive: true, mode: 0o700 });
  await writeFile(trusted.file, `${JSON.stringify({ extensions: [...trusted.entries.values()] }, null, 2)}\n`, { mode: 0o600 });
  return entry;
}

/** `Authorization: Bearer <token>` が承認済みの拡張のものなら、その記録を返す */
export function trustedByToken(trusted: Trusted, header: string | undefined): TrustedEntry | null {
  if (!header?.startsWith('Bearer ')) return null;
  const given = Buffer.from(header.slice(7).trim());
  for (const entry of trusted.entries.values()) {
    const expected = Buffer.from(entry.token);
    if (given.length === expected.length && timingSafeEqual(given, expected)) return entry;
  }
  return null;
}

const EXTENSION_ID = /^[a-p]{32}$/;

/** `chrome-extension://<id>` から id を取り出す。それ以外は null */
export function extensionIdFromOrigin(origin: string | undefined): string | null {
  if (!origin?.startsWith('chrome-extension://')) return null;
  const id = origin.slice('chrome-extension://'.length);
  return EXTENSION_ID.test(id) ? id : null;
}

/** 拡張名は表示にしか使わないが、相手が送ってくる文字列なので短くして制御文字を落とす */
export function sanitizeName(name: unknown): string {
  return String(name ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 60);
}

/**
 * macOS のダイアログで許可を求める。osascript に本文は引数で渡す（文字列を AppleScript に埋め込まない）。
 * 「許可」で true、「許可しない」・2 分放置で false
 */
export async function askPermission(osascriptBin: string, message: string): Promise<boolean> {
  const script = [
    'on run argv',
    'try',
    'set r to display dialog (item 1 of argv) with title "LecScribe Server" buttons {"許可しない", "許可"} default button "許可" cancel button "許可しない" with icon caution giving up after 120',
    'if gave up of r then return "denied"',
    'return "allowed"',
    'on error',
    'return "denied"',
    'end try',
    'end run',
  ];
  const args = script.flatMap((line) => ['-e', line]);
  const r = await run(osascriptBin, [...args, message]);
  if (r.code !== 0) throw new Error(`osascript failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')}`);
  return r.stdout.trim() === 'allowed';
}
