import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config';
import { ChangeDetector, diffRatio } from './detect';

const cfg = DEFAULT_CONFIG.detect;
const PIXELS = 160 * 90;

/** RGB (r,g,b) で塗りつぶした RGBA 画像。ratio の割合だけ別の色 alt にする */
function frame(rgb: [number, number, number], ratio = 0, alt: [number, number, number] = [255, 255, 255]): Uint8ClampedArray {
  const f = new Uint8ClampedArray(PIXELS * 4);
  const altPixels = Math.round(PIXELS * ratio);
  for (let p = 0; p < PIXELS; p++) {
    const [r, g, b] = p < altPixels ? alt : rgb;
    f[p * 4] = r;
    f[p * 4 + 1] = g;
    f[p * 4 + 2] = b;
    f[p * 4 + 3] = 255;
  }
  return f;
}
const gray = (v: number, ratio = 0, alt = 255) => frame([v, v, v], ratio, [alt, alt, alt]);

describe('diffRatio', () => {
  it('counts pixels where any RGB channel differs by the threshold', () => {
    expect(diffRatio(gray(0), gray(0), 24)).toBe(0);
    expect(diffRatio(gray(0), gray(0, 0.25), 24)).toBeCloseTo(0.25, 3);
    expect(diffRatio(gray(100), gray(123), 24)).toBe(0);
    expect(diffRatio(gray(100), gray(124), 24)).toBe(1);
  });

  it('sees a colour → monochrome change even when the luminance is unchanged', () => {
    // 赤 (200, 60, 60) の BT.601 輝度は約 102。同じ輝度のグレー (102, 102, 102) に変わっても
    // 輝度比較では 0 だが、チャンネル比較では全画素が変化になる
    expect(diffRatio(frame([200, 60, 60]), gray(102), 24)).toBe(1);
  });

  it('ignores the alpha channel', () => {
    const a = gray(50);
    const b = gray(50);
    for (let i = 3; i < b.length; i += 4) b[i] = 0;
    expect(diffRatio(a, b, 24)).toBe(0);
  });
});

describe('ChangeDetector', () => {
  const run = (frames: Uint8ClampedArray[], stepMs = cfg.sampleIntervalMs, detector = new ChangeDetector(cfg)) => {
    const saves: number[] = [];
    frames.forEach((f, i) => {
      const now = i * stepMs;
      if (detector.sample(f, now).save) {
        saves.push(i);
        detector.markSaved(f, now);
      }
    });
    return { saves, detector };
  };

  it('never saves while the picture is static', () => {
    expect(run(Array.from({ length: 20 }, () => gray(40))).saves).toEqual([]);
  });

  it('saves once after a slide change settles', () => {
    const frames = [gray(40), gray(40), gray(200), gray(200), gray(200), gray(200), gray(200)];
    // 変化はサンプル 2 で検知、3 と 4 で安定 → 4 で保存
    expect(run(frames).saves).toEqual([4]);
  });

  it('saves when a colour slide turns monochrome', () => {
    const colour = frame([200, 60, 60]);
    const mono = gray(102);
    expect(run([colour, colour, mono, mono, mono, mono]).saves).toEqual([4]);
  });

  it('ignores small motion such as a presenter wipe (measured at 0.4–0.9% per sample)', () => {
    const frames = Array.from({ length: 20 }, (_, i) => gray(40, 0.01, i % 2 ? 255 : 0));
    expect(run(frames).saves).toEqual([]);
  });

  it('catches a slide where only the body text changes (measured at about 3%)', () => {
    const frames = [gray(40), gray(40), gray(40, 0.032), gray(40, 0.032), gray(40, 0.032), gray(40, 0.032)];
    expect(run(frames).saves).toEqual([4]);
  });

  it('does not save when the picture returns to the last saved slide', () => {
    const detector = new ChangeDetector(cfg);
    detector.markSaved(gray(40), 0);
    const frames = [gray(40), gray(200), gray(40), gray(40), gray(40)];
    expect(run(frames, cfg.sampleIntervalMs, detector).saves).toEqual([]);
  });

  it('waits for stability but gives up after maxStabilizeMs', () => {
    // 毎サンプル大きく変わり続ける（アニメーション） → 上限で現フレームを採用
    const frames = Array.from({ length: 12 }, (_, i) => gray((i * 30) % 256));
    const { saves } = run(frames);
    expect(saves.length).toBe(1);
    expect(saves[0]! * cfg.sampleIntervalMs).toBeGreaterThanOrEqual(cfg.maxStabilizeMs);
  });

  it('holds a confirmed change until the minimum interval has passed, then saves it', () => {
    const detector = new ChangeDetector({ ...cfg, minShotIntervalMs: 2000 });
    // 3 で保存（1500ms）。次の変化は 6（3000ms）で確定するが間隔不足 → 7（3500ms）で保存
    const frames = [gray(40), gray(200), gray(200), gray(200), gray(90), gray(90), gray(90), gray(90)];
    expect(run(frames, cfg.sampleIntervalMs, detector).saves).toEqual([3, 7]);
  });

  it('flush decides immediately while stabilizing (pause right after a change)', () => {
    const detector = new ChangeDetector(cfg);
    detector.markSaved(gray(40), 0);
    expect(detector.sample(gray(40), 500).save).toBe(false);
    expect(detector.sample(gray(200), 1000).state).toBe('stabilizing');
    // 直前の保存から 2 秒経っていないので保留（安定待ちのまま）
    const held = detector.flush(gray(200), 1200);
    expect(held.save).toBe(false);
    expect(held.state).toBe('stabilizing');
    expect(held.diffSaved).toBe(1);
    // 間隔が空けば flush で保存される
    const verdict = detector.flush(gray(200), 2500);
    expect(verdict.save).toBe(true);
    // 保存後は監視状態に戻る
    detector.markSaved(gray(200), 2500);
    expect(detector.flush(gray(200), 2600).save).toBe(false);
  });
});

