import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBin, run } from './exec.ts';
import type { SlideEntry } from './merge.ts';
import { colorEntropy, colorMatch, pickShownSlides, readThumbnail, THUMB_HEIGHT, THUMB_WIDTH } from './scenes.ts';

const PIXELS = THUMB_WIDTH * THUMB_HEIGHT;

/** ざらざらした映像のサムネイル。seed で模様が変わり、shade で全体の明るさが変わる */
function footage(seed: number, shade = 128): Uint8Array {
  const f = new Uint8Array(PIXELS * 4);
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
}

const slide = (n: number, stillFraction?: number): SlideEntry => ({
  filename: `slide_${String(n).padStart(3, '0')}.png`,
  seq: n,
  videoTime: n * 10,
  ...(stillFraction !== undefined ? { trigger: { stillFraction } } : {}),
});

describe('colorMatch', () => {
  it('同じ場面（模様は違うが明るさは同じ）は高く、別の場面は低い', () => {
    expect(colorMatch(footage(1), footage(2))).toBeGreaterThan(0.9);
    expect(colorMatch(footage(1, 60), footage(2, 220))).toBeLessThan(0.2);
  });
});

describe('pickShownSlides', () => {
  const thumbs = new Map<string, Uint8Array>([
    ['slide_001.png', footage(1, 60)],
    ['slide_002.png', footage(2, 60)], // 1 と同じ場面
    ['slide_003.png', footage(3, 60)], // まだ同じ場面
    ['slide_004.png', footage(4, 220)], // 場面が変わる
    ['slide_005.png', footage(5, 220)], // 4 と同じ場面
  ]);

  it('映像中心の画面では、最後に載せた画像と同じ場面の画像を外す', () => {
    const slides = [1, 2, 3, 4, 5].map((n) => slide(n, 0.1));
    const d = pickShownSlides(slides, thumbs, 0.65);
    expect(d.map((x) => x.shown)).toEqual([true, false, false, true, false]);
    expect(d[1]!.sameSceneAs).toBe('slide_001.png');
    expect(d[4]!.sameSceneAs).toBe('slide_004.png');
  });

  it('スライド中心の画面（静止部分が半分以上）や、記録のない画像は外さない', () => {
    const slides = [slide(1, 0.9), slide(2, 0.9), slide(3), slide(4, 0.1), slide(5, 0.1)];
    const d = pickShownSlides(slides, thumbs, 0.65);
    // 1〜3 は対象外。4 は 3（載っている）と別の場面。5 は 4 と同じ場面
    expect(d.map((x) => x.shown)).toEqual([true, true, true, true, false]);
  });

  it('中身が同じ画像は、スライドでも映像でも外す', () => {
    const same = new Map(thumbs);
    same.set('slide_003.png', footage(2, 60)); // 2 とまったく同じ
    const slides = [slide(1, 0.9), slide(2, 0.9), slide(3, 0.9)]; // スライド扱い
    const d = pickShownSlides(slides, same, 0.65);
    expect(d.map((x) => x.shown)).toEqual([true, true, false]);
    expect(d[2]!.reason).toBe('identical');
  });

  it('閾値 0 なら場面のまとめはしない。サムネイルがない画像も載せる', () => {
    const slides = [1, 2, 3].map((n) => slide(n, 0.1));
    expect(pickShownSlides(slides, thumbs, 0).every((x) => x.shown)).toBe(true);
    const partial = new Map([['slide_001.png', footage(1, 60)]]);
    expect(pickShownSlides(slides, partial, 0.65).every((x) => x.shown)).toBe(true);
  });
});

