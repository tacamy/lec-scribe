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
  /**
   * 見た目の判定の補助コマンドの状態（api 2 から。#17）。null は使わない設定か macOS 以外。
   * 返さない（undefined）のは 2 より前のサーバー。見せるだけの項目なので、無ければ行を出さないだけ（古さの判定は api で行う）
   */
  vision?: 'ready' | 'building' | 'idle' | 'failed' | null;
  /** vision が failed のときの理由 */
  visionReason?: string;
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

/** サーバーのログの場所（作れなかった理由の全文はここ） */
export const SERVER_LOG = '~/Library/Logs/lec-scribe/server.log';

/**
 * 見た目の判定（Vision）の 1 行。設定画面の「接続テスト」に出す（#17）。
 * サーバーが状態を返さない（2 より前の版）なら null＝行を出さない。
 * 「なし」を CLT の導入に直結させない: まだ作っていない・作っている途中・作れなかった、は別の状態で、
 * 導入を勧めていいのは作れなかったときだけ
 */
export function visionLine(h: Health): string | null {
  if (h.vision === undefined) return null;
  const label = '見た目の判定（Vision）';
  switch (h.vision) {
    case null:
      return `${label}: 使わない（設定で切っているか、macOS 以外）`;
    case 'ready':
      return `${label}: あり`;
    case 'building':
      return `${label}: 準備中（数秒。もう一度押してください）`;
    case 'idle':
      return `${label}: まだ作っていません。次の文字起こしのときに作ります`;
    case 'failed':
      return `${label}: 作れませんでした（${h.visionReason ?? '理由不明'}）。Xcode Command Line Tools が無いか、ライセンスに未同意のことが多いです（xcode-select --install / sudo xcodebuild -license）。直したあと、次の文字起こしのときに作り直します。ログ: ${SERVER_LOG}`;
    default:
      return `${label}: 分かりません（サーバーの答え: ${String(h.vision)}）`;
  }
}
