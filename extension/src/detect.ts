import type { Config } from './config';

/**
 * 画面変化の検知（SPEC §9）。
 *
 * 縮小したグレースケール画像同士を比べ、「大きく変わった → 数サンプル安定した →
 * 最後に保存した画像とも違う」ときだけ保存を指示する。DOM に触らない純粋な
 * ロジックなので Vitest で閾値の挙動を確かめられる。
 */
export type DetectConfig = Config['detect'];

export type Verdict = {
  /** true なら呼び出し側がフル解像度で保存し、成功したら markSaved を呼ぶ */
  save: boolean;
  state: 'watching' | 'stabilizing';
  /** 直前サンプルとの変化画素率 */
  diffPrev: number;
  /** 最後に保存した画像との変化画素率（判定したときだけ） */
  diffSaved?: number;
};

/** RGBA の ImageData を 0〜255 のグレースケール配列にする */
export function toGrayscale(rgba: Uint8ClampedArray | Uint8Array, pixels: number): Uint8Array {
  const gray = new Uint8Array(pixels);
  for (let i = 0, p = 0; p < pixels; i += 4, p++) {
    // ITU-R BT.601 の輝度。整数演算で十分
    gray[p] = (rgba[i]! * 299 + rgba[i + 1]! * 587 + rgba[i + 2]! * 114) / 1000;
  }
  return gray;
}

/** 画素差が threshold 以上の画素の割合（0〜1） */
export function diffRatio(a: Uint8Array, b: Uint8Array, threshold: number): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d >= threshold || -d >= threshold) changed++;
  }
  return changed / n;
}

export class ChangeDetector {
  private prev: Uint8Array | null = null;
  private lastSaved: Uint8Array | null = null;
  private state: Verdict['state'] = 'watching';
  private stabilizeStart = 0;
  private stableCount = 0;
  private lastSaveAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly cfg: DetectConfig) {}

  /** 再生中のサンプルを 1 つ処理する */
  sample(gray: Uint8Array, now: number): Verdict {
    const diffPrev = this.prev ? diffRatio(gray, this.prev, this.cfg.pixelDiffThreshold) : 0;
    this.prev = gray;

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
      return this.decide(gray, now, diffPrev);
    }
    return { save: false, state: this.state, diffPrev };
  }

  /** 一時停止など画面が静止したことが確実なとき、安定待ちを打ち切って判定する */
  flush(gray: Uint8Array, now: number): Verdict {
    const diffPrev = this.prev ? diffRatio(gray, this.prev, this.cfg.pixelDiffThreshold) : 0;
    this.prev = gray;
    if (this.state !== 'stabilizing') return { save: false, state: this.state, diffPrev };
    return this.decide(gray, now, diffPrev);
  }

  /** フル解像度の保存に成功したら呼ぶ（手動保存や開始時の 1 枚も含む） */
  markSaved(gray: Uint8Array, now: number): void {
    this.lastSaved = gray;
    this.lastSaveAt = now;
    this.state = 'watching';
  }

  private decide(gray: Uint8Array, now: number, diffPrev: number): Verdict {
    const diffSaved = this.lastSaved ? diffRatio(gray, this.lastSaved, this.cfg.pixelDiffThreshold) : 1;
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
