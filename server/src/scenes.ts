import { run } from './exec.ts';
import type { SlideEntry } from './merge.ts';

/**
 * 同じ場面の画像を notes.md に並べない（SPEC §13.4b）。
 *
 * 映像を追っているカメラは被写体が動くだけで画素が大きく変わるので、拡張の変化検知は
 * 同じ場面を何枚も撮る。ここでは保存済みの画像を全部見たうえで、最後に載せた画像と
 * 「同じ」と判断できるものを notes.md / lecture.md から外す。画像そのものは slides/ に残す。
 *
 * 判断の材料は、画素の差、macOS の Vision で測る見た目の距離、写っている文字（文字認識）、
 * 行ごとの色の並び（スクロール）、色の分布。色の分布は拡張が記録した trigger.stillFraction（動き続けている
 * 画素を除いた静止部分の割合）が半分未満の画像＝映像中心の画面と、写真・映像らしい画面で切り替えの瞬間の変化
 * （trigger.diffPrev）が小さかった画像＝同じショットの続きにだけ効かせる。スライド中心の画面では、
 * 同じ配色で文字だけ違うスライドが「同じ場面」に見えてしまうため。
 */

export const THUMB_WIDTH = 160;
export const THUMB_HEIGHT = 90;
const COLOR_BINS = 8;
/** 静止部分がこの割合を超える画像はスライドとみなし、色でのまとめの対象にしない */
const FOOTAGE_MAX_STILL = 0.5;
/**
 * 画素がこの割合しか違わない画像は、中身が同じとみなして必ず外す（スライドでも映像でも）。
 * 160×90 の 5% = 720 画素で、見た目にはほぼ区別がつかない（5 章で 2〜4% の組が残っていたため 2% から上げた）
 */
const IDENTICAL_MAX_DIFF = 0.05;
/** 画素を「違う」とみなすチャンネル差 */
const PIXEL_DIFF = 24;
/** RGBA の並びの中の 2 画素（a の i 番目、b の j 番目）が「違う」か。pixelDiff と panResidual で同じ判定を使う */
function pixelDiffers(a: Uint8Array, i: number, b: Uint8Array, j: number): boolean {
  const dr = a[i]! - b[j]!;
  const dg = a[i + 1]! - b[j + 1]!;
  const db = a[i + 2]! - b[j + 2]!;
  return dr >= PIXEL_DIFF || -dr >= PIXEL_DIFF || dg >= PIXEL_DIFF || -dg >= PIXEL_DIFF || db >= PIXEL_DIFF || -db >= PIXEL_DIFF;
}
/** 色の多様さ（ビット）がこれ以上なら写真・映像とみなし、Vision の判定を広めに使う。文字中心のスライドは 0〜3 */
const PHOTO_ENTROPY_BITS = 3.0;
/** 文字のそろい具合がこれ以上なら同じ文字とみなす（文字認識の読み違いを許す） */
const SAME_TEXT_SIM = 0.8;
/** 短い方の文字のこの割合が、順序を保って長い方に含まれていれば「含まれる」 */
const CONTAINED_MIN = 0.9;
/**
 * 両方にこの文字数以上の文字があって中身が違えば、写真同士の判定でもまとめない（別のラベルが付いた別の写真）。
 * 6 章で「カメラ本体」と「粗微動ユニット」のラベルが付いた別の装置の写真が 0.53 でまとまり、片方が消えたため
 */
const VETO_MIN_CHARS = 4;
/**
 * 画素の差がこの割合以下で、文字が同じか一方に含まれるなら、同じスライドの途中の状態とみなす
 * （箇条書きが 1 行増えた、字幕が出かけている）。7 章で字幕の出かけの画像が Vision では 0.70 も離れていたため
 */
const GROWN_MAX_DIFF = 0.1;

/**
 * 画面を少しスクロール・パンしただけの組をまとめるための値（2026-09-20）。
 * アプリの操作画面（Illustrator のキャンバスをずらした）や Web ページ（少しスクロールした）は、中身が同じでも
 * 画素の 2〜3 割が変わり、Vision の距離も 0.21〜0.31 で「ごく近い」（0.2）をわずかに超える。細かい UI の文字は
 * 読み取りが安定しないので文字の規則にも掛からない。Vision の閾値を上げると、同じ型で本文が違うスライド
 * （0.23〜0.27）がまとまってしまうので、「違っている画素の大半が、同じ向きの平行移動で説明できる」ことを見る
 */
/** 平行移動を探す範囲（160×90 のサムネイルで。横 15%、縦 13%）。これより大きく動いたら別の画面として残す */
const PAN_MAX_DX = 24;
const PAN_MAX_DY = 12;
/**
 * 見た目の距離がこれ以下の組だけ調べる（11 章・10 章・GD I-2 の 5 組は 0.21〜0.31）。
 * ただし利用者が `--scene-vision-photo` を下げていたら、そちらを上限にする（この規則だけ勝手に広く見ないため）
 */