describe('readThumbnail', () => {
  it('ffmpeg があれば 160×90 の RGBA を返し、壊れたファイルでは null', async () => {
    const ffmpeg = await resolveBin('ffmpeg');
    if (!ffmpeg) return; // CI など ffmpeg のない環境では飛ばす
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-scenes-'));
    const png = path.join(dir, 'red.png');
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x36', '-frames:v', '1', png]);
    const thumb = await readThumbnail(ffmpeg, png);
    expect(thumb?.length).toBe(PIXELS * 4);
    expect(thumb?.[0]).toBeGreaterThan(200); // R
    expect(thumb?.[1]).toBeLessThan(40); // G
    const broken = path.join(dir, 'broken.png');
    await writeFile(broken, 'not a png');
    expect(await readThumbnail(ffmpeg, broken)).toBeNull();
  });
});

describe('Vision の見た目の距離', () => {
  /** 白地に文字のスライド風（色の多様さが小さい）。shade で文字の濃さを変える */
  const slideLike = (shade: number) => {
    const f = new Uint8Array(PIXELS * 4).fill(255);
    for (let p = 0; p < PIXELS; p += 7) {
      f[p * 4] = shade;
      f[p * 4 + 1] = shade;
      f[p * 4 + 2] = shade;
    }
    return f;
  };
  /** 写真風（RGB がそれぞれ独立に散らばる = 色の多様さが大きい） */
  const photo = (seed: number) => {
    const f = new Uint8Array(PIXELS * 4);
    let x = seed;
    for (let i = 0; i < PIXELS * 4; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      f[i] = i % 4 === 3 ? 255 : (x >> 16) & 0xff;
    }
    return f;
  };
  const thumbs = new Map<string, Uint8Array>([
    ['slide_001.png', slideLike(20)],
    ['slide_002.png', slideLike(80)],
    ['slide_003.png', photo(1)],
    ['slide_004.png', photo(2)],
  ]);
  const slides = [1, 2, 3, 4].map((n) => slide(n, 0.9)); // スライド扱い（色の分布の判定は効かない）
  const withDistances = (table: Record<string, number>) => ({
    distance: (a: number, b: number) => table[`${Math.min(a, b)}-${Math.max(a, b)}`],
    tight: 0.2,
    photo: 0.55,
  });

  it('写真かどうかは色の多様さで見分ける', () => {
    expect(colorEntropy(slideLike(20))).toBeLessThan(3);
    expect(colorEntropy(photo(1))).toBeGreaterThan(3);
  });

  it('距離が小さければどんな画面でも外し、写真同士なら少し離れていても外す', () => {
    // 1→2: スライド同士で 0.3（テンプレートが同じだけ）→ 残す。3→4: 写真同士で 0.4 → 外す
    const d = pickShownSlides(slides, thumbs, 0.65, withDistances({ '0-1': 0.3, '1-2': 0.9, '2-3': 0.4 }));
    expect(d.map((x) => x.shown)).toEqual([true, true, true, false]);
    expect(d[3]!.reason).toBe('vision');
    expect(d[1]!.vision).toBe(0.3);
    // スライド同士でも 0.15（メニューを開いただけ）なら外す
    const e = pickShownSlides(slides, thumbs, 0.65, withDistances({ '0-1': 0.15, '1-2': 0.9, '2-3': 0.9 }));
    expect(e.map((x) => x.shown)).toEqual([true, false, true, true]);
  });

  it('比較の相手は「最後に載せた画像」', () => {
    // 2 を外したら、3 は 1 と比べる
    const d = pickShownSlides(slides, thumbs, 0.65, withDistances({ '0-1': 0.1, '0-2': 0.1, '1-2': 0.9, '2-3': 0.9 }));
    expect(d.map((x) => x.shown)).toEqual([true, false, false, true]);
    expect(d[2]!.sameSceneAs).toBe('slide_001.png');
  });

  it('距離が測れない組や Vision なしでは、色と画素の判定だけになる', () => {
    const d = pickShownSlides(slides, thumbs, 0.65, withDistances({}));
    expect(d.every((x) => x.shown)).toBe(true);
    expect(pickShownSlides(slides, thumbs, 0.65).every((x) => x.shown)).toBe(true);
  });
});
