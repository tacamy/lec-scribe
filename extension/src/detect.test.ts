import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config';
import { ChangeDetector, diffRatio, toGrayscale } from './detect';

const cfg = DEFAULT_CONFIG.detect;
const PIXELS = 160 * 90;

/** 値 v で塗りつぶした画像。ratio の割合だけ別の値 v2 にする */
function frame(v: number, ratio = 0, v2 = 255): Uint8Array {
  const g = new Uint8Array(PIXELS).fill(v);
  g.fill(v2, 0, Math.round(PIXELS * ratio));
  return g;
}

describe('toGrayscale', () => {
  it('weights RGB like BT.601 and ignores alpha', () => {
    const rgba = Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128, 255, 255, 255, 255]);
    expect(Array.from(toGrayscale(rgba, 4))).toEqual([76, 149, 29, 255]);
  });
});

describe('diffRatio', () => {
  it('counts pixels whose difference reaches the threshold', () => {
    expect(diffRatio(frame(0), frame(0), 24)).toBe(0);
    expect(diffRatio(frame(0), frame(0, 0.25), 24)).toBeCloseTo(0.25, 3);
    expect(diffRatio(frame(100), frame(123), 24)).toBe(0);
    expect(diffRatio(frame(100), frame(124), 24)).toBe(1);
  });
});

describe('ChangeDetector', () => {
  const run = (frames: Uint8Array[], stepMs = cfg.sampleIntervalMs, detector = new ChangeDetector(cfg)) => {
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
    expect(run(Array.from({ length: 20 }, () => frame(40))).saves).toEqual([]);
  });

  it('saves once after a slide change settles', () => {
    const frames = [frame(40), frame(40), frame(200), frame(200), frame(200), frame(200), frame(200)];
    // 変化はサンプル 2 で検知、3 と 4 で安定 → 4 で保存
    expect(run(frames).saves).toEqual([4]);
  });

  it('ignores small motion such as a presenter wipe (measured at 0.4–0.9% per sample)', () => {
    const frames = Array.from({ length: 20 }, (_, i) => frame(40, 0.01, i % 2 ? 255 : 0));
    expect(run(frames).saves).toEqual([]);
  });

  it('catches a slide where only the body text changes (measured at about 3%)', () => {
    const frames = [frame(40), frame(40), frame(40, 0.032), frame(40, 0.032), frame(40, 0.032), frame(40, 0.032)];
    expect(run(frames).saves).toEqual([4]);
  });

  it('does not save when the picture returns to the last saved slide', () => {
    const detector = new ChangeDetector(cfg);
    detector.markSaved(frame(40), 0);
    const frames = [frame(40), frame(200), frame(40), frame(40), frame(40)];
    expect(run(frames, cfg.sampleIntervalMs, detector).saves).toEqual([]);
  });

  it('waits for stability but gives up after maxStabilizeMs', () => {
    // 毎サンプル大きく変わり続ける（アニメーション） → 上限で現フレームを採用
    const frames = Array.from({ length: 12 }, (_, i) => frame((i * 30) % 256));
    const { saves } = run(frames);
    expect(saves.length).toBe(1);
    expect(saves[0]! * cfg.sampleIntervalMs).toBeGreaterThanOrEqual(cfg.maxStabilizeMs);
  });

  it('holds a confirmed change until the minimum interval has passed, then saves it', () => {
    const detector = new ChangeDetector({ ...cfg, minShotIntervalMs: 2000 });
    // 3 で保存（1500ms）。次の変化は 6（3000ms）で確定するが間隔不足 → 7（3500ms）で保存
    const frames = [frame(40), frame(200), frame(200), frame(200), frame(90), frame(90), frame(90), frame(90)];
    expect(run(frames, cfg.sampleIntervalMs, detector).saves).toEqual([3, 7]);
  });

  it('flush decides immediately while stabilizing (pause right after a change)', () => {
    const detector = new ChangeDetector(cfg);
    detector.markSaved(frame(40), 0);
    expect(detector.sample(frame(40), 500).save).toBe(false);
    expect(detector.sample(frame(200), 1000).state).toBe('stabilizing');
    // 直前の保存から 2 秒経っていないので保留（安定待ちのまま）
    const held = detector.flush(frame(200), 1200);
    expect(held.save).toBe(false);
    expect(held.state).toBe('stabilizing');
    expect(held.diffSaved).toBe(1);
    // 間隔が空けば flush で保存される
    const verdict = detector.flush(frame(200), 2500);
    expect(verdict.save).toBe(true);
    // 保存後は監視状態に戻る
    detector.markSaved(frame(200), 2500);
    expect(detector.flush(frame(200), 2600).save).toBe(false);
  });
});