const PAN_MAX_VISION = 0.35;
/** 画素がこれ以上違う組だけ調べる。これ未満の違いは「中身が同じ」「途中の状態」の規則で先に決まる */
const PAN_MIN_DIFF = 0.1;
/** 平行移動で説明できずに残る画素が、違っている画素のこの割合以下なら同じ画面（5 組は 0.07〜0.36。本文が違うスライドは 0.43 以上） */
const PAN_MAX_LEFT_RATIO = 0.4;
/**
 * 平行移動で説明できた画素が、全体のこの割合以上あること（5 組は 0.13〜0.24）。
 * 少ししか動いていないのに中身が変わった組（10 章で腕の向きを変えた 039→040 は 0.04）と、
 * 白地が大半で本文だけ違うスライド（0.07 前後）を除くため
 */
const PAN_MIN_EXPLAINED = 0.1;

/**
 * 2 枚の違いが、画面の一部を平行移動しただけで説明できるかを調べる。
 * 違っている画素 p について a(p) = b(p+d) かつ b(p) = a(p-d) なら「説明できた」とする（片方だけだと、文字が
 * 白地に重なるだけで説明できたことになる）。縮小で 1 画素未満のずれが出るので、移動先の周り 1 画素のどれかに合えばよい。
 * ツールバーなど動かない部分は、もともと違っていないので数えない。
 * diff は違っている画素の割合、left は最もよく説明できた移動でも残った画素の割合
 */
export function panResidual(a: Uint8Array, b: Uint8Array): { diff: number; left: number; dx: number; dy: number } {
  const W = THUMB_WIDTH;
  const pixels = Math.min(W * THUMB_HEIGHT, Math.floor(Math.min(a.length, b.length) / 4));
  // 短い配列が来ても移動先を読み外さないよう、実際にある行数までにする（読み外すと差が NaN になり「合った」ことになる）
  const H = Math.floor(pixels / W);
  const changed: number[] = [];
  for (let p = 0; p < pixels; p++) if (pixelDiffers(a, p * 4, b, p * 4)) changed.push(p);
  if (pixels === 0 || changed.length === 0) return { diff: 0, left: 0, dx: 0, dy: 0 };
  /** src の画素 p が、dst の (cx, cy) の周り 1 画素のどれかと合うか */
  const near = (src: Uint8Array, dst: Uint8Array, p: number, cx: number, cy: number) => {
    for (let oy = -1; oy <= 1; oy++) {
      const y = cy + oy;
      if (y < 0 || y >= H) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const x = cx + ox;
        if (x >= 0 && x < W && !pixelDiffers(src, p * 4, dst, (y * W + x) * 4)) return true;
      }
    }
    return false;
  };
  let best = { dx: 0, dy: 0, left: changed.length };
  for (let dy = -PAN_MAX_DY; dy <= PAN_MAX_DY; dy++) {
    for (let dx = -PAN_MAX_DX; dx <= PAN_MAX_DX; dx++) {
      if (dx === 0 && dy === 0) continue;
      let left = 0;
      for (const p of changed) {
        const x = p % W;
        const y = (p - x) / W;
        if (!near(a, b, p, x + dx, y + dy) || !near(b, a, p, x - dx, y - dy)) {
          left++;
          if (left >= best.left) break; // これ以上よくならない移動は途中でやめる
        }
      }
      if (left < best.left) best = { dx, dy, left };
    }
  }
  return { diff: changed.length / pixels, left: best.left / pixels, dx: best.dx, dy: best.dy };
}

/**
 * 前の画面に戻っていた時間（動画の時刻で）がこれ未満なら、戻った画像は載せない（2026-09-20）。
 * 講師が A → B → A → B と行き来すると、切り替わりは全部本物なので 4 枚とも保存され、同じ 2 枚が 2 回並ぶ。
 * 比べる相手は最後に載せた画像だけなので、2 つ前と同じ画面でもまとまらなかった。
 * 27 講義で「2 つ前と同じ画面に戻った」64 件を見ると、戻っていた時間は 9.5 秒以下が 31 件、その次は 11 秒以上。
 * 9.5 秒以下の間に話しているのは長くて 90 字（1〜2 文）で、前の画像の下に入っても読むのに困らない。
 * 11 秒を超えるとその画面の説明が始まっている（「この矢印のデザインですね…」）ので、画像ごと残す
 */
const REVISIT_MAX_SECONDS = 10;

/**
 * 画面を大きくスクロールした組をまとめるための値（2026-09-22）。
 * panResidual は縦 12 画素（13%）までしか探さない。Web ページをカード 1 行分（25 画素前後）以上スクロールすると
 * 探索の外になるうえ、写真を含む画面は縮小で画素がぴったり合わず、探索を広げても「説明できた画素」は 3〜4 割にしか
 * 届かない（GD I-2 の 2 章 057→058→059）。そこで画素ではなく、行ごとの平均色の並びがどれだけずれた位置で重なるかを見る
 */
/** 探す縦のずれの上限（高さに対する割合）。重なりが半分を切ると根拠が薄い */
const SCROLL_MAX_SHIFT_RATIO = 0.5;
/**
 * これ未満のずれは「スクロール」とみなさない（小さな移動は 5b の平行移動の規則が見る）。同じ型の別スライドや、
 * カーソルが動いただけ・図が色から白黒に変わっただけの画面（12 章 GD の 005→006）は、ずれ 4 行前後で行が重なってしまう
 */
