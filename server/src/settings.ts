import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from './config.ts';

/**
 * 設定画面から変えられる設定（SPEC §15.2、2026-10-01）。いまはノート作成のモデルだけ。
 *
 * サーバーの設定は起動時の環境変数（launchd の plist）で決まるが、モデルの選び替えのたびに
 * ターミナルで登録し直させないよう、設定画面からの変更は `~/.lec-scribe/settings.json` に保存し、
 * 起動時の値より優先する。反映は次のノート作成から（pipeline は処理のたびに config を読む）。
 * 「サーバー起動時の設定に戻す」はこのファイルを消すだけ。
 */

export type LlmOverrides = {
  /** 本文を整える・要点を作るモデル。空文字は「指定なし（呼び出し先の既定）」 */
  llmModel?: string;
  /** 校正（誤変換の修正）のモデル。空文字は「校正しない」 */
  llmCheckModel?: string;
};

/** モデル名として受け付ける形（codex / OpenAI / Ollama のモデル名と空文字）。コマンドの引数に渡すので範囲を絞る */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$|^$/;

export function isValidModelName(value: unknown): value is string {
  return typeof value === 'string' && MODEL_NAME.test(value);
}

/** 保存してある上書きを読む。無い・壊れている・形が不正なら {}（起動時の設定のまま） */
export async function readLlmOverrides(file: string): Promise<LlmOverrides> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const out: LlmOverrides = {};
    if (isValidModelName(raw['llmModel'])) out.llmModel = raw['llmModel'];
    if (isValidModelName(raw['llmCheckModel'])) out.llmCheckModel = raw['llmCheckModel'];
    return out;
  } catch {
    return {};
  }
}

/** 上書きを保存する（null なら削除 = 起動時の設定に戻す） */
export async function writeLlmOverrides(file: string, overrides: LlmOverrides | null): Promise<void> {
  if (overrides === null) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(overrides, null, 2)}\n`, { mode: 0o600 });
}

/** 上書きを config に反映する（キーがあるものだけ） */
export function applyLlmOverrides(config: ServerConfig, overrides: LlmOverrides): void {
  if (overrides.llmModel !== undefined) config.llmModel = overrides.llmModel;
  if (overrides.llmCheckModel !== undefined) config.llmCheckModel = overrides.llmCheckModel;
}
