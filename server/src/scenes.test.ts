import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBin, run } from './exec.ts';
import type { SlideEntry } from './merge.ts';
import { colorEntropy, colorMatch, pickShownSlides, readThumbnail, shownSlides, textContained, textSimilarity, THUMB_HEIGHT, THUMB_WIDTH } from './scenes.ts';

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
    const d = pickShownSlides(slides, thumbs, 0.65, undefined, 'first');
    expect(d.map((x) => x.shown)).toEqual([true, false, false, true, false]);
    expect(d[1]!.sameSceneAs).toBe('slide_001.png');
    expect(d[4]!.sameSceneAs).toBe('slide_004.png');
  });

  it('スライド中心の画面（静止部分が半分以上）や、記録のない画像は外さない', () => {
    const slides = [slide(1, 0.9), slide(2, 0.9), slide(3), slide(4, 0.1), slide(5, 0.1)];
    const d = pickShownSlides(slides, thumbs, 0.65, undefined, 'first');
    // 1〜3 は対象外。4 は 3（載っている）と別の場面。5 は 4 と同じ場面
    expect(d.map((x) => x.shown)).toEqual([true, true, true, true, false]);
  });

  it('中身が同じ画像は、スライドでも映像でも外す', () => {
    const same = new Map(thumbs);
    same.set('slide_003.png', footage(2, 60)); // 2 とまったく同じ
    const slides = [slide(1, 0.9), slide(2, 0.9), slide(3, 0.9)]; // スライド扱い
    const d = pickShownSlides(slides, same, 0.65, undefined, 'first');
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
    const d = pickShownSlides(slides, thumbs, 0.65, withDistances({ '0-1': 0.3, '1-2': 0.9, '2-3': 0.4 }), 'first');
    expect(d.map((x) => x.shown)).toEqual([true, true, true, false]);
    expect(d[3]!.reason).toBe('vision');
    expect(d[1]!.vision).toBe(0.3);
    // スライド同士でも 0.15（メニューを開いただけ）なら外す
    const e = pickShownSlides(slides, thumbs, 0.65, withDistances({ '0-1': 0.15, '1-2': 0.9, '2-3': 0.9 }), 'first');
    expect(e.map((x) => x.shown)).toEqual([true, false, true, true]);
  });

  it('比較の相手は「最後に載せた画像」', () => {
    // 2 を外したら、3 は 1 と比べる
    const d = pickShownSlides(slides, thumbs, 0.65, withDistances({ '0-1': 0.1, '0-2': 0.1, '1-2': 0.9, '2-3': 0.9 }), 'first');
    expect(d.map((x) => x.shown)).toEqual([true, false, false, true]);
    expect(d[2]!.sameSceneAs).toBe('slide_001.png');
  });

  it('距離が測れない組や Vision なしでは、色と画素の判定だけになる', () => {
    const d = pickShownSlides(slides, thumbs, 0.65, withDistances({}));
    expect(d.every((x) => x.shown)).toBe(true);
    expect(pickShownSlides(slides, thumbs, 0.65).every((x) => x.shown)).toBe(true);
  });
});

