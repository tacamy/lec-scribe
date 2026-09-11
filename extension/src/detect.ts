import type { Config } from './config';

/**
 * 画面変化の検知（SPEC §9）。
 *
 * 縮小した RGBA 画像同士を比べ、「大きく変わった → 数サンプル安定した →
 * 最後に保存した画像とも違う」ときだけ保存を指示する。DOM に触らない純粋な
 * ロジックなので Vitest で閾値の挙動を確かめられる。
 *
 * 画素の比較は RGB 各チャンネルの差の最大値で行う。グレースケール（輝度）だけだと
 * カラー → モノクロのように輝度が変わらない切り替えを見逃すため。
 */
export type DetectConfig = Config['detect'];

/** getImageData().data と同じ RGBA 並びの配列 */
export type Frame = Uint8ClampedArray | Uint8Array;

export type Verdict = {
  /** true なら呼び出し側がフル解像度で保存し、成功したら markSaved を呼ぶ */
  save: boolean;
  state: 'watching' | 'stabilizing';
  /** 直前サンプルとの変化画素率 */
  diffPrev: number;
  /** 最後に保存した画像との変化画素率（判定したときだけ） */
  diffSaved?: number;
  /** 変化が及んだマス目の数（16 分割） */
  cells: number;
  /** 静止部分の割合。小さいほど映像中心の画面 */
  stillFraction: number;
};

/** RGB のいずれかのチャンネルが threshold 以上変わった画素の割合（0〜1）。アルファは見ない */
export function diffRatio(a: Frame, b: Frame, threshold: number): number {
  const n = Math.min(a.length, b.length) - (Math.min(a.length, b.length) % 4);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i += 4) {
    const dr = a[i]! - b[i]!;
    const dg = a[i + 1]! - b[i + 1]!;
    const db = a[i + 2]! - b[i + 2]!;
    if (
      dr >= threshold ||
      -dr >= threshold ||
      dg >= threshold ||
      -dg >= threshold ||
      db >= threshold ||
      -db >= threshold
    ) {
      changed++;
    }
  }
  return changed / (n / 4);
}

/** この割合以上のサンプルで変わった画素は「動き続けている」（講師のワイプや動画の中身）とみなす */
const MOTION_RATIO = 0.15;
/** ただし最低この回数は変わっていること（開始直後に 1 回変わっただけの画素を外さないため） */
const MOTION_MIN_HITS = 3;
/** 動きの判定に使う最低サンプル数。これに満たない間は全画素で比べる */
const MOTION_MIN_SAMPLES = 4;
/** 静止部分がこの割合を切ったら（画面全体が動画）マスクは使わず全画素で比べる */
const MOTION_MIN_STILL = 0.1;
/** 直近の様子を重く見るため、サンプル数がこれを超えたら回数を半分にする */
const MOTION_WINDOW = 200;
/** 色の分布を数えるときの階調（RGB 各 8 段階 = 512 通り） */
const COLOR_BINS = 8;
/** 静止部分がこの割合を超えるなら、スライド中心の画面とみなして「同じ場面」の判定は使わない */
const FOOTAGE_MAX_STILL = 0.5;
/** 変化がどれだけ広い範囲に散っているかを見るための分割数（4×4） */
const GRID = 4;
/** 切り替えとみなすのに必要な「変化したマス目」の数。人が動いただけなら 1〜3 マスに収まる */
const MIN_CHANGED_CELLS = 4;