const SCROLL_MIN_SHIFT = 8;
/** 行の平均色の差（0〜255）がこれ以下なら同じ行とみなす。この差までは一致 1、超えるほど 0 に近づける */
const SCROLL_ROW_TOLERANCE = 16;
/**
 * 行の並びに凹凸があること（その画像の行の中央値から 16 以上離れた行が、この割合以上。2 枚の少ない方で見る）。
 * 白地に文字だけのスライドは行の平均色がほぼ白のままで、どんなずれでも行が重なってしまうため対象外にする。
 * 「地の色（中央値）から離れた行だけを数える」形も試したが、カードや写真が並ぶページでは中央値が地の色にならず、
 * 2 章の 057→058 のような本物のスクロールが 0.5 を切って拾えなくなったので、数えるのは重なった行の全部にした
 */
const SCROLL_MIN_STRUCTURE = 0.3;
/** 重なった行のうち色が合う行の割合がこれ以上なら同じ画面（2 章の 057→058 は 0.65、058→059 は 0.76、5 章の 028→030 は 0.95） */
const SCROLL_MIN_MATCH = 0.6;
/**
 * 見た目の距離がこれ以下の組だけ調べる（スクロールした組は 0.24〜0.34。図が増えた・白黒になった別の画面は 0.46 以上）。
 * 5b と同じく `--scene-vision-photo` を超えない
 */
const SCROLL_MAX_VISION = 0.4;
/** 両方に 3 行以上の文字があるとき、共通する行がこの割合を切れば別の画面（同じ配色の別のページ） */
const SCROLL_MIN_SHARED_LINES = 0.3;

/**
 * 2 枚を縦にずらして重ねたとき、行ごとの平均色がどれだけ合うか。
 * dy は a の行 y を b の行 y + dy に重ねるずれ（行）、match は重なった行のうち色が合う行の割合（差に応じて 0〜1）、
 * structure は 2 枚のうち凹凸の少ない方の、行の並びの凹凸（中央値から離れた行の割合）
 */
export function rowScroll(a: Uint8Array, b: Uint8Array): { dy: number; match: number; structure: number } {
  const W = THUMB_WIDTH;
  const pixels = Math.min(W * THUMB_HEIGHT, Math.floor(Math.min(a.length, b.length) / 4));
  const H = Math.floor(pixels / W);
  if (H === 0) return { dy: 0, match: 0, structure: 0 };
  const profile = (px: Uint8Array): Float64Array => {
    const out = new Float64Array(H * 3);
    for (let y = 0; y < H; y++) {
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        r += px[i]!;
        g += px[i + 1]!;
        bl += px[i + 2]!;
      }
      out[y * 3] = r / W;
      out[y * 3 + 1] = g / W;
      out[y * 3 + 2] = bl / W;
    }
    return out;
  };
  const rowDiff = (p: Float64Array, y: number, q: Float64Array, y2: number) =>
    (Math.abs(p[y * 3]! - q[y2 * 3]!) + Math.abs(p[y * 3 + 1]! - q[y2 * 3 + 1]!) + Math.abs(p[y * 3 + 2]! - q[y2 * 3 + 2]!)) / 3;
  /** 行の並びの凹凸: 行の中央値から離れた行の割合 */
  const structureOf = (p: Float64Array): number => {
    const median = new Float64Array(3);
    for (let c = 0; c < 3; c++) {
      const values = Array.from({ length: H }, (_, y) => p[y * 3 + c]!).sort((x, y) => x - y);
      median[c] = values[Math.floor(H / 2)]!;
    }
    let away = 0;
    for (let y = 0; y < H; y++) if (rowDiff(p, y, median, 0) > SCROLL_ROW_TOLERANCE) away++;
    return away / H;
  };
  const pa = profile(a);
  const pb = profile(b);
  const structure = Math.min(structureOf(pa), structureOf(pb));
  const maxShift = Math.floor(H * SCROLL_MAX_SHIFT_RATIO);
  let best = { dy: 0, match: 0 };
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    if (Math.abs(dy) < SCROLL_MIN_SHIFT) continue;
    let sum = 0;
    let n = 0;
    for (let y = 0; y < H; y++) {
      const y2 = y + dy;
      if (y2 < 0 || y2 >= H) continue;
      sum += Math.max(0, 1 - rowDiff(pa, y, pb, y2) / SCROLL_ROW_TOLERANCE);
      n++;
    }
    const match = n > 0 ? sum / n : 0;
    if (match > best.match) best = { dy, match };
  }
  return { ...best, structure };
}

/**
 * 同じ場面の続きを、切り替えの瞬間の変化の大きさで見分けるための値（2026-09-22）。
 * 拡張は保存した画像ごとに、切り替えを検知した瞬間の画素の変化率（trigger.diffPrev）を残す。写真・映像の画面で
 * この値が小さければ、カット（別の写真・別のショットへの切り替え）ではなく、同じショットの中でカメラや被写体が
 * 動いた・字幕が出た、ということ。色の分布の規則（同じ場面）は静止部分が半分未満の画像＝映像らしい画面にだけ
 * 効かせているが、ゆっくり動くカメラが静物を写していると静止部分が多く測られて外れる（「はじめに」の 014〜016。
 * 0.51〜0.83）。そこでこの値も入口にする。拡張の cutThreshold（0.3）と同じ線
 */
const SHOT_CUT_DIFF = 0.3;

