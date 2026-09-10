import { run } from './exec.ts';
import type { SlideEntry } from './merge.ts';

/**
 * 同じ場面の画像を notes.md に並べない（SPEC §13.4b）。
 *
 * 映像を追っているカメラは被写体が動くだけで画素が大きく変わるので、拡張の変化検知は
 * 同じ場面を何枚も撮る。ここでは保存済みの画像を全部見たうえで、色の分布が最後に載せた
 * 画像とそろっているものを「同じ場面」として notes.md / lecture.md から外す。
 * 画像そのものは slides/ に残す。
 *
 * 判定は拡張が記録した trigger.stillFraction（動き続けている画素を除いた静止部分の割合）が
 * 半分未満の画像＝映像中心の画面にだけ効かせる。スライド中心の画面では、同じ配色で文字だけ
 * 違うスライドが「同じ場面」に見えてしまうため。
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
/** 色の多様さ（ビット）がこれ以上なら写真・映像とみなし、Vision の判定を広めに使う。文字中心のスライドは 0〜3 */
const PHOTO_ENTROPY_BITS = 3.0;

/** ffmpeg で画像を 160×90 の RGBA に落とす。失敗したら null（判定を諦めるだけ） */
export async function readThumbnail(ffmpegBin: string, file: string): Promise<Uint8Array | null> {
  try {
    const r = await run(ffmpegBin, ['-v', 'error', '-i', file, '-vf', `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { binary: true });
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
    const dr = a[i]! - b[i]!;
    const dg = a[i + 1]! - b[i + 1]!;
    const db = a[i + 2]! - b[i + 2]!;
    if (dr >= PIXEL_DIFF || -dr >= PIXEL_DIFF || dg >= PIXEL_DIFF || -dg >= PIXEL_DIFF || db >= PIXEL_DIFF || -db >= PIXEL_DIFF) changed++;
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

/** macOS の Vision で測った「見た目の距離」を使うときの設定 */
export type VisionOptions = {
  /** 画像の並び順（index）で距離を返す。測れない組は undefined */
  distance: (a: number, b: number) => number | undefined;
  /** これ以下なら、どんな画面でも同じとみなす（メニューを開いた・少しスクロールした程度） */
  tight: number;
  /** 両方が写真・映像なら、これ以下でも同じ場面とみなす（被写体が動いた程度） */
  photo: number;
};

export type SceneDecision = {
  filename: string;
  /** notes.md に載せるか */
  shown: boolean;
  /** 載せない場合、代わりに載っている画像 */
  sameSceneAs?: string;
  /** 外した理由: 中身が同じ / 見た目が同じ（Vision） / 同じ場面（色の分布） / 同じ場面の最後の 1 枚に譲った */
  reason?: 'identical' | 'vision' | 'same-scene' | 'superseded';
  /** 載せる画像が、同じ場面の最初の画像の代わりであるとき、その最初の画像。発話の割り当てにはこちらの時刻を使う */
  standsFor?: string;
  /** 最後に載せた画像との見た目の距離（Vision。0 に近いほど似ている） */
  vision?: number;
  /** 最後に載せた画像との色の一致（判定の材料） */
  colorMatch?: number;
  /** 最後に載せた画像との画素の差 */
  pixelDiff?: number;
};

/**
 * 順に見て、最後に載せた画像と「同じ場面」なら載せない。
 * 映像中心の画面（trigger.stillFraction が半分未満）で、色の一致が threshold 以上のときだけ。
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
  slides.forEach((slide, index) => {
    const thumb = thumbs.get(slide.filename);
    const lastThumb = lastShown ? thumbs.get(lastShown.slide.filename) : undefined;
    const footage = typeof slide.trigger?.stillFraction === 'number' && slide.trigger.stillFraction < FOOTAGE_MAX_STILL;
    if (thumb && lastThumb && lastShown) {
      const last = lastShown;
      const diff = pixelDiff(thumb, lastThumb);
      const base = { filename: slide.filename, sameSceneAs: last.slide.filename, pixelDiff: round(diff) };
      // 1. 中身が同じ画像は、スライドでも映像でも外す（拡張の取りこぼしの受け皿）
      if (diff <= IDENTICAL_MAX_DIFF) {
        decisions.push({ ...base, shown: false, reason: 'identical' });
        return;
      }
      // 2. 見た目の距離（Vision）。メニューを開いた・少しスクロールした程度ならどんな画面でも同じ。
      //    写真や映像なら、被写体が動いた程度までを同じ場面とみなす
      const d = vision?.distance(index, last.index);
      if (vision && d !== undefined) {
        const bothPhoto = entropy(slide.filename, thumb) >= PHOTO_ENTROPY_BITS && entropy(last.slide.filename, lastThumb) >= PHOTO_ENTROPY_BITS;
        if ((vision.tight > 0 && d <= vision.tight) || (vision.photo > 0 && bothPhoto && d <= vision.photo)) {
          decisions.push({ ...base, shown: false, reason: 'vision', vision: round(d) });
          return;
        }
      }
      // 3. 映像中心の画面では、色の分布が同じなら同じ場面
      const match = threshold > 0 && footage ? colorMatch(thumb, lastThumb) : undefined;
      if (match !== undefined && match >= threshold) {
        decisions.push({ ...base, shown: false, reason: 'same-scene', colorMatch: round(match) });
        return;
      }
      decisions.push({
        filename: slide.filename,
        shown: true,
        ...(match !== undefined ? { colorMatch: round(match) } : {}),
        ...(d !== undefined ? { vision: round(d) } : {}),
        pixelDiff: round(diff),
      });
    } else {
      decisions.push({ filename: slide.filename, shown: true });
    }
    lastShown = { slide, index };
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
    if (!d.shown && d.sameSceneAs && byName.get(d.sameSceneAs)?.shown) lastMember.set(d.sameSceneAs, d);
  }
  for (const [anchorName, last] of lastMember) {
    const anchor = byName.get(anchorName)!;
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
