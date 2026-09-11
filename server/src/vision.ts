import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ServerConfig, usesVision } from './config.ts';
import { isExecutable, resolveBin, run } from './exec.ts';

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

/** ソースのハッシュ。起動中にソースは変わらない（更新は必ず再起動を伴う。§12.1b）ので 1 回読めば足りる */
let sourceHash: Promise<string> | null = null;

/** いまのソースに対応する補助コマンドの置き場（名前がソースのハッシュ）。ビルドはしない */
export async function helperPath(): Promise<string> {
  sourceHash ??= readFile(SOURCE, 'utf8')
    .then((source) => createHash('sha256').update(source).digest('hex').slice(0, 12))
    .catch((e: unknown) => {
      sourceHash = null; // 読めなかったことは覚えない
      throw e;
    });
  return path.join(binDir(), `imagefp-${await sourceHash}`);
}

/** 置き場にある、いまのソースの補助コマンド。無ければ null。ディスクを見るだけでビルドはしない */
export async function existingHelper(): Promise<string | null> {
  try {
    const bin = await helperPath();
    return (await isExecutable(bin)) ? bin : null;
  } catch {
    return null;
  }
}

export type HelperStatus =
  /** 置き場にあって使える */
  | { state: 'ready' }
  /** いま作っている（起動直後の数秒、または最初の文字起こしの途中） */
  | { state: 'building' }
  /** まだ作ろうとしていない、または置き場から消えた。次に使うときに作る */
  | { state: 'idle' }
  /** 作れなかった。理由は見せるためのもので、やり直しの判断には使わない（次に使うときまた試す） */
  | { state: 'failed'; reason: string };

let helperPromise: Promise<string | null> | null = null;
let building = false;
let lastFailure: string | null = null;

/**
 * 補助コマンドの状態（/health 用。#17）。ディスクを見るだけでビルドは始めない。
 * CLT が無い Mac にも /usr/bin/swiftc の shim があり、/health のたびに叩くとダイアログが出るため。
 * Vision を使わない設定と macOS 以外は null（そもそも使わない）
 */
export async function visionStatus(config: Pick<ServerConfig, 'sceneVision' | 'sceneVisionPhoto'>): Promise<HelperStatus | null> {
  if (!usesVision(config) || process.platform !== 'darwin') return null;
  if (building) return { state: 'building' };
  if (await existingHelper()) return { state: 'ready' };
  if (lastFailure !== null) return { state: 'failed', reason: lastFailure };
  return { state: 'idle' };
}

/**
 * ビルド済みの補助コマンドのパス。無ければ作る。作れなければ null。
 * 覚えたパスはまだあるか確かめてから返す（置き場を退避・削除されたら作り直す。/health の見え方と食い違わないように）。
 * 覚えておくのは作れたときだけ。作れなかったことを覚えると、起動時にたまたま駄目だった（Xcode の更新中、
 * Command Line Tools をまだ入れていない）だけで、常駐サーバーが動いている何日もの間ずっと見た目の判定を
 * 諦めることになる。作れなければ忘れて、次に呼ばれたらやり直す（そのとき呼び出し側のログにも理由が出る）
 */
export async function ensureVisionHelper(log: (message: string) => void = () => undefined): Promise<string | null> {
  const cached = helperPromise;
  if (cached) {
    const bin = await cached;
    if (bin && (await isExecutable(bin))) return bin;
    // 消えていた。自分が最初に気づいたなら忘れる（同時に気づいた別の呼び出しが先に作り始めていればそれを待つ）
    if (helperPromise === cached) helperPromise = null;
  }
  helperPromise ??= startBuild(log);
  return helperPromise;
}

function startBuild(log: (message: string) => void): Promise<string | null> {
  building = true;
  return build(log)
    .then((bin) => {
      lastFailure = null;
      return bin;
    })
    .catch((e: unknown) => {
      lastFailure = describeBuildError(e);
      log(`Vision の補助コマンドを用意できません（見た目の距離は使いません）: ${lastFailure}`);
      return null;
    })
    .then((bin) => {
      building = false;
      if (!bin) helperPromise = null;
      return bin;
    });
}

/** 失敗の理由を 1 行に。打ち切りは spawn の AbortError で届く */
function describeBuildError(e: unknown): string {
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
    return `${BUILD_TIMEOUT_MS / 60_000} 分たっても終わりませんでした（「開発者ツールをインストールしますか」のダイアログが出たままになっていないか確かめてください）`;
  }
  return e instanceof Error ? e.message : String(e);
}

async function build(log: (message: string) => void): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const bin = await helperPath();
  if (await isExecutable(bin)) return bin;
  const swiftc = (await resolveBin('swiftc')) ?? (await resolveBin('xcrun'));
  if (!swiftc) throw new Error('swiftc が見つかりません（Xcode Command Line Tools を入れると、見た目が同じ画像の判定が使えます）');
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