export class ChangeDetector {
  private prev: Frame | null = null;
  /** 今のスライドを見ている間の、画素ごとの変化回数 */
  private motion: Uint8Array | null = null;
  private motionSamples = 0;
  /** 直前の比較で、変化がいくつのマス目に及んだか（切り替えの判定に使う） */
  private changedCells = 0;
  /** 直前の比較での静止部分の割合（スライド中心の画面か、映像中心かの目安） */
  private stillFraction = 1;
  private lastSaved: Frame | null = null;
  private state: Verdict['state'] = 'watching';
  private stabilizeStart = 0;
  private stableCount = 0;
  private lastSaveAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly cfg: DetectConfig) {}

  /**
   * 保存済みの画像と比べる。動き続けている画素（講師のワイプ、動画の中身）は除くので、
   * 本文が 1 行増えたような小さな変化（全体の 1% 前後）もワイプの動き（0.4〜0.9%）と区別できる
   */
  diffFromSaved(frame: Frame, saved: Frame): number {
    return this.compare(frame, saved, null).ratio;
  }

  /**
   * 動き続ける画素のマスクが実際に効いているか（compare の `masked` と同じ条件）。
   * サンプルが足りない間も、画面全体が動画で静止部分が残らないときも全画素で比べているので、
   * 呼び出し側は小さな差（ワイプの動きと同じくらい）を「変化」とみなしてはいけない
   */
  get maskReady(): boolean {
    return this.motion !== null && this.motionSamples >= MOTION_MIN_SAMPLES && this.stillFraction >= MOTION_MIN_STILL;
  }

  /**
   * 2 枚を比べ、動き続けている画素を除いた差分率と、変化が及んだマス目の数、静止部分の割合を返す。
   * counts を渡すと、そのついでに画素ごとの変化回数を数える（マスクの材料）。
   * まだサンプルが少ない、または静止部分がほとんどない（画面全体が動画）ときは全画素で比べる。
   * そのときはマス目の数も全画素で数える（除いた先に何も残っていないと、どんなカットも 0 マスになるため）
   */
  private compare(a: Frame, b: Frame, counts: Uint8Array | null): { ratio: number; cells: number; stillFraction: number } {
    const threshold = this.cfg.pixelDiffThreshold;
    const motion = this.motion;
    const samples = this.motionSamples;
    const usable = motion !== null && samples >= MOTION_MIN_SAMPLES;
    const limit = Math.min(a.length, b.length);
    const n = limit - (limit % 4);
    if (n === 0) return { ratio: 0, cells: 0, stillFraction: 1 };
    let changed = 0;
    let stillChanged = 0;
    let stillTotal = 0;
    const cells = GRID * GRID;
    const cellChanged = new Uint32Array(cells);
    const cellTotal = new Uint32Array(cells);
    const cellChangedAll = new Uint32Array(cells);
    const width = Math.max(1, this.cfg.detectWidth);
    const height = Math.max(1, this.cfg.detectHeight);
    for (let i = 0; i < n; i += 4) {
      const p = i / 4;
      const dr = a[i]! - b[i]!;
      const dg = a[i + 1]! - b[i + 1]!;
      const db = a[i + 2]! - b[i + 2]!;
      const differs =
        dr >= threshold || -dr >= threshold || dg >= threshold || -dg >= threshold || db >= threshold || -db >= threshold;
      // マスクの判定は回数を足す前の状態で行う（今回の変化がそのまま自分をマスクしないように）
      const moving = usable && motion![p]! >= MOTION_MIN_HITS && motion![p]! >= samples * MOTION_RATIO;
      if (differs) {
        changed++;
        if (counts && counts[p]! < 255) counts[p]!++;
      }
      // 変化が画面のどこに散っているかも見る（人が動いただけなら 1 か所にまとまる）
      const cell = Math.min(GRID - 1, Math.floor((Math.floor(p / width) * GRID) / height)) * GRID + Math.min(GRID - 1, Math.floor(((p % width) * GRID) / width));
      if (differs) cellChangedAll[cell]!++;
      if (!moving) {
        stillTotal++;
        if (differs) stillChanged++;
        cellTotal[cell]!++;
        if (differs) cellChanged[cell]!++;
      }
    }
    const pixels = n / 4;
    const perCell = pixels / cells;
    const masked = usable && stillTotal >= pixels * MOTION_MIN_STILL;
    let hitCells = 0;
    for (let c = 0; c < cells; c++) {
      // マスクを使わないときは全画素で数える。1 マスあたりの画素数は割り切れないことがあるので概算でよい
      const total = masked ? cellTotal[c]! : perCell;
      const hit = masked ? cellChanged[c]! : cellChangedAll[c]!;
      if (total > 0 && hit >= total * this.cfg.changeThreshold) hitCells++;
    }
    return {
      ratio: masked ? (stillTotal === 0 ? 0 : stillChanged / stillTotal) : changed / pixels,
      cells: hitCells,
      stillFraction: stillTotal / pixels,
    };
  }

  /** 直近を重く見るため、たまに回数を半分にする（長い動画で飽和させない） */
  private observed(): void {
    this.motionSamples++;
    if (this.motionSamples >= MOTION_WINDOW && this.motion) {
      for (let p = 0; p < this.motion.length; p++) this.motion[p]! >>= 1;
      this.motionSamples >>= 1;
    }
  }

  /** 再生中のサンプルを 1 つ処理する */
  sample(frame: Frame, now: number): Verdict {
    let diffPrev = 0;
    if (this.prev) {
      const m = this.compare(frame, this.prev, this.motionFor(frame));
      diffPrev = m.ratio;
      this.changedCells = m.cells;
      this.stillFraction = m.stillFraction;
      this.observed();
    }
    this.prev = frame;

    if (this.state === 'watching') {
      // 画面全体としての変化が大きく、かつ広い範囲に散っているときだけ「切り替わった」とみなす。
      // 映像中心の画面では、カメラや被写体が動いているだけの連続したショットを撮り続けないよう、
      // 1 サンプルで一気に変わったとき（カット）だけを拾う
      const needed = this.stillFraction < FOOTAGE_MAX_STILL ? Math.max(this.cfg.changeThreshold, this.cfg.cutThreshold) : this.cfg.changeThreshold;
      if (diffPrev >= needed && this.changedCells >= MIN_CHANGED_CELLS) {
        this.state = 'stabilizing';
        this.stabilizeStart = now;
        this.stableCount = 0;
      }
      return this.verdict(false, diffPrev);
    }

    // 安定待ち: 直前との差が小さいサンプルが続くか、上限時間を超えたら判定する
    this.stableCount = diffPrev < this.cfg.stableThreshold ? this.stableCount + 1 : 0;
    if (this.stableCount >= this.cfg.stableSamples || now - this.stabilizeStart >= this.cfg.maxStabilizeMs) {
      return this.decide(frame, now, diffPrev);
    }
    return this.verdict(false, diffPrev);
  }

  /** 一時停止など画面が静止したことが確実なとき、安定待ちを打ち切って判定する */
  flush(frame: Frame, now: number): Verdict {
    let diffPrev = 0;
    if (this.prev) {
      const m = this.compare(frame, this.prev, this.motionFor(frame));
      diffPrev = m.ratio;
      this.changedCells = m.cells;
      this.stillFraction = m.stillFraction;
      this.observed();
    }
    this.prev = frame;
    if (this.state !== 'stabilizing') return this.verdict(false, diffPrev);
    return this.decide(frame, now, diffPrev);
  }

  /** 保存済みの画像を最終状態で上書きしたとき、重複判定の基準だけ差し替える（保存間隔や状態は触らない） */
  replaceSaved(frame: Frame): void {
    this.lastSaved = frame;
  }

  /** 画素ごとの変化回数の入れ物。フレームの大きさが変わったら作り直す */
  private motionFor(frame: Frame): Uint8Array {
    const pixels = Math.floor(frame.length / 4);
    if (!this.motion || this.motion.length !== pixels) {
      this.motion = new Uint8Array(pixels);
      this.motionSamples = 0;
    }
    return this.motion;
  }

  /** フル解像度の保存に成功したら呼ぶ（手動保存や開始時の 1 枚も含む） */
  markSaved(frame: Frame, now: number): void {
    this.lastSaved = frame;
    this.lastSaveAt = now;
    this.state = 'watching';
    // 動きの統計はスライドをまたいで持ち越す。講師のワイプの位置は動画全体で変わらないので、
    // スライドが変わるたびに数え直すと、その直後だけ判定がゆるくなってしまう
  }

  private verdict(save: boolean, diffPrev: number, diffSaved?: number): Verdict {
    return { save, state: this.state, diffPrev, cells: this.changedCells, stillFraction: this.stillFraction, ...(diffSaved !== undefined ? { diffSaved } : {}) };
  }

  /**
   * 色の分布（RGB 各 8 段階）がどれだけそろっているか（0〜1）。被写体やカメラが動いても、
   * 同じ場面なら色の構成は似たまま。場面が変われば大きく下がる
   */
  private colorMatch(a: Frame, b: Frame): number {
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

  private decide(frame: Frame, now: number, diffPrev: number): Verdict {
    // 重複の判定もマスク済みで行う（ワイプが動いただけの再保存を防ぐ）
    const diffSaved = this.lastSaved ? this.compare(frame, this.lastSaved, null).ratio : 1;
    // 映像中心の画面では、色の構成が同じなら「同じ場面」とみなして続けて撮らない
    if (this.lastSaved && this.stillFraction < FOOTAGE_MAX_STILL && this.colorMatch(frame, this.lastSaved) >= this.cfg.sameSceneColor) {
      this.state = 'watching';
      return this.verdict(false, diffPrev, diffSaved);
    }
    if (diffSaved < this.cfg.dedupeThreshold) {
      // 最後に保存した画像と同じ（元に戻った、ちらつき）
      this.state = 'watching';
      return this.verdict(false, diffPrev, diffSaved);
    }
    if (now - this.lastSaveAt < this.cfg.minShotIntervalMs) {
      // 保存間隔が空くまで保留する。安定待ちのままにして次のサンプルや flush で再判定する
      this.state = 'stabilizing';
      return this.verdict(false, diffPrev, diffSaved);
    }
    this.state = 'watching';
    return this.verdict(true, diffPrev, diffSaved);
  }
}