/** ffmpeg で画像を 160×90 の RGBA に落とす。失敗したら null（判定を諦めるだけ） */
export async function readThumbnail(ffmpegBin: string, file: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  try {
    // -frames:v 1 で 1 枚だけ受け取る（動画を指してしまっても全フレーム分が流れてこないように）
    const r = await run(
      ffmpegBin,
      ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
      { binary: true, maxBytes: THUMB_WIDTH * THUMB_HEIGHT * 4 * 4, ...(signal ? { signal } : {}) },
    );
    if (r.code !== 0 || !r.stdoutBytes || r.stdoutBytes.length !== THUMB_WIDTH * THUMB_HEIGHT * 4) return null;
    return r.stdoutBytes;
  } catch {
    return null;
  }
}

/** 色の分布（RGB 各 8 段階）がどれだけそろっているか（0〜1）。拡張の ChangeDetector.colorMatch と同じ計算 */
export function colorMatch(a: Uint8Array, b: Uint8Array): number {
  const bins = COLOR_BINS ** 3;
  const step = Math.ceil(256 / COLOR_BINS);
  const ha = new Float64Array(bins);
  const hb = new Float64Array(bins);
  const n = Math.min(a.length, b.length);
  let pixels = 0;
  for (let i = 0; i + 3 < n; i += 4) {
    ha[Math.floor(a[i]! / step) * COLOR_BINS * COLOR_BINS + Math.floor(a[i + 1]! / step) * COLOR_BINS + Math.floor(a[i + 2]! / step)]!++;
    hb[Math.floor(b[i]! / step) * COLOR_BINS * COLOR_BINS + Math.floor(b[i + 1]! / step) * COLOR_BINS + Math.floor(b[i + 2]! / step)]!++;
    pixels++;
  }
  if (pixels === 0) return 1;
  let shared = 0;
  for (let k = 0; k < bins; k++) shared += Math.min(ha[k]!, hb[k]!);
  return shared / pixels;
}

/** 画素がどれだけ違うか（0〜1）。拡張の diffRatio と同じ計算 */
export function pixelDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  let changed = 0;
  let pixels = 0;
  for (let i = 0; i + 3 < n; i += 4) {
    pixels++;
    if (pixelDiffers(a, i, b, i)) changed++;
  }
  return pixels === 0 ? 0 : changed / pixels;
}

/** 色の分布の多様さ（ビット）。白地に文字のスライドは小さく、写真や映像は大きい */
export function colorEntropy(a: Uint8Array): number {
  const bins = COLOR_BINS ** 3;
  const step = Math.ceil(256 / COLOR_BINS);
  const h = new Float64Array(bins);
  let pixels = 0;
  for (let i = 0; i + 3 < a.length; i += 4) {
    h[Math.floor(a[i]! / step) * COLOR_BINS * COLOR_BINS + Math.floor(a[i + 1]! / step) * COLOR_BINS + Math.floor(a[i + 2]! / step)]!++;
    pixels++;
  }
  if (pixels === 0) return 0;
  let bits = 0;
  for (let k = 0; k < bins; k++) {
    if (h[k]! > 0) {
      const p = h[k]! / pixels;
      bits -= p * Math.log2(p);
    }
  }
  return bits;
}

/**
 * 文字認識の結果を比べやすくする。行を並べ替えてからつなぎ、空白を除いて 1 文字ずつに分ける
 * （同じ画面でも行の読まれる順は変わる。6 章では「ロゴ／字幕」と「字幕／ロゴ」で 0.06 になっていた）
 */
function normalizeText(text: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ''))
    .filter(Boolean)
    .sort();
  return [...lines.join('')];
}

function editDistance(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 文字のそろい具合（0〜1）。読み違いを許すため編集距離で測る。両方に文字がなければ undefined（比べられない） */
export function textSimilarity(a: string, b: string): number | undefined {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (x.length === 0 && y.length === 0) return undefined;
  if (x.length === 0 || y.length === 0) return 0;
  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

/** 短い方の文字が、順序を保って長い方にほぼ含まれるか（字幕の一部だけ読めた、箇条書きが 1 行増えた） */
export function textContained(a: string, b: string): boolean {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (x.length === 0 || y.length === 0) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  let i = 0;
  for (const ch of long) if (i < short.length && ch === short[i]) i++;
  return i / short.length >= CONTAINED_MIN;
}

/**
 * 読み取れた行のうち、相手にも（読み違いを許して 7 割合う形で）ある行の割合。少ない方の行数を分母にする。
 * スクロールした同じページは行の多くが共通し、同じ配色の別のページは見出しくらいしか共通しない。
 * どちらかの行が 3 行に満たなければ判断できないので undefined
 */
export function sharedLineRatio(a: string, b: string): number | undefined {
  const lines = (text: string) =>
    text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ''))
      .filter((line) => line.length >= 3)
      .map((line) => [...line]);
  const x = lines(a);
  const y = lines(b);
  if (x.length < 3 || y.length < 3) return undefined;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  let hit = 0;
  for (const s of short) {
    if (long.some((l) => 1 - editDistance(s, l) / Math.max(s.length, l.length) >= 0.7)) hit++;
  }
  return hit / short.length;
}

