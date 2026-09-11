import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** サーバー設定（SPEC §12.1）。CLI 引数 > 環境変数 > 既定値 */
export type ServerConfig = {
  host: string;
  port: number;
  /** 起動時に origin/main を見て、進んでいれば入れ替えて再起動する（§12.1b）。--auto-update 0 で止める */
  autoUpdate: boolean;
  /** サーバーのコードがある git の作業ツリー（自動更新の対象） */
  appDir: string;
  /** 成果物の出力先。セッションごとにサブディレクトリを作る */
  outDir: string;
  /** whisperkit-cli に渡すモデル名 */
  model: string;
  language: string;
  tokenFile: string;
  /** 承認済みの拡張 ID を置くファイル（POST /pair で追加） */
  trustedFile: string;
  /** 接続承認のダイアログを出すコマンド（macOS の osascript） */
  osascriptBin: string;
  whisperkitBin: string;
  ffmpegBin: string;
  /** 出力フォルダを Finder で開くコマンド（macOS の open） */
  openBin: string;
  /** 処理後に audio.wav を残すか */
  keepWav: boolean;
  /** ノート作成（話し言葉を整えて要点を付ける）の呼び出し先（SPEC §13.5）。none なら notes.md を作らない */
  llm: 'none' | 'codex' | 'openai' | 'ollama';
  llmModel: string;
  codexBin: string;
  openaiApiKey: string;
  ollamaUrl: string;
  llmCharsPerCall: number;
  /** 同じ場面の画像を notes.md から外す色の一致の閾値（0〜1）。0 で無効（SPEC §13.4b） */
  sceneColor: number;
  /** Vision の見た目の距離がこれ以下なら同じ画面（メニュー・スクロール程度）。0 で Vision を使わない */
  sceneVision: number;
  /** 両方が写真・映像なら、見た目の距離がこれ以下で同じ場面 */
  sceneVisionPhoto: number;
  /** 同じ場面が続いたとき、最初と最後のどちらの画像を載せるか */
  sceneKeep: 'first' | 'last';
};

export const DEFAULT_PORT = 47321;
/** このファイルから見たリポジトリの根（server/src/config.ts → ../..） */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const args = parseArgs(argv);
  const home = os.homedir();
  const pick = (flag: string, envName: string, fallback: string) => args[flag] ?? env[envName] ?? fallback;
  /** 数値として読めない指定（打ち間違い、空文字）は既定値に戻す。NaN のまま使うと判定が黙って無効になるため */
  const num = (value: string, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    host: '127.0.0.1',
    autoUpdate: pick('auto-update', 'LEC_SCRIBE_AUTO_UPDATE', '1') !== '0',
    appDir: expandHome(pick('app-dir', 'LEC_SCRIBE_APP_DIR', APP_DIR)),
    port: Number(pick('port', 'LEC_SCRIBE_PORT', String(DEFAULT_PORT))),
    outDir: expandHome(pick('out', 'LEC_SCRIBE_OUT', path.join(home, 'LecScribe'))),
    model: pick('model', 'LEC_SCRIBE_MODEL', 'large-v3'),
    language: pick('language', 'LEC_SCRIBE_LANGUAGE', 'ja'),
    tokenFile: expandHome(pick('token-file', 'LEC_SCRIBE_TOKEN_FILE', path.join(home, '.lec-scribe', 'token'))),
    trustedFile: expandHome(pick('trusted-file', 'LEC_SCRIBE_TRUSTED_FILE', path.join(home, '.lec-scribe', 'trusted.json'))),
    osascriptBin: pick('osascript', 'LEC_SCRIBE_OSASCRIPT', 'osascript'),
    whisperkitBin: pick('whisperkit', 'LEC_SCRIBE_WHISPERKIT', 'whisperkit-cli'),
    ffmpegBin: pick('ffmpeg', 'LEC_SCRIBE_FFMPEG', 'ffmpeg'),
    openBin: pick('open', 'LEC_SCRIBE_OPEN', 'open'),
    keepWav: args['keep-wav'] === 'true' || env['LEC_SCRIBE_KEEP_WAV'] === '1',
    llm: parseLlm(pick('llm', 'LEC_SCRIBE_LLM', 'none')),
    llmModel: pick('llm-model', 'LEC_SCRIBE_LLM_MODEL', ''),
    codexBin: pick('codex', 'LEC_SCRIBE_CODEX', 'codex'),
    openaiApiKey: env['OPENAI_API_KEY'] ?? '',
    ollamaUrl: pick('ollama-url', 'LEC_SCRIBE_OLLAMA_URL', 'http://127.0.0.1:11434'),
    llmCharsPerCall: num(pick('llm-chars', 'LEC_SCRIBE_LLM_CHARS', '12000'), 12000),
    sceneColor: num(pick('scene-color', 'LEC_SCRIBE_SCENE_COLOR', '0.65'), 0.65),
    sceneVision: num(pick('scene-vision', 'LEC_SCRIBE_SCENE_VISION', '0.2'), 0.2),
    sceneVisionPhoto: num(pick('scene-vision-photo', 'LEC_SCRIBE_SCENE_VISION_PHOTO', '0.55'), 0.55),
    sceneKeep: pick('scene-keep', 'LEC_SCRIBE_SCENE_KEEP', 'last') === 'first' ? 'first' : 'last',
  };
}

function parseLlm(value: string): ServerConfig['llm'] {
  if (value === 'codex' || value === 'openai' || value === 'ollama') return value;
  if (value !== 'none') console.warn(`unknown --llm "${value}", using none`);
  return 'none';
}

/** `--key value` / `--key=value` / `--flag`（= "true"）を読む */
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[arg.slice(2)] = next;
        i++;
      } else {
        out[arg.slice(2)] = 'true';
      }
    }
  }
  return out;
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}
