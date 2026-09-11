import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, chmod, constants, mkdir, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBin, run } from './exec.ts';

/**
 * macOS の Vision で画像の「見た目の距離」を測り、写っている文字を読む（SPEC §13.4b）。
 * Swift の小さな補助コマンド（tools/imagefp.swift）を初回に swiftc でビルドして使う。
 * swiftc がない（Command Line Tools 未導入）ときは null を返し、呼び出し側は Vision なしで進める。
 */

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'imagefp.swift');
const BIN_DIR = path.join(os.homedir(), '.lec-scribe', 'bin');

let helperPromise: Promise<string | null> | null = null;

/** ビルド済みの補助コマンドのパス。ソースが変わっていれば作り直す。作れなければ null */
export function ensureVisionHelper(log: (message: string) => void = () => undefined): Promise<string | null> {
  helperPromise ??= build(log).catch((e: unknown) => {
    log(`Vision の補助コマンドを用意できません（見た目の距離は使いません）: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  return helperPromise;
}

async function build(log: (message: string) => void): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const source = await readFile(SOURCE, 'utf8');
  const bin = path.join(BIN_DIR, `imagefp-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`);
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
  await mkdir(BIN_DIR, { recursive: true, mode: 0o700 });
  log('Vision の補助コマンドをビルドします（初回だけ、数十秒）');
  // 途中で止まっても壊れたコマンドが残らないよう、別名で作ってから置き換える
  const tmp = `${bin}.tmp-${process.pid}`;
  const args = swiftc.endsWith('xcrun') ? ['swiftc', '-O', SOURCE, '-o', tmp] : ['-O', SOURCE, '-o', tmp];
  try {
    const r = await run(swiftc, args);
    if (r.code !== 0) throw new Error(`swiftc failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')}`);
    await chmod(tmp, 0o755);
    await rename(tmp, bin);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  return bin;
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
