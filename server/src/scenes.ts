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

export type SceneDecision = {
  filename: string;
  /** notes.md に載せるか */
  shown: boolean;
  /** 載せない場合、代わりに載っている画像 */
  sameSceneAs?: string;
  /** 外した理由: 中身が同じ / 同じ場面 */
  reason?: 'identical' | 'same-scene';
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
): SceneDecision[] {
  const decisions: SceneDecision[] = [];
  let lastShown: SlideEntry | null = null;
  for (const slide of slides) {
    const thumb = thumbs.get(slide.filename);
    const lastThumb = lastShown ? thumbs.get(lastShown.filename) : undefined;
    const footage = typeof slide.trigger?.stillFraction === 'number' && slide.trigger.stillFraction < FOOTAGE_MAX_STILL;
    if (thumb && lastThumb && lastShown) {
      const diff = pixelDiff(thumb, lastThumb);
      // 中身が同じ画像は、スライドでも映像でも外す（拡張の取りこぼしの受け皿）
      if (diff <= IDENTICAL_MAX_DIFF) {
        decisions.push({ filename: slide.filename, shown: false, sameSceneAs: lastShown.filename, reason: 'identical', pixelDiff: round(diff) });
        continue;
      }
      const match = threshold > 0 && footage ? colorMatch(thumb, lastThumb) : undefined;
      if (match !== undefined && match >= threshold) {
        decisions.push({ filename: slide.filename, shown: false, sameSceneAs: lastShown.filename, reason: 'same-scene', colorMatch: round(match), pixelDiff: round(diff) });
        continue;
      }
      decisions.push({ filename: slide.filename, shown: true, ...(match !== undefined ? { colorMatch: round(match) } : {}), pixelDiff: round(diff) });
    } else {
      decisions.push({ filename: slide.filename, shown: true });
    }
    lastShown = slide;
  }
  return decisions;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