/** macOS の Vision で測った「見た目の距離」と「写っている文字」を使うときの設定 */
export type VisionOptions = {
  /** 画像の並び順（index）で距離を返す。測れない組は undefined */
  distance: (a: number, b: number) => number | undefined;
  /** これ以下なら、どんな画面でも同じとみなす（メニューを開いた・少しスクロールした程度） */
  tight: number;
  /** 両方が写真・映像（文字が違わない）なら、これ以下でも同じ場面とみなす（被写体が動いた程度）。文字が同じ画像同士もこの距離まで */
  photo: number;
  /** 画像に写っている文字（字幕・見出し）。読めなかった画像は undefined */
  text?: (index: number) => string | undefined;
};

export type SceneReason =
  | 'identical'
  | 'vision'
  | 'text'
  | 'grown'
  | 'panned'
  | 'scrolled'
  | 'same-scene'
  | 'revisit'
  | 'superseded';

export type SceneDecision = {
  filename: string;
  /** notes.md に載せるか */
  shown: boolean;
  /** 載せない場合、代わりに載っている画像 */
  sameSceneAs?: string;
  /**
   * 外した理由: 中身が同じ / 見た目が同じ（Vision） / 文字が同じで見た目も近い / 同じスライドの途中の状態 /
   * 少しスクロール・パンしただけ / 同じ場面（色の分布） / 前の画面に短く戻っただけ / 同じ場面の最後の 1 枚に譲った
   */
  reason?: SceneReason;
  /** 基準の画像ではなく直前の画像と比べて同じと判断したとき、その直前の画像 */
  via?: string;
  /** 載せる画像が、同じ場面の最初の画像の代わりであるとき、その最初の画像。発話の割り当てにはこちらの時刻を使う */
  standsFor?: string;
  /** 比べた画像との見た目の距離（Vision。0 に近いほど似ている） */
  vision?: number;
  /** 比べた画像との色の一致（判定の材料） */
  colorMatch?: number;
  /** 比べた画像との画素の差 */
  pixelDiff?: number;
  /** 比べた画像との文字のそろい具合（0〜1）。両方に文字がなければ付かない */
  textSim?: number;
  /** 平行移動を調べたとき: 説明できずに残った画素の割合と、最もよく説明できた移動（160×90 の画素で） */
  panLeft?: number;
  panShift?: [number, number];
  /** 縦のスクロールを調べたとき: 比べた画像を何行ずらすと重なるか（下にスクロールした画面なら正）と、そのときの一致（0〜1） */
  scrollShift?: number;
  scrollMatch?: number;
  /** 両方に 3 行以上の文字があったとき、共通する行の割合 */
  sharedLines?: number;
};

type Metrics = Pick<
  SceneDecision,
  'vision' | 'colorMatch' | 'pixelDiff' | 'textSim' | 'panLeft' | 'panShift' | 'scrollShift' | 'scrollMatch' | 'sharedLines'
>;
type Verdict = { reason?: SceneReason; metrics: Metrics };

/**
 * 順に見て、最後に載せた画像と「同じ」なら載せない。基準の画像とは離れてしまっても、
 * 直前の（外した）画像と強い根拠で同じなら、場面が少しずつ変わっているだけとみなして外す。
 * さらに前の（外した）画像とも、文字を使わない根拠（中身が同じ・見た目がごく近い）だけで比べる
 * （講師が動く画面で、2 つ前の画像とは 0.145 なのに直前とは 0.27 だった。2026-09-17）。
 * サムネイルが取れなかった画像は載せる。
 */
