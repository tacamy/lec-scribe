import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

export type RunResult = { code: number; stdout: string; stderr: string; /** binary のとき stdout をそのまま */ stdoutBytes?: Uint8Array };

/** 外部コマンドを実行して終了を待つ。stdout/stderr は末尾だけ保持する */
export function run(
  bin: string,
  args: string[],
  options: {
    cwd?: string;
    onLine?: (line: string) => void;
    signal?: AbortSignal;
    /** stdout を文字列にせず、そのまま全部返す（画像など） */
    binary?: boolean;
    /** binary のときに受け取る最大バイト数（既定 8 MiB）。超えたら打ち切る */
    maxBytes?: number;
  } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal });
    let stdout = '';
    let stderr = '';
    const chunks: Buffer[] = [];
    const keepTail = (s: string) => (s.length > 20_000 ? s.slice(-20_000) : s);
    if (options.binary) {
      // 上限を超えたら打ち切る（想定外の入力で ffmpeg が延々と出し続けることがある）
      const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
      let total = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          chunks.length = 0;
          child.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      });
    } else {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout = keepTail(stdout + chunk);
        if (options.onLine) for (const line of chunk.split('\n')) if (line.trim()) options.onLine(line);
      });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = keepTail(stderr + chunk);
      if (options.onLine) for (const line of chunk.split('\n')) if (line.trim()) options.onLine(line);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, ...(options.binary ? { stdoutBytes: new Uint8Array(Buffer.concat(chunks)) } : {}) }));
  });
}

/** PATH（または絶対パス）でコマンドが見つかるか */
/**
 * 見つかった場所は覚えておく（プロセスが生きている間に変わらない）。/health はリクエストのたびに
 * ffmpeg と whisperkit-cli を探していて、PATH の項目数ぶん access() が走っていた（#9）。
 * 見つからなかった結果も覚えるが、あとから入れた（brew install した）ことに気づけるよう 1 分で忘れる
 */
const resolved = new Map<string, { value: string | null; at: number }>();
const MISS_TTL_MS = 60_000;

export async function resolveBin(bin: string): Promise<string | null> {
  const hit = resolved.get(bin);
  if (hit && (hit.value !== null || Date.now() - hit.at < MISS_TTL_MS)) return hit.value;
  const value = await findBin(bin);
  resolved.set(bin, { value, at: Date.now() });
  return value;
}

/** テスト用。覚えた場所を忘れる */
export function forgetResolvedBins(): void {
  resolved.clear();
}

async function findBin(bin: string): Promise<string | null> {
  const candidates = bin.includes('/') ? [bin] : (process.env['PATH'] ?? '').split(path.delimiter).map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 次を探す
    }
  }
  return null;
}