describe('写っている文字（Vision の文字認識）', () => {
  /** 白地に文字のスライド風。shade で文字の濃さを変える */
  const slideLike = (shade: number) => {
    const f = new Uint8Array(PIXELS * 4).fill(255);
    for (let p = 0; p < PIXELS; p += 7) {
      f[p * 4] = shade;
      f[p * 4 + 1] = shade;
      f[p * 4 + 2] = shade;
    }
    return f;
  };
  /** base の画素の 8% だけ変えた画像（箇条書きが 1 行増えた程度） */
  const grownFrom = (base: Uint8Array) => {
    const f = new Uint8Array(base);
    for (let p = 0; p < PIXELS * 0.08; p++) {
      f[p * 4] = 0;
      f[p * 4 + 1] = 0;
      f[p * 4 + 2] = 0;
    }
    return f;
  };
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
    ['slide_003.png', grownFrom(slideLike(80))],
    ['slide_004.png', photo(1)],
    ['slide_005.png', photo(2)],
  ]);
  const slides = [1, 2, 3, 4, 5].map((n) => slide(n, 0.9));
  const withVision = (distances: Record<string, number>, texts: Array<string | undefined>) => ({
    distance: (a: number, b: number) => distances[`${Math.min(a, b)}-${Math.max(a, b)}`],
    text: (i: number) => texts[i],
    tight: 0.2,
    photo: 0.45,
  });

  it('textSimilarity は読み違いを許し、textContained は一部だけ読めた字幕や増えた箇条書きを含むとみなす', () => {
    expect(textSimilarity('ネジレバネの幼虫は自分で歩いて寄生する', 'ネジレバネの幼虫は自分で歩いて寄生する')).toBe(1);
    expect(textSimilarity('ネジレバネの幼虫は自分で歩いて寄生する', 'ネジレバネの幼虫は自分で歩いて奇生する')).toBeGreaterThan(0.9);
    expect(textSimilarity('カメラ本体', '粗微動ユニット')).toBeLessThan(0.3);
    expect(textSimilarity('', '')).toBeUndefined();
    expect(textSimilarity('カメラ本体', '')).toBe(0);
    expect(textContained('カメラ本体\nカメラレンズ', 'カメラ本体\nベローズ\nカメラレンズ')).toBe(true);
    expect(textContained('ネジレバネの幼虫は自分で歩い\n幼虫に寄生す', 'ネジレバネの幼虫は自分で歩いてカメムシの幼虫に寄生する')).toBe(true);
    expect(textContained('カメラ本体', '粗微動ユニット')).toBe(false);
    expect(textContained('', 'カメラ本体')).toBe(false);
    // 行の順は問わない（ロゴと字幕の読まれる順が入れ替わる）
    expect(textSimilarity('MicroMate\n粗微動ユニット', '粗微動ユニット\nMicroMate')).toBe(1);
  });

  it('文字が同じ（または両方にない）で見た目も近ければ、スライド風の画面でも外す', () => {
    // 1→2: 距離 0.3。同じ字幕なら外す、字幕が違えば残す、両方に文字がなくても外す、読めていなければ残す
    const same = pickShownSlides(slides.slice(0, 2), thumbs, 0.65, withVision({ '0-1': 0.3 }, ['ネジレバネの幼虫', 'ネジレバネの幼虫']), 'first');
    expect(same.map((x) => x.shown)).toEqual([true, false]);
    expect(same[1]!.reason).toBe('text');
    expect(same[1]!.textSim).toBe(1);
    const differ = pickShownSlides(slides.slice(0, 2), thumbs, 0.65, withVision({ '0-1': 0.3 }, ['カメラ本体', '粗微動ユニット']), 'first');
    expect(differ.map((x) => x.shown)).toEqual([true, true]);
    const none = pickShownSlides(slides.slice(0, 2), thumbs, 0.65, withVision({ '0-1': 0.3 }, ['', '']), 'first');
    expect(none.map((x) => x.shown)).toEqual([true, false]);
    const unread = pickShownSlides(slides.slice(0, 2), thumbs, 0.65, withVision({ '0-1': 0.3 }, [undefined, undefined]), 'first');
    expect(unread.map((x) => x.shown)).toEqual([true, true]);
    // 距離が photo より大きければ文字が同じでも残す
    const far = pickShownSlides(slides.slice(0, 2), thumbs, 0.65, withVision({ '0-1': 0.6 }, ['ネジレバネの幼虫', 'ネジレバネの幼虫']), 'first');
    expect(far.map((x) => x.shown)).toEqual([true, true]);
    // 一方の文字が他方に含まれる（字幕が増えた）なら同じ扱い
    const grown = pickShownSlides(slides.slice(0, 2), thumbs, 0.65, withVision({ '0-1': 0.4 }, ['LEICA S9D', 'LEICA S9D\n対象物をそのままの向きで見られる顕微鏡']), 'first');
    expect(grown.map((x) => x.shown)).toEqual([true, false]);
    expect(grown[1]!.reason).toBe('text');
  });

  it('写真同士でも、両方に文字があって中身が違えばまとめない（別のラベルの別の写真）', () => {
    // 4→5 は写真同士で 0.4。ラベルが違えば残し、片方にしか文字がなければ（読めた文字がノイズ程度）写真同士の判定でまとめる
    const labelled = pickShownSlides(slides.slice(3, 5), thumbs, 0.65, withVision({ '0-1': 0.4 }, ['カメラ本体', '粗微動ユニット']), 'first');
    expect(labelled.map((x) => x.shown)).toEqual([true, true]);
    const noise = pickShownSlides(slides.slice(3, 5), thumbs, 0.65, withVision({ '0-1': 0.4 }, ['', 'lodanor']), 'first');
    expect(noise.map((x) => x.shown)).toEqual([true, false]);
    expect(noise[1]!.reason).toBe('vision');
    // 3 文字以下の読み取りは文字とみなさない
    const short = pickShownSlides(slides.slice(3, 5), thumbs, 0.65, withVision({ '0-1': 0.4 }, ['6S', 'W42']), 'first');
    expect(short.map((x) => x.shown)).toEqual([true, false]);
  });

  it('画素がほとんど同じで文字が一方に含まれるなら、途中の状態として外す（見た目の距離が離れていても）', () => {
    // 2→3: 画素の差 8%。字幕が出かけ（一部だけ読めた）で Vision の距離は 0.7
    const d = pickShownSlides(slides.slice(1, 3), thumbs, 0.65, withVision({ '0-1': 0.7 }, ['ネジレバネの幼虫は自分で歩い', 'ネジレバネの幼虫は自分で歩いて寄生する']), 'first');
    expect(d.map((x) => x.shown)).toEqual([true, false]);
    expect(d[1]!.reason).toBe('grown');
    // 文字が別物なら残す
    const e = pickShownSlides(slides.slice(1, 3), thumbs, 0.65, withVision({ '0-1': 0.7 }, ['カメラ本体', '粗微動ユニット']), 'first');
    expect(e.map((x) => x.shown)).toEqual([true, true]);
  });

  it('基準の画像とは離れても、直前の画像と文字が同じで近ければ外す（場面が少しずつ変わる）', () => {
    // 1→2: 0.3 で同じ字幕 → 外す。3 は 1 とは 0.6 だが 2 とは 0.3 → 外す（via は 2）
    const texts = ['同じ字幕', '同じ字幕', '同じ字幕'];
    const d = pickShownSlides(slides.slice(0, 3), thumbs, 0.65, withVision({ '0-1': 0.3, '0-2': 0.6, '1-2': 0.3 }, texts), 'first');
    expect(d.map((x) => x.shown)).toEqual([true, false, false]);
    expect(d[2]!.sameSceneAs).toBe('slide_001.png');
    expect(d[2]!.via).toBe('slide_002.png');
    expect(d[2]!.vision).toBe(0.3);
  });

  it('直前の画像とは、写真同士の広い判定は使わない', () => {
    // 写真 3 枚（文字は読めていない）。5 は 4 と 0.4 → 写真同士の判定で外す。
    // 6 は 4（基準）とは 0.6 で別物、5（直前）とは 0.4 だが、直前との比較に写真同士の広い判定は使わないので載る
    const withThird = new Map(thumbs);
    withThird.set('slide_006.png', photo(3));
    const six = [4, 5, 6].map((n) => slide(n, 0.9));
    const d = pickShownSlides(six, withThird, 0.65, withVision({ '0-1': 0.4, '0-2': 0.6, '1-2': 0.4 }, [undefined, undefined, undefined]), 'first');
    expect(d.map((x) => x.shown)).toEqual([true, false, true]);
  });
});