export function pickShownSlides(
  slides: readonly SlideEntry[],
  thumbs: ReadonlyMap<string, Uint8Array>,
  threshold: number,
  vision?: VisionOptions,
  /** 同じ場面が続いたとき、最初と最後のどちらの画像を載せるか。既定は最後（切り替わる直前の状態） */
  keep: 'first' | 'last' = 'last',
): SceneDecision[] {
  const decisions: SceneDecision[] = [];
  let lastShown: { slide: SlideEntry; index: number } | null = null;
  const entropyOf = new Map<string, number>();
  const entropy = (filename: string, thumb: Uint8Array) => {
    let e = entropyOf.get(filename);
    if (e === undefined) {
      e = colorEntropy(thumb);
      entropyOf.set(filename, e);
    }
    return e;
  };
  /**
   * 基準の画像の文字が、まとまりの中で安定して読めているか。手書きの板書は読み取りが毎回変わり
   * （同じ板書が BAsceT / EAsckET / 54SsceT と読まれた）、そのたびに「別のラベルの別の写真」と
   * 誤って残していた。まとまりに加えた画像の文字が基準と食い違ったら、その場面では文字を拒否の根拠にしない
   */
  let anchorTextStable = true;
  /** 1 つ前のまとまり（基準の画像と、最後に加えた画像）。前の画面に短く戻っただけの画像を見分けるのに使う */
  let previousGroup: { first: number; last: number } | null = null;
  /** 今のまとまりに最後に加えた画像 */
  let lastInGroup = 0;
  /** 「前の画面に短く戻っただけ」として外した画像。まとまりの最後の 1 枚には選ばない */
  const revisits = new Set<number>();
  /**
   * 今つながっている「戻り」の、最初の画像の動画時刻。戻りが途切れたら null。
   * 1 枚ずつの「この画面が続いた時間」だけで決めると、戻っている間に画面が少しずつ変わる（注釈を書く、
   * 少しスクロールする）ときに、どの 1 枚も 10 秒未満で外れ続け、長い戻りなのに画像が 1 枚も残らない
   */
  let revisitStart: number | null = null;
  /** つながった戻りがまだ REVISIT_MAX_SECONDS 未満か（伸びたら、そこからは新しい画面として載せる） */
  const revisitRunShort = (index: number): boolean => {
    if (revisitStart === null) return true;
    const elapsed = slides[index]!.videoTime - revisitStart;
    // 巻き戻っている（シークした）ときは長さが分からないので、戻りを打ち切って載せる
    return elapsed >= 0 && elapsed < REVISIT_MAX_SECONDS;
  };
  /**
   * index の画像を against の画像と比べる。strongOnly なら、間違えにくいルール
   * （中身が同じ・見た目がごく近い・文字が同じ・途中の状態）だけで判断する。
   * tightOnly なら、そのうち文字を使わないもの（中身が同じ・見た目がごく近い）だけ。
   * 同じ型のスライドは見出しやフッターの文字が共通なので、文字の規則を遠くの画像まで広げると別のスライドがまとまる
   */
  const compare = (index: number, against: number, strongOnly: boolean, tightOnly = false): Verdict | null => {
    const slide = slides[index]!;
    const other = slides[against]!;
    const thumb = thumbs.get(slide.filename);
    const otherThumb = thumbs.get(other.filename);
    if (!thumb || !otherThumb) return null;
    const diff = pixelDiff(thumb, otherThumb);
    const d = vision?.distance(index, against);
    const text = vision?.text?.(index);
    const otherText = vision?.text?.(against);
    const hasText = text !== undefined && otherText !== undefined;
    const textSim = hasText ? textSimilarity(text, otherText) : undefined;
    const metrics: Metrics = { pixelDiff: round(diff), ...(d !== undefined ? { vision: round(d) } : {}), ...(textSim !== undefined ? { textSim: round(textSim) } : {}) };
    // 1. 中身が同じ画像は、スライドでも映像でも外す（拡張の取りこぼしの受け皿）
    if (diff <= IDENTICAL_MAX_DIFF) return { reason: 'identical', metrics };
    if (vision && d !== undefined) {
      // 2. 見た目の距離（Vision）。メニューを開いた・少しスクロールした程度ならどんな画面でも同じ
      if (vision.tight > 0 && d <= vision.tight) return { reason: 'vision', metrics };
      if (tightOnly) return { metrics };
      if (vision.photo > 0 && d <= vision.photo) {
        // 3. 字幕や見出しの文字が同じ（両方に文字がない場合や、一方が他方に含まれる場合も）で見た目も近ければ、同じ場面。
        //    同じテンプレートで文字だけ違うスライドはここで残る
        // 「含まれる」は短い読み取り（「図1」など）だと偶然当たるので、両方に VETO_MIN_CHARS 以上あるときだけ認める
        const contained =
          hasText &&
          normalizeText(text).length >= VETO_MIN_CHARS &&
          normalizeText(otherText).length >= VETO_MIN_CHARS &&
          textContained(text, otherText);
        // 両方に文字がない（textSim が undefined）だけの一致は弱い根拠なので、直前の画像との比較には使わない。
        // 使うと、少しずつ違う無地の画像が数珠つなぎになり、基準の画像からいくらでも離れてしまう
        const sameText = textSim === undefined ? !strongOnly : textSim >= SAME_TEXT_SIM || contained;
        if (hasText && sameText) return { reason: 'text', metrics };
        // 4. 写真や映像なら、被写体が動いた程度までを同じ場面とみなす。
        //    ただし両方に文字があって中身が違うなら、別のラベルが付いた別の写真なのでまとめない
        const bothPhoto = entropy(slide.filename, thumb) >= PHOTO_ENTROPY_BITS && entropy(other.filename, otherThumb) >= PHOTO_ENTROPY_BITS;
        const differentText = anchorTextStable && hasText && normalizeText(text).length >= VETO_MIN_CHARS && normalizeText(otherText).length >= VETO_MIN_CHARS && !contained;
        if (!strongOnly && bothPhoto && !differentText) return { reason: 'vision', metrics };
      }
    }
    if (tightOnly) return { metrics };
    // 5. 画素がほとんど同じで文字が同じか一方に含まれるなら、同じスライドの途中の状態
    if (diff <= GROWN_MAX_DIFF && hasText && text && otherText && (textSim! >= SAME_TEXT_SIM || textContained(text, otherText))) {
      return { reason: 'grown', metrics };
    }
    if (strongOnly) return { metrics };
    // 5b. 画面を少しスクロール・パンしただけ（違っている画素の大半が、同じ向きの平行移動で説明できる）。
    //     基準の画像とだけ比べる。直前の画像とも比べると、長いページを少しずつスクロールした全部が 1 枚にまとまり、
    //     最後の画面しか残らない。基準とだけなら、動いた量が探す範囲（横 15%、縦 13%）を超えたところで次の 1 枚が残る
    //     見る範囲は `--scene-vision-photo` を超えない（利用者が閾値を下げた・0 にしたのに、この規則だけ広く見ないため）
    if (vision && d !== undefined && vision.photo > 0 && d <= Math.min(PAN_MAX_VISION, vision.photo) && diff >= PAN_MIN_DIFF) {
      const pan = panResidual(thumb, otherThumb);
      metrics.panLeft = round(pan.left);
      // どの移動でも 1 画素も説明できなかったときの (0, 0) は「見つかった移動」ではないので残さない
      if (pan.left < pan.diff) metrics.panShift = [pan.dx, pan.dy];
      if (pan.left <= pan.diff * PAN_MAX_LEFT_RATIO && pan.diff - pan.left >= PAN_MIN_EXPLAINED) return { reason: 'panned', metrics };
    }
    // 5c. 大きく縦にスクロールしただけ（行ごとの色の並びが、ずれた位置で重なる）。基準の画像とだけ比べる（5b と同じ理由）。
    //     白地に文字だけの画面は行に凹凸がなく判断できないので対象外。
    //     両方に読める文字が 3 行以上あって共通する行が少なければ、同じ配色の別のページなので残す
    if (vision && d !== undefined && vision.photo > 0 && d <= Math.min(SCROLL_MAX_VISION, vision.photo) && diff >= PAN_MIN_DIFF) {
      const shared = hasText ? sharedLineRatio(text, otherText) : undefined;
      if (shared !== undefined) metrics.sharedLines = round(shared);
      if (shared === undefined || shared >= SCROLL_MIN_SHARED_LINES) {
        const scroll = rowScroll(thumb, otherThumb);
        if (scroll.structure >= SCROLL_MIN_STRUCTURE) {
          metrics.scrollShift = scroll.dy;
          metrics.scrollMatch = round(scroll.match);
          if (scroll.match >= SCROLL_MIN_MATCH) return { reason: 'scrolled', metrics };
        }
      }
    }
    // 6. 映像中心の画面では、色の分布が同じなら同じ場面。
    //    写真・映像らしい画面（色の多様さ）で、切り替えの瞬間の変化が小さかった（カットではなく、同じショットの中で
    //    カメラや被写体が動いた・字幕が出た）画像も、色の分布で見る。ただし両方に文字があって中身が違えば別の場面
    const stillFraction = slide.trigger?.stillFraction;
    const footage = typeof stillFraction === 'number' && stillFraction < FOOTAGE_MAX_STILL;
    const cutDiff = slide.trigger?.diffPrev;
    const sameShot =
      typeof cutDiff === 'number' &&
      cutDiff < SHOT_CUT_DIFF &&
      entropy(slide.filename, thumb) >= PHOTO_ENTROPY_BITS &&
      entropy(other.filename, otherThumb) >= PHOTO_ENTROPY_BITS &&
      !(hasText && normalizeText(text).length >= VETO_MIN_CHARS && normalizeText(otherText).length >= VETO_MIN_CHARS && textSim! < SAME_TEXT_SIM && !textContained(text, otherText));
    if (threshold > 0 && (footage || sameShot)) {
      const match = colorMatch(thumb, otherThumb);
      metrics.colorMatch = round(match);
      if (match >= threshold) return { reason: 'same-scene', metrics };
    }
    return { metrics };
  };
  /**
   * index の画面がそのまま続いた時間（動画の時刻で、秒）。次に少しでも違う画面が撮られるまで。
   * 「同じ」は文字を使わない間違えにくい規則（中身が同じ・見た目がごく近い）だけで決める。戻った先で何か操作して
   * 画面が変わったなら、そこからは新しい画面として扱いたいため。
   * 最後まで続いた、または時刻が巻き戻っている（シークした）ときは分からないので undefined
   */
  const sceneSeconds = (index: number): number | undefined => {
    for (let j = index + 1; j < slides.length; j++) {
      const v = compare(j, index, true, true);
      // サムネイルが読めない画像は「同じ」とも「違う」とも言えない。そこで測るのをやめる（載せる側に倒す）
      if (v === null) return undefined;
      if (v.reason) continue;
      const seconds = slides[j]!.videoTime - slides[index]!.videoTime;
      return seconds >= 0 ? seconds : undefined;
    }
    return undefined;
  };
  /**
   * index の画像が、1 つ前のまとまりの画面（基準か、最後に加えた画像）と今も同じか。
   * 同じ画面かどうかは、文字を使わない間違えにくい規則（中身が同じ・見た目がごく近い）だけで決める
   */
  const matchPreviousGroup = (index: number): { verdict: Verdict; to: number } | null => {
    if (!previousGroup) return null;
    for (const to of new Set([previousGroup.last, previousGroup.first])) {
      const verdict = compare(index, to, true, true);
      if (verdict?.reason) return { verdict, to };
    }
    return null;
  };
  /** 1 つ前のまとまりの画面に戻っただけで、すぐ（REVISIT_MAX_SECONDS 未満で）また離れるか */
  const briefRevisit = (index: number): { verdict: Verdict; to: number } | null => {
    const match = matchPreviousGroup(index);
    if (!match) return null;
    const seconds = sceneSeconds(index);
    return seconds !== undefined && seconds < REVISIT_MAX_SECONDS ? match : null;
  };
  slides.forEach((slide, index) => {
    if (lastShown) {
      const last = lastShown;
      let verdict = compare(index, last.index, false);
      let via: string | undefined;
      let viaRevisit = false;
      if (verdict && !verdict.reason) {
        // 基準と同じでなければ、まとまりに入れた画像（直前から順に前へ）とも比べる
        for (let j = index - 1; j > last.index; j--) {
          // 短く戻っただけの画像（revisits）は今のまとまりの画面ではない。直前の 1 枚のときだけ、戻っている間の続きかを
          // 文字を使わない規則で見る（戻った先で操作して変わった画面は、新しい画面として残す）。それより前の戻りは飛ばす
          // （あとでもう一度、今度は長く戻ったときに、前の短い戻りに引きずられて外れないように）
          if (revisits.has(j) && j !== index - 1) continue;
          const member = compare(index, j, true, j !== index - 1 || revisits.has(j));
          if (member?.reason) {
            verdict = member;
            via = slides[j]!.filename;
            viaRevisit = revisits.has(j);
            break;
          }
        }
      }
      if (verdict && !verdict.reason) {
        // 前の画面に短く戻っただけなら載せない。間の発話は、今載っている画像の下に入る
        const revisit = revisitRunShort(index) ? briefRevisit(index) : null;
        if (revisit) {
          revisits.add(index);
          revisitStart ??= slide.videoTime;
          // via には戻った先の画像を残す
          decisions.push({ filename: slide.filename, shown: false, sameSceneAs: last.slide.filename, reason: 'revisit', via: slides[revisit.to]!.filename, ...revisit.verdict.metrics });
          return;
        }
      }
      if (verdict?.reason && viaRevisit) {
        // 短く戻っていた間に撮れた続きの画像。戻った先の画面と今も同じなら、戻った画像と同じ扱いにする
        // （今のまとまりの 1 枚として載せない）。直前の 1 枚とだけ比べて連ねると、画面が少しずつ変わっていく間
        // ずっと外れ続けて、その区間の画像が 1 枚も残らない（戻った先とは似ても似つかない画像まで外れる）
        if (revisitRunShort(index) && matchPreviousGroup(index)) {
          revisits.add(index);
          revisitStart ??= slide.videoTime;
          decisions.push({ filename: slide.filename, shown: false, sameSceneAs: last.slide.filename, reason: 'revisit', ...(via ? { via } : {}), ...verdict.metrics });
          return;
        }
        // 戻った先から離れた＝新しい画面。今のまとまりに入れず、載せる（via は以降読まれない）
        verdict = { metrics: verdict.metrics };
      }
      if (verdict?.reason) {
        lastInGroup = index;
        revisitStart = null;
        decisions.push({ filename: slide.filename, shown: false, sameSceneAs: last.slide.filename, reason: verdict.reason, ...(via ? { via } : {}), ...verdict.metrics });
        const text = vision?.text?.(index);
        const anchorText = vision?.text?.(last.index);
        if (text && anchorText && (textSimilarity(text, anchorText) ?? 1) < SAME_TEXT_SIM && !textContained(text, anchorText)) anchorTextStable = false;
        return;
      }
      decisions.push({ filename: slide.filename, shown: true, ...verdict?.metrics });
      revisitStart = null;
      // サムネイルが読めなかった画像を基準にすると、以後すべての比較ができなくなる。前の基準を残す
      if (verdict) {
        previousGroup = { first: last.index, last: lastInGroup };
        lastShown = { slide, index };
        lastInGroup = index;
        anchorTextStable = true;
      }
    } else {
      decisions.push({ filename: slide.filename, shown: true });
      lastShown = { slide, index };
      lastInGroup = index;
    }
  });
  return keep === 'last' ? preferLast(decisions) : decisions;
}

