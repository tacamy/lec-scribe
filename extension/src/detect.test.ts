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
