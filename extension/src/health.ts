import { authHeaders, type Config } from './config';

/**
 * Mac 側のサーバーとの話が通じるかを見る（SPEC §12.1c、#7）。
 *
 * 拡張はウェブストアが、サーバーは自分自身が更新するので、片方だけ新しい状態が起こりうる。
 * 新しい拡張が古いサーバーに新しい項目を送っても、古いサーバーは知らずに黙って無視するので、
 * 利用者は「削除したのにフォルダが残る」のような形でしか気づけない。そこでサーバーが
 * 「約束の版」（API_VERSION）を /health で返し、拡張が必要な最低の版と比べる。
 */

/** この拡張が必要とするサーバーの約束の版。サーバー側の API_VERSION（server/src/app.ts）と同じ意味 */
export const REQUIRED_SERVER_API = 1;

/** install.sh がサーバーを置く場所（LEC_SCRIBE_APP_DIR を指定していなければここ） */
export const APP_DIR = '~/LecScribe-app';
/** 手で更新するときの 1 行。設定画面と警告文で同じものを出す */
export const UPDATE_COMMAND = `bash ${APP_DIR}/update.sh`;

export type Health = {
  version?: string;
  /** 約束の版。返さないサーバーは 2026-09-11 より前の版 */
  api?: number;
  /** 動いているコードのコミット（診断用） */
  commit?: string | null;
  whisperkit?: boolean;
  ffmpeg?: boolean;
  authorized?: boolean;
  paired?: boolean;
  model?: string;
  outDir?: string;
  llm?: string;
  processing?: number;
};

/**
 * /health を読む。繋がらなければ投げる（呼び出し側が「見つからない」として扱う）。
 * 応答しないサーバー（ポートは開いているが返さない等）で待ち続けないよう既定 3 秒で打ち切る
 */
export async function fetchHealth(
  server: Pick<Config['server'], 'port' | 'token'>,
  options: { auth?: boolean; timeoutMs?: number } = {},
): Promise<Health> {
  const headers = options.auth === false ? {} : authHeaders(server);
  const res = await fetch(`http://127.0.0.1:${server.port}/health`, { headers, signal: AbortSignal.timeout(options.timeoutMs ?? 3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Health;
}

/** サーバーが古くて、この拡張の一部の機能が通じないか */
export function serverOutdated(health: Health): boolean {
  const api = typeof health.api === 'number' ? health.api : 0;
  return api < REQUIRED_SERVER_API;
}

/**
 * 古いときに出す文。すぐ直す方法を添える。
 * 自動更新（§12.1b）は install.sh で入れたサーバー（plist の LEC_SCRIBE_MANAGED）でだけ動き、
 * `pnpm start` などでは動かない。/health からは有効かどうか分からないので、言い切らない
 */
export function outdatedMessage(health: Health): string {
  const have = typeof health.api === 'number' ? `版 ${health.api}` : '古い版';
  return `Mac 側のサーバーが古く（${have}。この拡張には版 ${REQUIRED_SERVER_API} が必要）、一部の機能が動きません。自動更新が有効なら次にログインしたときに直ります。すぐに直すには、ターミナルで ${UPDATE_COMMAND} を実行してください。`;
}
