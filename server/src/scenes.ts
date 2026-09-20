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

export type SceneReason = 'identical' | 'vision' | 'text' | 'grown' | 'panned' | 'same-scene' | 'superseded';

export type SceneDecision = {
  filename: string;
  /** notes.md に載せるか */
  shown: boolean;
  /** 載せない場合、代わりに載っている画像 */
  sameSceneAs?: string;
  /**
   * 外した理由: 中身が同じ / 見た目が同じ（Vision） / 文字が同じで見た目も近い / 同じスライドの途中の状態 /
   * 少しスクロール・パンしただけ / 同じ場面（色の分布） / 同じ場面の最後の 1 枚に譲った
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
};

type Metrics = Pick<SceneDecision, 'vision' | 'colorMatch' | 'pixelDiff' | 'textSim' | 'panLeft' | 'panShift'>;
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
      if (verdict && !verdict.reason) {
        // 基準と同じでなければ、まとまりに入れた画像（直前から順に前へ）とも比べる
        for (let j = index - 1; j > last.index; j--) {
          const member = compare(index, j, true, j !== index - 1);
          if (member?.reason) {
            verdict = member;
            via = slides[j]!.filename;
            break;
          }
        }
      }
      if (verdict?.reason) {
        decisions.push({ filename: slide.filename, shown: false, sameSceneAs: last.slide.filename, reason: verdict.reason, ...(via ? { via } : {}), ...verdict.metrics });
        const text = vision?.text?.(index);
        const anchorText = vision?.text?.(last.index);
        if (text && anchorText && (textSimilarity(text, anchorText) ?? 1) < SAME_TEXT_SIM && !textContained(text, anchorText)) anchorTextStable = false;
        return;
      }
      decisions.push({ filename: slide.filename, shown: true, ...verdict?.metrics });
      // サムネイルが読めなかった画像を基準にすると、以後すべての比較ができなくなる。前の基準を残す
      if (verdict) {
        lastShown = { slide, index };
        anchorTextStable = true;
      }
    } else {
      decisions.push({ filename: slide.filename, shown: true });
      lastShown = { slide, index };
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
    if (!d.shown && d.sameSceneAs && byName.get(d.sameSceneAs)?.shown) lastMember.set(d.sameSceneAs, d);
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
