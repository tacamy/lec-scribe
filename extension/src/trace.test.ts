import { describe, expect, it } from 'vitest';
import { decodeBatch, encodeBatch, frameToRgb, packMember, readTrace, rgbToFrame, type TraceRecord } from './trace';

const W = 4;
const H = 3;

function rgba(seed: number): Uint8ClampedArray {
  const f = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < f.length; i++) f[i] = (seed * 31 + i * 7) & 0xff;
  return f;
}

const record = (kind: TraceRecord['kind'], seed: number, verdict?: TraceRecord['verdict']): TraceRecord => ({
  kind,
  now: 1_700_000_000_000 + seed,
  videoTime: seed / 2,
  width: W,
  height: H,
  rgb: frameToRgb(rgba(seed), W * H),
  ...(verdict ? { verdict } : {}),
});

describe('trace', () => {
  it('RGBA と RGB を往復できる（alpha は 255 に戻る）', () => {
    const frame = rgba(1);
    const back = rgbToFrame(frameToRgb(frame, W * H), W * H);
    for (let p = 0; p < W * H; p++) {
      expect([back[p * 4], back[p * 4 + 1], back[p * 4 + 2], back[p * 4 + 3]]).toEqual([frame[p * 4], frame[p * 4 + 1], frame[p * 4 + 2], 255]);
    }
  });

  it('判定の有無・diffSaved の有無を含めて塊を往復できる', () => {
    const records = [
      record('sample', 1, { save: false, state: 'watching', diffPrev: 0.0123, cells: 3, stillFraction: 0.8 }),
      record('sample', 2, { save: true, state: 'stabilizing', diffPrev: 0.5, diffSaved: 0.25, cells: 16, stillFraction: 0.1 }),
      record('flush', 3, { save: false, state: 'watching', diffPrev: 0, cells: 0, stillFraction: 1 }),
      record('saved', 4),
      record('replaced', 5),
    ];
    const out = decodeBatch(encodeBatch(records));
    expect(out).toHaveLength(records.length);
    out.forEach((r, i) => {
      const src = records[i]!;
      expect(r.kind).toBe(src.kind);
      expect(r.now).toBe(src.now);
      expect(r.videoTime).toBe(src.videoTime);
      expect([r.width, r.height]).toEqual([W, H]);
      expect([...r.rgb]).toEqual([...src.rgb]);
      if (!src.verdict) {
        expect(r.verdict).toBeUndefined();
        return;
      }
      expect(r.verdict!.save).toBe(src.verdict.save);
      expect(r.verdict!.state).toBe(src.verdict.state);
      expect(r.verdict!.diffPrev).toBeCloseTo(src.verdict.diffPrev, 5);
      expect(r.verdict!.cells).toBe(src.verdict.cells);
      expect(r.verdict!.stillFraction).toBeCloseTo(src.verdict.stillFraction, 5);
      if (src.verdict.diffSaved === undefined) expect(r.verdict!.diffSaved).toBeUndefined();
      else expect(r.verdict!.diffSaved).toBeCloseTo(src.verdict.diffSaved, 5);
    });
  });

  it('gzip した塊を続けて書いたファイルを、順番どおりに読める', async () => {
    const a = [record('sample', 1, { save: false, state: 'watching', diffPrev: 0.01, cells: 1, stillFraction: 0.9 })];
    const b = [record('saved', 2), record('sample', 3, { save: true, state: 'watching', diffPrev: 0.3, diffSaved: 0.4, cells: 8, stillFraction: 0.7 })];
    const file = new Uint8Array([...(await packMember(a)), ...(await packMember(b))]);
    const out = await readTrace(file);
    expect(out.map((r) => [r.kind, r.videoTime])).toEqual([
      ['sample', 0.5],
      ['saved', 1],
      ['sample', 1.5],
    ]);
  });

  it('壊れた入力は投げる', async () => {
    expect(() => decodeBatch(new Uint8Array([1, 2, 3]))).toThrow();
    await expect(readTrace(new Uint8Array([9, 0, 0, 0, 1, 2]))).rejects.toThrow();
  });
});
