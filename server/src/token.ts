import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 拡張機能との共有トークン（SPEC D-10）。初回起動時にサーバーが生成して
 * ファイルに保存し、ユーザーが拡張の設定に貼り付ける。
 */
export async function loadOrCreateToken(file: string): Promise<{ token: string; created: boolean }> {
  try {
    const token = (await readFile(file, 'utf8')).trim();
    if (token.length >= 32) return { token, created: false };
  } catch {
    // なければ作る
  }
  const token = randomBytes(24).toString('base64url');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return { token, created: true };
}

/** `Authorization: Bearer <token>` を定数時間で照合する */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
