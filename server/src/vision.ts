import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, chmod, constants, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBin, run } from './exec.ts';

/**
 * macOS の Vision で画像の「見た目の距離」を測り、写っている文字を読む（SPEC §13.4b）。
 * Swift の小さな補助コマンド（tools/imagefp.swift）を swiftc でビルドして使う。呼ばれたときに作り、
 * 名前がソースのハッシュなので、変わっていなければ作り直さない（誰が先に呼ぶかは呼び出し側の都合）。
 * swiftc がない（Command Line Tools 未導入）ときは null を返し、呼び出し側は Vision なしで進める。
 */

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'imagefp.swift');
/** 作った補助コマンドの置き場。HOME を見るのは呼ばれたとき（テストで差し替えられるように） */
const binDir = () => path.join(os.homedir(), '.lec-scribe', 'bin');
/**
 * ビルドの待ち時間。macOS には Xcode Command Line Tools が無くても /usr/bin/swiftc があり、
 * これは「開発者ツールをインストールしますか」のダイアログを出したまま返らないことがある。
 * 打ち切らないと、あとから補助コマンドを待つ文字起こしも一緒に永久に止まる（update.ts と同じ用心）
 */
const BUILD_TIMEOUT_MS = 180_000;
/** 途中で終わった（強制終了された）ビルドの置き土産を片付けるまでの時間 */
const STALE_TMP_MS = 60 * 60 * 1000;

let helperPromise: Promise<string | null> | null = null;

/** ビルド済みの補助コマンドのパス。ソースが変わっていれば作り直す。作れなければ null */
export function ensureVisionHelper(log: (message: string) => void = () => undefined): Promise<string | null> {
  // 覚えておくのは作れたときだけ。作れなかったことを覚えると、起動時にたまたま駄目だった（Xcode の更新中、
  // Command Line Tools をまだ入れていない）だけで、常駐サーバーが動いている何日もの間ずっと見た目の判定を
  // 諦めることになる。作れなければ忘れて、次に呼ばれたらやり直す（そのとき呼び出し側のログにも理由が出る）
  helperPromise ??= build(log)
    .catch((e: unknown) => {
      log(`Vision の補助コマンドを用意できません（見た目の距離は使いません）: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    })
    .then((bin) => {
      if (!bin) helperPromise = null;
      return bin;
    });
  return helperPromise;
}

async function build(log: (message: string) => void): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const source = await readFile(SOURCE, 'utf8');
  const bin = path.join(binDir(), `imagefp-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`);
  try {
    await access(bin, constants.X_OK);
    return bin;
  } catch {
    // まだない
  }
  const swiftc = (await resolveBin('swiftc')) ?? (await resolveBin('xcrun'));
  if (!swiftc) {
    log('swiftc が見つかりません（Xcode Command Line Tools を入れると、見た目が同じ画像の判定が使えます）');
    return null;
  }
  await mkdir(binDir(), { recursive: true, mode: 0o700 });
  await sweepStale();
  log('Vision の補助コマンドをビルドします（ソースが変わったときだけ、数秒）');
  // 途中で止まっても壊れたコマンドが残らないよう、別名で作ってから置き換える
  const tmp = `${bin}.tmp-${process.pid}`;
  const args = swiftc.endsWith('xcrun') ? ['swiftc', '-O', SOURCE, '-o', tmp] : ['-O', SOURCE, '-o', tmp];
  try {
    const r = await run(swiftc, args, { signal: AbortSignal.timeout(BUILD_TIMEOUT_MS) });
    if (r.code !== 0) throw new Error(`swiftc failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')}`);
    await chmod(tmp, 0o755);
    await rename(tmp, bin);
    log('Vision の補助コマンドを作りました');
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  return bin;
}

/**
 * 途中で終わったビルドの置き土産（imagefp-<hash>.tmp-<pid>）を片付ける。
 * 片付けは catch にしか無いので、サーバーごと強制終了されると残る（agent restart、ログアウト）。
 * 動いている最中のビルドを消さないよう、しばらく経ったものだけ
 */
async function sweepStale(): Promise<void> {
  try {
    const now = Date.now();
    const dir = binDir();
    for (const name of await readdir(dir)) {
      if (!name.includes('.tmp-')) continue;
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info && now - info.mtimeMs > STALE_TMP_MS) await rm(file, { force: true }).catch(() => undefined);
    }
  } catch {
    // 片付けは失敗しても構わない
  }
}

export type VisionMeasure = {
  /** 画像同士の距離（0 に近いほど似ている）。測れない組は undefined */
  distance: (a: number, b: number) => number | undefined;
  /** 画像に写っている文字（行を改行でつないだもの）。読めなかった画像は undefined */
  text: (index: number) => string | undefined;
};

type HelperOutput = { distances: Array<Array<number | null>>; texts?: Array<string | null> };

/** 画像同士の距離と、画像に写っている文字。補助コマンドがなければ null */
export async function visionDistances(
  files: readonly string[],
  log: (message: string) => void = () => undefined,
  signal?: AbortSignal,
): Promise<VisionMeasure | null> {
  if (files.length < 2) return null;
  // パスは 1 行 1 件で渡すので、改行を含むファイル名があると全体がずれる。そのときは使わない
  if (files.some((f) => f.includes('\n'))) {
    log('画像のパスに改行が含まれているため、見た目の判定は使いません');
    return null;
  }
  const bin = await ensureVisionHelper(log);
  if (!bin) return null;
  const output = await new Promise<HelperOutput | null>((resolve) => {
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (err += c));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        log(`Vision の補助コマンドが失敗しました (${code}): ${err.trim().slice(-200)}`);
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(out) as HelperOutput);
      } catch {
        resolve(null);
      }
    });
    // 補助コマンドが先に終わると EPIPE が飛ぶ。拾わないとサーバーごと落ちる
    child.stdin.on('error', () => resolve(null));
    child.stdin.end(files.join('\n') + '\n');
  });
  if (!output || !Array.isArray(output.distances)) return null;
  if (output.distances.length !== files.length) {
    log(`Vision の結果の件数が合いません（${output.distances.length} / ${files.length}）。見た目の判定は使いません`);
    return null;
  }
  const { distances, texts } = output;
  return {
    distance: (a, b) => {
      const v = distances[a]?.[b];
      return typeof v === 'number' ? v : undefined;
    },
    text: (index) => {
      const t = texts?.[index];
      return typeof t === 'string' ? t : undefined;
    },
  };
}