describe('見た目が同じ場面（映像中心の画面）', () => {
  /** ざらざらした映像。seed を変えると細かい模様は変わるが、全体の明るさは同じ */
  const noise = (seed: number, shade = 128) => {
    const f = new Uint8ClampedArray(PIXELS * 4);
    let x = seed;
    for (let p = 0; p < PIXELS; p++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      const v = shade + ((x >> 16) % 60) - 30;
      f[p * 4] = v;
      f[p * 4 + 1] = v;
      f[p * 4 + 2] = v;
      f[p * 4 + 3] = 255;
    }
    return f;
  };

  it('被写体が動いただけの場面は、細かく見れば大きく違っても撮らない', () => {
    const detector = new ChangeDetector(cfg);
    detector.markSaved(noise(1), 0);
    // 画面全体が動く映像なので、静止部分はほとんどない
    for (let i = 0; i < 8; i++) detector.sample(noise(i + 2), 1000 + i * 500);
    const verdict = detector.flush(noise(20), 9000);
    expect(verdict.save).toBe(false);
  });

  it('場面が変われば撮る', () => {
    const detector = new ChangeDetector(cfg);
    detector.markSaved(noise(1, 60), 0);
    for (let i = 0; i < 8; i++) detector.sample(noise(i + 2, 60), 1000 + i * 500);
    // 明るさがまるごと変わる = 別の場面（映像中心なので最短間隔 15 秒を過ぎてから）
    detector.sample(noise(30, 220), 16_000);
    const verdict = detector.flush(noise(31, 220), 16_500);
    expect(verdict.save).toBe(true);
  });
});

describe('変化の広がり', () => {
  const W = 160, H = 90;
  /** 画面の一部（cols×rows のマス目）だけを黒くしたフレーム */
  const patch = (cols: number, rows: number) => {
    const f = new Uint8ClampedArray(PIXELS * 4).fill(255);
    for (let y = 0; y < (H * rows) / 4; y++) {
      for (let x = 0; x < (W * cols) / 4; x++) {
        const p = y * W + x;
        f[p * 4] = 0;
        f[p * 4 + 1] = 0;
        f[p * 4 + 2] = 0;
      }
    }
    return f;
  };
  const blank = () => new Uint8ClampedArray(PIXELS * 4).fill(255);

  it('1 か所にまとまった変化は切り替えとみなさない（人が動いただけ）', () => {
    const detector = new ChangeDetector(cfg);
    detector.sample(blank(), 0);
    // 左上 1 マス（全体の 6%）が真っ黒になっても、変化は 1 マスに収まる
    const verdict = detector.sample(patch(1, 1), 500);
    expect(verdict.diffPrev).toBeGreaterThan(cfg.changeThreshold);
    expect(verdict.state).toBe('watching');
  });

  it('広い範囲に散った変化は切り替えとみなす', () => {
    const detector = new ChangeDetector(cfg);
    detector.sample(blank(), 0);
    const verdict = detector.sample(patch(4, 2), 500); // 上半分（8 マス）
    expect(verdict.state).toBe('stabilizing');
  });
});

