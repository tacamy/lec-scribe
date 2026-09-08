import os from 'node:os';
import path from 'node:path';

/** サーバー設定（SPEC §12.1）。CLI 引数 > 環境変数 > 既定値 */
export type ServerConfig = {
  host: string;
  port: number;
  /** 成果物の出力先。セッションごとにサブディレクトリを作る */
  outDir: string;
  /** whisperkit-cli に渡すモデル名 */
  model: string;
  language: string;
  tokenFile: string;
  whisperkitBin: string;
  ffmpegBin: string;
  /** 出力フォルダを Finder で開くコマンド（macOS の open） */
  openBin: string;
  /** 処理後に audio.wav を残すか */
  keepWav: boolean;
};

export const DEFAULT_PORT = 47321;

export function loadConfig(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const args = parseArgs(argv);
  const home = os.homedir();
  const pick = (flag: string, envName: string, fallback: string) => args[flag] ?? env[envName] ?? fallback;
  return {
    host: '127.0.0.1',
    port: Number(pick('port', 'LEC_SCRIBE_PORT', String(DEFAULT_PORT))),
    outDir: expandHome(pick('out', 'LEC_SCRIBE_OUT', path.join(home, 'LecScribe'))),
    model: pick('model', 'LEC_SCRIBE_MODEL', 'large-v3'),
    language: pick('language', 'LEC_SCRIBE_LANGUAGE', 'ja'),
    tokenFile: expandHome(pick('token-file', 'LEC_SCRIBE_TOKEN_FILE', path.join(home, '.lec-scribe', 'token'))),
    whisperkitBin: pick('whisperkit', 'LEC_SCRIBE_WHISPERKIT', 'whisperkit-cli'),
    ffmpegBin: pick('ffmpeg', 'LEC_SCRIBE_FFMPEG', 'ffmpeg'),
    openBin: pick('open', 'LEC_SCRIBE_OPEN', 'open'),
    keepWav: args['keep-wav'] === 'true' || env['LEC_SCRIBE_KEEP_WAV'] === '1',
  };
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