/**
 * 同じ場面のまとまりごとに、最初の画像（比較の基準）ではなく最後の画像を載せる。
 * 発話の割り当ては最初の画像の時刻で行うので、載せる画像に standsFor を付けて基準を指す
 */
function preferLast(decisions: SceneDecision[]): SceneDecision[] {
  const byName = new Map(decisions.map((d) => [d.filename, d]));
  const lastMember = new Map<string, SceneDecision>();
  for (const d of decisions) {
    // 前の画面に短く戻っただけの画像は別の画面なので、まとまりの最後の 1 枚には選ばない
    if (!d.shown && d.reason !== 'revisit' && d.sameSceneAs && byName.get(d.sameSceneAs)?.shown) lastMember.set(d.sameSceneAs, d);
  }
  for (const [anchorName, last] of lastMember) {
    const anchor = byName.get(anchorName)!;
    // まとまりの全員（基準・途中の画像）が、実際に載る画像を指すようにする
    for (const d of decisions) {
      if (!d.shown && d.sameSceneAs === anchorName && d !== last) d.sameSceneAs = last.filename;
    }
    anchor.shown = false;
    anchor.reason = 'superseded';
    anchor.sameSceneAs = last.filename;
    last.shown = true;
    last.standsFor = anchorName;
    delete last.reason;
    delete last.sameSceneAs;
  }
  return decisions;
}

/**
 * 載せる画像の並び。最後の画像を載せる場合は、その画像に最初の画像の時刻・理由を持たせる
 * （発話は「そのスライドが映り始めた時刻」で割り当てるため）
 */
export function shownSlides(slides: readonly SlideEntry[], decisions: readonly SceneDecision[]): SlideEntry[] {
  const byName = new Map(slides.map((s) => [s.filename, s]));
  const out: SlideEntry[] = [];
  for (const d of decisions) {
    if (!d.shown) continue;
    const self = byName.get(d.filename);
    if (!self) continue;
    const anchor = d.standsFor ? byName.get(d.standsFor) : undefined;
    out.push(anchor ? { ...anchor, filename: self.filename, seq: self.seq, width: self.width, height: self.height } : self);
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