describe('同じ場面の最後の画像を載せる（既定）', () => {
  const thumbs = new Map<string, Uint8Array>([
    ['slide_001.png', footage(1, 60)],
    ['slide_002.png', footage(2, 60)],
    ['slide_003.png', footage(3, 60)],
    ['slide_004.png', footage(4, 220)],
  ]);
  const slides = [1, 2, 3, 4].map((n) => ({ ...slide(n, 0.1), reason: n === 1 ? 'initial' : 'change' }));

  it('まとまりの最後の画像を載せ、最初の画像は「譲った」として外す', () => {
    const d = pickShownSlides(slides, thumbs, 0.65);
    expect(d.map((x) => [x.filename.slice(6, 9), x.shown, x.reason ?? ''])).toEqual([
      ['001', false, 'superseded'],
      ['002', false, 'same-scene'],
      ['003', true, ''],
      ['004', true, ''],
    ]);
    expect(d[2]!.standsFor).toBe('slide_001.png');
    expect(d[0]!.sameSceneAs).toBe('slide_003.png');
  });

  it('載せる画像には、まとまりの最初の画像の時刻と理由を持たせる（発話の割り当てのため）', () => {
    const out = shownSlides(slides, pickShownSlides(slides, thumbs, 0.65));
    expect(out.map((s) => [s.filename, s.videoTime, s.reason, s.seq])).toEqual([
      ['slide_003.png', 10, 'initial', 3],
      ['slide_004.png', 40, 'change', 4],
    ]);
  });
});
