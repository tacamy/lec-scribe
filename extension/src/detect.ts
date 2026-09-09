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
};

/**
 * RGB のいずれかのチャンネルが threshold 以上変わった画素の割合（0〜1）。アルファは見ない。
 * counts を渡すと、変わった画素の回数を数える（動き続ける領域＝講師のワイプを見分けるため）
 */
export function diffRatio(a: Frame, b: Frame, threshold: number, counts?: Uint8Array): number {
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
      if (counts) {
        const p = i / 4;
        if (counts[p]! < 255) counts[p]!++;
      }
    }
  }
  return changed / (n / 4);
}

/** この回数以上変わった画素は「動き続けている」（講師のワイプや動画の中身）とみなす */
const MOTION_HITS = 3;
/** 動きの判定に使う最低サンプル数。これに満たない間は全画素で比べる */
const MOTION_MIN_SAMPLES = 4;

export class ChangeDetector {
  private prev: Frame | null = null;
  /** 今のスライドを見ている間の、画素ごとの変化回数 */
  private motion: Uint8Array | null = null;
  private motionSamples = 0;
  private lastSaved: Frame | null = null;
  private state: Verdict['state'] = 'watching';
  private stabilizeStart = 0;
  private stableCount = 0;
  private lastSaveAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly cfg: DetectConfig) {}

  /**
   * 保存済みの画像と比べる。動き続けている画素（ワイプなど）は除くので、
   * 本文が 1 行増えたような小さな変化（全体の 1% 前後）もワイプの動き（0.4〜0.9%）と区別できる
   */
  diffFromSaved(frame: Frame, saved: Frame): number {
    const motion = this.motion;
    if (!motion || this.motionSamples < MOTION_MIN_SAMPLES) return diffRatio(frame, saved, this.cfg.pixelDiffThreshold);
    const n = Math.min(frame.length, saved.length, motion.length * 4);
    const threshold = this.cfg.pixelDiffThreshold;
    let changed = 0;
    let counted = 0;
    for (let i = 0; i + 3 < n; i += 4) {
      if (motion[i / 4]! >= MOTION_HITS) continue; // 動き続けている画素は見ない
      counted++;
      const dr = frame[i]! - saved[i]!;
      const dg = frame[i + 1]! - saved[i + 1]!;
      const db = frame[i + 2]! - saved[i + 2]!;
      if (dr >= threshold || -dr >= threshold || dg >= threshold || -dg >= threshold || db >= threshold || -db >= threshold) changed++;
    }
    return counted === 0 ? 0 : changed / counted;
  }

  /** 再生中のサンプルを 1 つ処理する */
  sample(frame: Frame, now: number): Verdict {
    const diffPrev = this.prev ? diffRatio(frame, this.prev, this.cfg.pixelDiffThreshold, this.motionFor(frame)) : 0;
    if (this.prev) this.motionSamples++;
    this.prev = frame;

    if (this.state === 'watching') {
      if (diffPrev >= this.cfg.changeThreshold) {
        this.state = 'stabilizing';
        this.stabilizeStart = now;
        this.stableCount = 0;
      }
      return { save: false, state: this.state, diffPrev };
    }

    // 安定待ち: 直前との差が小さいサンプルが続くか、上限時間を超えたら判定する
    this.stableCount = diffPrev < this.cfg.stableThreshold ? this.stableCount + 1 : 0;
    if (this.stableCount >= this.cfg.stableSamples || now - this.stabilizeStart >= this.cfg.maxStabilizeMs) {
      return this.decide(frame, now, diffPrev);
    }
    return { save: false, state: this.state, diffPrev };
  }

  /** 一時停止など画面が静止したことが確実なとき、安定待ちを打ち切って判定する */
  flush(frame: Frame, now: number): Verdict {
    const diffPrev = this.prev ? diffRatio(frame, this.prev, this.cfg.pixelDiffThreshold, this.motionFor(frame)) : 0;
    if (this.prev) this.motionSamples++;
    this.prev = frame;
    if (this.state !== 'stabilizing') return { save: false, state: this.state, diffPrev };
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
    // 新しいスライドを見始めるので、どこが動き続けているかは数え直す
    this.motion?.fill(0);
    this.motionSamples = 0;
  }

  private decide(frame: Frame, now: number, diffPrev: number): Verdict {
    const diffSaved = this.lastSaved ? diffRatio(frame, this.lastSaved, this.cfg.pixelDiffThreshold) : 1;
    if (diffSaved < this.cfg.dedupeThreshold) {
      // 最後に保存した画像と同じ（元に戻った、ちらつき）
      this.state = 'watching';
      return { save: false, state: this.state, diffPrev, diffSaved };
    }
    if (now - this.lastSaveAt < this.cfg.minShotIntervalMs) {
      // 保存間隔が空くまで保留する。安定待ちのままにして次のサンプルや flush で再判定する
      this.state = 'stabilizing';
      return { save: false, state: this.state, diffPrev, diffSaved };
    }
    this.state = 'watching';
    return { save: true, state: this.state, diffPrev, diffSaved };
  }
}