describe('diffFromSaved（動き続ける領域を除いた比較）', () => {
  /** 画素 [from, to) を色 rgb にする */
  const paint = (f: Uint8ClampedArray, from: number, to: number, rgb: [number, number, number]) => {
    for (let p = from; p < to; p++) {
      f[p * 4] = rgb[0];
      f[p * 4 + 1] = rgb[1];
      f[p * 4 + 2] = rgb[2];
      f[p * 4 + 3] = 255;
    }
    return f;
  };
  /** 白地。ワイプ（末尾 2%）はサンプルごとに色が変わり、本文の 1 行（0.9%）は最後に一度だけ増える */
  const wipeFrom = Math.round(PIXELS * 0.98);
  const textFrom = Math.round(PIXELS * 0.5);
  const textTo = textFrom + Math.round(PIXELS * 0.009);
  const slide = (wipeShade: number, withLine = false) => {
    const f = paint(new Uint8ClampedArray(PIXELS * 4), 0, PIXELS, [255, 255, 255]);
    paint(f, wipeFrom, PIXELS, [wipeShade, wipeShade, wipeShade]);
    if (withLine) paint(f, textFrom, textTo, [0, 0, 0]);
    return f;
  };

  it('ワイプの動きは無視し、本文が 1 行増えたことは拾う', () => {
    const detector = new ChangeDetector(cfg);
    const saved = slide(10);
    detector.markSaved(saved, 0);
    // 同じスライドを見ている間、ワイプだけが動く
    for (let i = 0; i < 6; i++) detector.sample(slide(10 + (i % 2) * 120), 1000 + i * 500);
    const final = slide(130, true); // ワイプの色も変わっている（本物の動画と同じ状況）

    // 素の比較ではワイプの 2% が乗ってしまうが、動きを除けば本文の変化だけが残る
    expect(diffRatio(final, saved, cfg.pixelDiffThreshold)).toBeGreaterThan(0.02);
    const masked = detector.diffFromSaved(final, saved);
    expect(masked).toBeGreaterThan(0.004);
    expect(masked).toBeLessThan(0.012);

    // ワイプだけが動いた画面は、上書きの閾値（0.4%）に届かない
    expect(detector.diffFromSaved(slide(130), saved)).toBeLessThan(0.004);
  });

  it('サンプルが少ないうちは全画素で比べる', () => {
    const detector = new ChangeDetector(cfg);
    const saved = slide(10);
    detector.markSaved(saved, 0);
    detector.sample(slide(130), 500);
    expect(detector.diffFromSaved(slide(130), saved)).toBeGreaterThan(0.015);
  });

  it('動きの記録はスライドをまたいで持ち越す（保存直後だけ判定がゆるくならないように）', () => {
    const detector = new ChangeDetector(cfg);
    const saved = slide(10);
    detector.markSaved(saved, 0);
    for (let i = 0; i < 6; i++) detector.sample(slide(10 + (i % 2) * 120), 1000 + i * 500);
    detector.markSaved(saved, 5000); // 次のスライドへ
    expect(detector.diffFromSaved(slide(130), saved)).toBeLessThan(0.004);
  });

  it('切り替えの判定でもワイプの動きを無視する', () => {
    const detector = new ChangeDetector(cfg);
    detector.markSaved(slide(10), 0);
    for (let i = 0; i < 6; i++) detector.sample(slide(10 + (i % 2) * 120), 1000 + i * 500);
    // ワイプだけが動いた次のサンプル: 全画素で見れば 2% だが、切り替えとはみなさない
    const wipeOnly = detector.sample(slide(200), 5000);
    expect(wipeOnly.diffPrev).toBeLessThan(cfg.changeThreshold);
    expect(wipeOnly.state).toBe('watching');
    // 本文が丸ごと変わればちゃんと切り替えとみなす
    const switched = detector.sample(paint(slide(200), 0, Math.round(PIXELS * 0.5), [0, 0, 0]), 5500);
    expect(switched.state).toBe('stabilizing');
  });

  it('画面全体が動画のときはマスクを使わず全画素で比べる', () => {
    const detector = new ChangeDetector(cfg);
    // 毎サンプル全画素が変わる（風景の映像など）
    for (let i = 0; i < 8; i++) detector.sample(paint(new Uint8ClampedArray(PIXELS * 4), 0, PIXELS, [i * 30, 0, 0]), i * 500);
    const verdict = detector.sample(paint(new Uint8ClampedArray(PIXELS * 4), 0, PIXELS, [255, 255, 255]), 4000);
    expect(verdict.diffPrev).toBeGreaterThan(0.9);
  });
});

describe('映像中心の画面の最短間隔', () => {
  const noise = (seed: number, shade = 128) => {
    const f = new Uint8ClampedArray(PIXELS * 4);
    let x = seed;
    for (let p = 0; p < PIXELS; p++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      const v = shade + ((x >> 16) % 60) - 30;
      f[p * 4] = v;
      f[p * 4 + 1] = v;
      f[p * 4 + 2] = v;
      f[p * 4 + 3] = 255;
    }
    return f;
  };

  it('場面が変わっても、前のキャプチャから間隔が空くまで撮らない', () => {
    const detector = new ChangeDetector(cfg);
    detector.markSaved(noise(1, 60), 0);
    for (let i = 0; i < 8; i++) detector.sample(noise(i + 2, 60), 1000 + i * 500);
    // 5 秒時点で別の場面になっても、映像中心なので 15 秒までは保存しない
    detector.sample(noise(30, 220), 5000);
    expect(detector.flush(noise(31, 220), 5500).save).toBe(false);
    // 間隔が空けば保存する
    detector.sample(noise(32, 60), 16_000); // いったん元の明るさに戻し
    detector.sample(noise(33, 220), 16_500); // もう一度場面が変わる
    expect(detector.flush(noise(34, 220), 17_000).save).toBe(true);
  });
});
