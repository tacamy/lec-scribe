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
 * 色の分布。色の分布は拡張が記録した trigger.stillFraction（動き続けている画素を除いた
 * 静止部分の割合）が半分未満の画像＝映像中心の画面にだけ効かせる。スライド中心の画面では、
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
/** 色の多様さ（ビット）がこれ以上なら写真・映像とみなし、Vision の判定を広めに使う。文字中心のスライドは 0〜3 */
const PHOTO_ENTROPY_BITS = 3.0;
/** 文字のそろい具合がこれ以上なら同じ文字とみなす（文字認識の読み違いを許す） */
const SAME_TEXT_SIM = 0.8;
/** 短い方の文字のこの割合が、順序を保って長い方に含まれていれば「含まれる」 */
const CONTAINED_MIN = 0.9;
/**
 * 画素の差がこの割合以下で、文字が同じか一方に含まれるなら、同じスライドの途中の状態とみなす
 * （箇条書きが 1 行増えた、字幕が出かけている）。7 章で字幕の出かけの画像が Vision では 0.70 も離れていたため
 */
const GROWN_MAX_DIFF = 0.1;

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

/** 文字認識の結果を比べやすくする（空白と改行を除き、1 文字ずつに分ける） */
function normalizeText(text: string): string[] {
  return [...text.replace(/\s+/g, '')];
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

/** macOS の Vision で測った「見た目の距離」と「写っている文字」を使うときの設定 */
export type VisionOptions = {
  /** 画像の並び順（index）で距離を返す。測れない組は undefined */
  distance: (a: number, b: number) => number | undefined;
  /** これ以下なら、どんな画面でも同じとみなす（メニューを開いた・少しスクロールした程度） */
  tight: number;
  /** 両方が写真・映像なら、これ以下でも同じ場面とみなす（被写体が動いた程度）。文字が同じ画像同士もこの距離まで */
  photo: number;
  /** 画像に写っている文字（字幕・見出し）。読めなかった画像は undefined */
  text?: (index: number) => string | undefined;
};

export type SceneReason = 'identical' | 'vision' | 'text' | 'grown' | 'same-scene' | 'superseded';

export type SceneDecision = {
  filename: string;
  /** notes.md に載せるか */
  shown: boolean;
  /** 載せない場合、代わりに載っている画像 */
  sameSceneAs?: string;
  /**
   * 外した理由: 中身が同じ / 見た目が同じ（Vision） / 文字が同じで見た目も近い / 同じスライドの途中の状態 /
   * 同じ場面（色の分布） / 同じ場面の最後の 1 枚に譲った
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
};

type Metrics = Pick<SceneDecision, 'vision' | 'colorMatch' | 'pixelDiff' | 'textSim'>;
type Verdict = { reason?: SceneReason; metrics: Metrics };

/**
 * 順に見て、最後に載せた画像と「同じ」なら載せない。基準の画像とは離れてしまっても、
 * 直前の（外した）画像と強い根拠で同じなら、場面が少しずつ変わっているだけとみなして外す。
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
   * index の画像を against の画像と比べる。strongOnly なら、間違えにくいルール
   * （中身が同じ・見た目がごく近い・文字が同じ・途中の状態）だけで判断する
   */
  const compare = (index: number, against: number, strongOnly: boolean): Verdict | null => {
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
      if (vision.photo > 0 && d <= vision.photo) {
        // 3. 字幕や見出しの文字が同じ（両方に文字がない場合も含む）で見た目も近ければ、同じ場面。
        //    同じテンプレートで文字だけ違うスライドはここで残る
        if (hasText && (textSim === undefined || textSim >= SAME_TEXT_SIM)) return { reason: 'text', metrics };
        // 4. 写真や映像なら、被写体が動いた程度までを同じ場面とみなす
        const bothPhoto = entropy(slide.filename, thumb) >= PHOTO_ENTROPY_BITS && entropy(other.filename, otherThumb) >= PHOTO_ENTROPY_BITS;
        if (!strongOnly && bothPhoto) return { reason: 'vision', metrics };
      }
    }
    // 5. 画素がほとんど同じで文字が同じか一方に含まれるなら、同じスライドの途中の状態
    if (diff <= GROWN_MAX_DIFF && hasText && text && otherText && (textSim! >= SAME_TEXT_SIM || textContained(text, otherText))) {
      return { reason: 'grown', metrics };
    }
    if (strongOnly) return { metrics };
    // 6. 映像中心の画面では、色の分布が同じなら同じ場面
    const footage = typeof slide.trigger?.stillFraction === 'number' && slide.trigger.stillFraction < FOOTAGE_MAX_STILL;
    if (threshold > 0 && footage) {
      const match = colorMatch(thumb, otherThumb);
      metrics.colorMatch = round(match);
      if (match >= threshold) return { reason: 'same-scene', metrics };
    }
    return { metrics };
  };
  slides.forEach((slide, index) => {
    if (lastShown) {
      const last = lastShown;
      let verdict = compare(index, last.index, false);
      let via: string | undefined;
      if (verdict && !verdict.reason && index - 1 !== last.index) {
        const previous = compare(index, index - 1, true);
        if (previous?.reason) {
          verdict = previous;
          via = slides[index - 1]!.filename;
        }
      }
      if (verdict?.reason) {
        decisions.push({ filename: slide.filename, shown: false, sameSceneAs: last.slide.filename, reason: verdict.reason, ...(via ? { via } : {}), ...verdict.metrics });
        return;
      }
      decisions.push({ filename: slide.filename, shown: true, ...verdict?.metrics });
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
