import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBin, run } from './exec.ts';
import type { SlideEntry } from './merge.ts';
import {
  colorEntropy,
  colorMatch,
  columnMatch,
  labelText,
  panResidual,
  pickShownSlides,
  pixelDiff,
  readThumbnail,
  rowProfile,
  rowScroll,
  sharedLabelLines,
  sharedLineRatio,
  shownSlides,
  textContained,
  textSimilarity,
  THUMB_HEIGHT,
  THUMB_WIDTH,
  uniformFraction,
} from './scenes.ts';

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

/**
 * 白地に横線だけの画面（文字中心のスライドの代わり。色の多様さは写真に届かず、行の並びにも凹凸が少ない）。
 * seed で線の位置が変わり、画素の 2 割ほどが違う（「中身が同じ」には掛からない）
 */
function paper(seed: number): Uint8Array {
  const f = new Uint8Array(PIXELS * 4).fill(255);
  for (let y = 6 + seed * 3; y < 84; y += 12) {
    for (let dy = 0; dy < 3; dy++) for (let x = 10; x < 150; x++) f.set([20, 20, 20], ((y + dy) * THUMB_WIDTH + x) * 4);
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

describe('まとまりの前の方の画像との比較と、文字の読み取りが安定しない場面（2026-09-17）', () => {
  const slideLike = (shade: number) => {
    const f = new Uint8Array(PIXELS * 4).fill(255);
    for (let p = 0; p < PIXELS; p += 7) {
      f[p * 4] = shade;
      f[p * 4 + 1] = shade;
      f[p * 4 + 2] = shade;
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
  const four = [1, 2, 3, 4].map((n) => slide(n, 0.9));
  // 隣り合う濃さの差を PIXEL_DIFF（24）より大きくして、「中身が同じ」の規則が先に効かないようにする
  const slideThumbs = new Map<string, Uint8Array>([1, 2, 3, 4].map((n) => [`slide_00${n}.png`, slideLike(20 + 50 * n)]));
  const photoThumbs = new Map<string, Uint8Array>([1, 2, 3, 4].map((n) => [`slide_00${n}.png`, photo(n)]));
  const withVision = (distances: Record<string, number>, texts: Array<string | undefined>) => ({
    distance: (a: number, b: number) => distances[`${Math.min(a, b)}-${Math.max(a, b)}`],
    text: (i: number) => texts[i],
    tight: 0.2,
    photo: 0.45,
  });

  it('基準とも直前とも離れていても、まとまりの前の方の画像と見た目がごく近ければ外す', () => {
    // 2・3 は 1 と 0.15 で同じまとまり。4 は 1（基準）とも 3（直前）とも 0.3 だが、2 とは 0.15
    const d = pickShownSlides(four, slideThumbs, 0.65, withVision({ '0-1': 0.15, '0-2': 0.15, '0-3': 0.3, '2-3': 0.3, '1-3': 0.15 }, []), 'first');
    expect(d.map((x) => x.shown)).toEqual([true, false, false, false]);
    expect(d[3]!.via).toBe('slide_002.png');
    expect(d[3]!.reason).toBe('vision');
  });

  it('まとまりの前の方の画像とは、文字の規則では比べない（同じ型の別スライドは見出しやフッターが共通）', () => {
    // 4 の文字は 2 と同じだが、見た目は 2 と 0.3。直前（3）とも基準（1）とも文字が違う → 載せる
    const texts = ['見出し 赤', '見出し 黄色', '見出し 青', '見出し 黄色'];
    const d = pickShownSlides(four, slideThumbs, 0.65, withVision({ '0-1': 0.15, '0-2': 0.15, '0-3': 0.3, '2-3': 0.3, '1-3': 0.3 }, texts), 'first');
    expect(d.map((x) => x.shown)).toEqual([true, false, false, true]);
  });

  it('まとまりの中で文字の読み取りが食い違っていたら、文字の違いを別の写真の根拠にしない（手書きの板書）', () => {
    // 2 は 1 と 0.15 で同じまとまりだが、同じ板書が別の文字に読まれている → この場面の文字は信用しない。
    // 3 は 1 と 0.4（写真同士の広い判定の範囲）で、文字はまた違って読まれているが、外す
    const noisy = ['PLOT BAsceT KEN', 'PLOT EAsckET Gれした KEN', 'PLOT 54SsceT KEN'];
    const d = pickShownSlides(four.slice(0, 3), photoThumbs, 0.65, withVision({ '0-1': 0.15, '0-2': 0.4, '1-2': 0.4 }, noisy), 'first');
    expect(d.map((x) => x.shown)).toEqual([true, false, false]);
    expect(d[2]!.reason).toBe('vision');
    // 読み取りが安定していれば（2 の文字が 1 と同じ）、別のラベルは今までどおり残す
    const stable = ['カメラ本体', 'カメラ本体', '粗微動ユニット'];
    const e = pickShownSlides(four.slice(0, 3), photoThumbs, 0.65, withVision({ '0-1': 0.15, '0-2': 0.4, '1-2': 0.4 }, stable), 'first');
    expect(e.map((x) => x.shown)).toEqual([true, false, true]);
  });

  it('文字を信用しない状態は、基準が変わればリセットされる', () => {
    // 1 のまとまりは読み取りが食い違っている。3 は 0.6 で別の場面（新しい基準）。4 は 3 と 0.4 で、ラベルが違う → 残す
    const texts = ['PLOT BAsceT KEN', 'PLOT EAsckET KEN', 'レンズ本体', 'レンズ台座'];
    const d = pickShownSlides(four, photoThumbs, 0.65, withVision({ '0-1': 0.15, '0-2': 0.6, '1-2': 0.6, '0-3': 0.6, '2-3': 0.4, '1-3': 0.6 }, texts), 'first');
    expect(d.map((x) => x.shown)).toEqual([true, false, true, true]);
  });
});

describe('画面を少しスクロール・パンしただけの組（2026-09-20）', () => {
  /** アプリの操作画面: 動かない枠（上と左のツールバー）の中で、図形の並んだキャンバスだけが shift 画素ずれる */
  // 図形の位置と幅はそろえない（等間隔だと、間隔の分だけずらしても合ってしまう）
  const SHAPES = [
    { x: 0, w: 10, y0: 25, y1: 75, color: [230, 40, 40] },
    { x: 31, w: 16, y0: 20, y1: 60, color: [250, 220, 0] },
    { x: 58, w: 8, y0: 35, y1: 80, color: [30, 90, 200] },
    { x: 97, w: 14, y0: 15, y1: 70, color: [20, 150, 80] },
  ];
  /** 描き直した別の状態: 位置も大きさも違う */
  const EDITED = [
    { x: 12, w: 22, y0: 40, y1: 55, color: [230, 40, 40] },
    { x: 45, w: 6, y0: 12, y1: 85, color: [250, 220, 0] },
    { x: 76, w: 30, y0: 60, y1: 72, color: [30, 90, 200] },
  ];
  const appScreen = (shift: number, edited = false) => {
    const f = new Uint8Array(PIXELS * 4);
    for (let y = 0; y < THUMB_HEIGHT; y++) {
      for (let x = 0; x < THUMB_WIDTH; x++) {
        const canvas = x >= 12 && y >= 10;
        const cx = x - 12 - shift;
        const shape = canvas ? (edited ? EDITED : SHAPES).find((s) => cx >= s.x && cx < s.x + s.w && y >= s.y0 && y < s.y1) : undefined;
        const color = !canvas ? [60, 60, 60] : (shape?.color ?? [255, 255, 255]);
        f.set([...color, 255], (y * THUMB_WIDTH + x) * 4);
      }
    }
    return f;
  };
  /** 白地に本文だけが違うスライド: 行の位置は同じで、字の並び（seed）が違う */
  const textSlide = (seed: number) => {
    const f = new Uint8Array(PIXELS * 4).fill(255);
    let r = seed;
    for (let y = 20; y < 80; y += 8) {
      for (let x = 20; x < 140; x++) {
        r = (r * 1103515245 + 12345) & 0x7fffffff;
        if ((r >> 16) % 3 === 0) for (let dy = 0; dy < 3; dy++) f.set([30, 30, 30], ((y + dy) * THUMB_WIDTH + x) * 4);
      }
    }
    return f;
  };
  const vision = (d: number) => ({ distance: () => d, tight: 0.2, photo: 0.55 });

  it('キャンバスがずれただけなら、違っている画素のほとんどが平行移動で説明できる', () => {
    const r = panResidual(appScreen(9), appScreen(0));
    expect(r.diff).toBeGreaterThan(0.1);
    expect(r.left / r.diff).toBeLessThan(0.2);
    // 周り 1 画素のずれを許しているので、見つかる移動量も 1 画素の幅を持つ
    expect(Math.abs(Math.abs(r.dx) - 9)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.dy)).toBeLessThanOrEqual(1);
  });

  it('図形を描き直した画面は、どう動かしても説明できない', () => {
    const r = panResidual(appScreen(0, true), appScreen(0));
    expect(r.diff).toBeGreaterThan(0.1);
    expect(r.left / r.diff).toBeGreaterThan(0.6);
  });

  it('見た目の距離が「ごく近い」をわずかに超えていても、パンしただけなら外す', () => {
    const thumbs = new Map([['slide_001.png', appScreen(0)], ['slide_002.png', appScreen(9)]]);
    const d = pickShownSlides([slide(1, 1), slide(2, 1)], thumbs, 0.65, vision(0.23), 'first');
    expect(d.map((x) => [x.shown, x.reason])).toEqual([[true, undefined], [false, 'panned']]);
    expect(Math.abs(Math.abs(d[1]!.panShift![0]) - 9)).toBeLessThanOrEqual(1);
    // 見た目が離れている組（0.35 超）には使わない
    expect(pickShownSlides([slide(1, 1), slide(2, 1)], thumbs, 0.65, vision(0.4), 'first').map((x) => x.shown)).toEqual([true, true]);
    // --scene-vision-photo 0（見た目での判定を止める設定）ではこの規則も効かない
    const off = { distance: () => 0, tight: 0, photo: 0 };
    expect(pickShownSlides([slide(1, 1), slide(2, 1)], thumbs, 0.65, off, 'first').map((x) => x.shown)).toEqual([true, true]);
  });

  it('本文だけが違うスライドや、図形を描き直した画面は、見た目の距離が同じくらいでも残す', () => {
    // 白地が大半のスライドは、説明できた画素が全体の 1 割に届かない
    const text = new Map([['slide_001.png', textSlide(1)], ['slide_002.png', textSlide(2)]]);
    expect(pickShownSlides([slide(1, 1), slide(2, 1)], text, 0.65, vision(0.23), 'first').map((x) => x.shown)).toEqual([true, true]);
    const edited = new Map([['slide_001.png', appScreen(0)], ['slide_002.png', appScreen(0, true)]]);
    expect(pickShownSlides([slide(1, 1), slide(2, 1)], edited, 0.65, vision(0.23), 'first').map((x) => x.shown)).toEqual([true, true]);
  });

  /** Web ページ: 上の帯（ヘッダー）は動かず、その下のページだけが (sx, sy) 画素動く。図形の大きさと位置はそろえない */
  const PAGE_SHAPES = [
    { x: 5, y: 10, w: 40, h: 14, color: [230, 40, 40] },
    { x: 60, y: 24, w: 70, h: 8, color: [30, 90, 200] },
    { x: 10, y: 40, w: 25, h: 22, color: [250, 220, 0] },
    { x: 80, y: 52, w: 50, h: 12, color: [20, 150, 80] },
    { x: 30, y: 72, w: 90, h: 6, color: [90, 90, 90] },
  ];
  /** 横長で背の低い図形だけのページ。横に 9 画素ずらしても、変わるのは両端の 2 × 9 × 12 画素 × 4 個 = 全体の 6% */
  const FLAT_SHAPES = [
    { x: 5, y: 10, w: 60, h: 12, color: [230, 40, 40] },
    { x: 70, y: 28, w: 70, h: 12, color: [30, 90, 200] },
    { x: 20, y: 48, w: 100, h: 12, color: [90, 90, 90] },
    { x: 40, y: 68, w: 80, h: 12, color: [20, 150, 80] },
  ];
  const webPage = (sx: number, sy: number, shapes = PAGE_SHAPES) => {
    const f = new Uint8Array(PIXELS * 4);
    for (let y = 0; y < THUMB_HEIGHT; y++) {
      for (let x = 0; x < THUMB_WIDTH; x++) {
        const body = y >= 8;
        const shape = body ? shapes.find((q) => x - sx >= q.x && x - sx < q.x + q.w && y - sy >= q.y && y - sy < q.y + q.h) : undefined;
        f.set([...(body ? (shape?.color ?? [255, 255, 255]) : [40, 40, 40]), 255], (y * THUMB_WIDTH + x) * 4);
      }
    }
    return f;
  };
  const pickPair = (a: Uint8Array, b: Uint8Array) =>
    pickShownSlides([slide(1, 1), slide(2, 1)], new Map([['slide_001.png', a], ['slide_002.png', b]]), 0.65, vision(0.23), 'first');

  it('縦のスクロールでも斜めの移動でも、向きによらず見つけてまとめる', () => {
    for (const [sx, sy] of [[0, 6], [0, -10], [0, 12], [7, 5], [-9, -4]] as const) {
      // a(p) = b(p + d) となる d を返すので、(sx, sy) 動かした画面と元の画面なら d = (-sx, -sy)
      const r = panResidual(webPage(sx, sy), webPage(0, 0));
      expect(Math.abs(r.dx + sx), `dx for (${sx}, ${sy})`).toBeLessThanOrEqual(1);
      expect(Math.abs(r.dy + sy), `dy for (${sx}, ${sy})`).toBeLessThanOrEqual(1);
      expect(pickPair(webPage(0, 0), webPage(sx, sy)).map((x) => [x.shown, x.reason]), `(${sx}, ${sy})`).toEqual([[true, undefined], [false, 'panned']]);
    }
  });

  it('探す範囲（横 24 画素）を超えて横に動いた画面は別の画面として残し、縦に超えた画面は「大きくスクロールした組」の規則が引き取る', () => {
    expect(pickPair(webPage(0, 0), webPage(32, 0)).map((x) => x.shown)).toEqual([true, true]);
    // 縦 18 画素は平行移動では説明しきれない（残り 4 割超）が、行の並びが重なるので 5c で外れる（5b と 5c の境目）
    const r = panResidual(webPage(0, 18), webPage(0, 0));
    expect(r.left / r.diff).toBeGreaterThan(0.4);
    expect(pickPair(webPage(0, 0), webPage(0, 18)).map((x) => [x.shown, x.reason])).toEqual([[true, undefined], [false, 'scrolled']]);
  });

  it('移動は見つかっても、変わった画素が全体の 1 割に届かない小さなパンは、この規則では外さない', () => {
    // 本文だけが違うスライドを誤ってまとめないための条件（PAN_MIN_EXPLAINED）。変化が 5% 以下なら「中身が同じ」の規則が先にまとめる
    const r = panResidual(webPage(9, 0, FLAT_SHAPES), webPage(0, 0, FLAT_SHAPES));
    expect(Math.abs(r.dx + 9)).toBeLessThanOrEqual(1);
    expect(r.left / r.diff).toBeLessThan(0.4);
    expect(r.diff).toBeGreaterThan(0.05);
    expect(r.diff).toBeLessThan(0.1);
    expect(pickPair(webPage(0, 0, FLAT_SHAPES), webPage(9, 0, FLAT_SHAPES)).map((x) => x.shown)).toEqual([true, true]);
  });

  it('基準の画像とだけ比べる。少しずつスクロールし続けても、探す範囲を超えたところで次の 1 枚が残る', () => {
    const thumbs = new Map([9, 18, 27, 36].map((shift, i) => [`slide_00${i + 2}.png`, appScreen(shift)] as [string, Uint8Array]));
    thumbs.set('slide_001.png', appScreen(0));
    const d = pickShownSlides([1, 2, 3, 4, 5].map((n) => slide(n, 1)), thumbs, 0.65, vision(0.23), 'first');
    // 002（9 画素）と 003（18 画素）は 001 のまとまり。004（27 画素）は範囲（24 画素）の外なので残り、005 は 004 のまとまり
    expect(d.map((x) => x.shown)).toEqual([true, false, false, true, false]);
  });
});

describe('前の画面に短く戻っただけの画像（2026-09-20）', () => {
  /** 画面ごとに濃さの違う画像（上半分と下半分で濃さを変え、「ほぼ一色」にはしない）。同じ番号なら中身が同じ、違う番号なら全画素が違う */
  const screen = (n: number) => {
    const f = new Uint8Array(PIXELS * 4).fill(255);
    for (let p = 0; p < PIXELS; p++) {
      const v = 40 * n + (p < PIXELS / 2 ? 0 : 60);
      f.set([v, v, v], p * 4);
    }
    return f;
  };
  /** times の時刻（秒）に screens の画面が撮れた講義 */
  const lecture = (screens: number[], times: number[]) => {
    const slides = screens.map((_, i) => ({ ...slide(i + 1, 1), videoTime: times[i]! }));
    const thumbs = new Map(screens.map((n, i) => [slides[i]!.filename, screen(n)] as [string, Uint8Array]));
    return { slides, thumbs };
  };
  const pick = (screens: number[], times: number[], keep: 'first' | 'last' = 'first') => {
    const { slides, thumbs } = lecture(screens, times);
    return pickShownSlides(slides, thumbs, 0.65, undefined, keep);
  };

  it('A → B → A → B と行き来して、戻っていたのが 10 秒未満なら A と B の 2 枚だけ載せる', () => {
    const d = pick([1, 2, 1, 2, 3], [0, 36, 58, 65, 77]);
    expect(d.map((x) => [x.shown, x.reason])).toEqual([[true, undefined], [true, undefined], [false, 'revisit'], [false, 'identical'], [true, undefined]]);
    expect(d[2]).toMatchObject({ sameSceneAs: 'slide_002.png', via: 'slide_001.png' });
  });

  it('戻って 10 秒以上話しているなら、その画像も載せる', () => {
    expect(pick([1, 2, 1, 2, 3], [0, 36, 58, 70, 90]).map((x) => x.shown)).toEqual([true, true, true, true, true]);
  });

  it('最後まで戻ったまま、または時刻が巻き戻っている（シークした）ときは、長さが分からないので載せる', () => {
    expect(pick([1, 2, 1], [0, 36, 58]).map((x) => x.shown)).toEqual([true, true, true]);
    expect(pick([1, 2, 1, 3], [0, 36, 58, 20]).map((x) => x.shown)).toEqual([true, true, true, true]);
  });

  it('戻っている間に同じ画面がもう 1 枚撮れたら、合わせた長さで決め、どちらも載せない', () => {
    expect(pick([1, 2, 1, 1, 2], [0, 36, 58, 61, 66]).map((x) => [x.shown, x.reason])).toEqual([
      [true, undefined], [true, undefined], [false, 'revisit'], [false, 'revisit'], [false, 'identical'],
    ]);
    // 合わせて 10 秒以上なら、戻った画面として載せる（2 枚目は 1 枚目と同じなので外れる）
    expect(pick([1, 2, 1, 1, 2], [0, 36, 58, 61, 70]).map((x) => x.shown)).toEqual([true, true, true, false, true]);
  });

  it('短い戻りのあとでもう一度、今度は長く戻ったら、その画像は載せる（前の短い戻りに引きずられない）', () => {
    const d = pick([1, 2, 1, 2, 1, 3], [0, 36, 58, 63, 100, 160]);
    expect(d.map((x) => x.shown)).toEqual([true, true, false, false, true, true]);
  });

  it('戻った先から少しずつ離れていったら、離れた時点で載せる（戻りの扱いを引きずらない）', () => {
    // 画素の 4% ずつ変わっていく画面。直前の 1 枚とだけ比べて連ねると、戻った先とは似ていない画像まで
    // ずっと「戻っただけ」として外れ続け、その区間に載る画像が 1 枚も無くなっていた
    const step = Math.floor(PIXELS * 0.04);
    /** 上半分が白、下半分が灰色の画面（「ほぼ一色」にはしない）。上半分の先頭 flipped 画素だけ黒くする */
    const drift = (flipped: number) => {
      const f = new Uint8Array(PIXELS * 4).fill(255);
      for (let p = PIXELS / 2; p < PIXELS; p++) f.set([100, 100, 100], p * 4);
      for (let p = 0; p < flipped; p++) f.set([0, 0, 0], p * 4);
      return f;
    };
    /** 濃さ v の画面（上半分 v、下半分 v + 60。「ほぼ一色」にはしない） */
    const flat = (v: number) => {
      const f = new Uint8Array(PIXELS * 4).fill(255);
      for (let p = 0; p < PIXELS; p++) {
        const w = Math.min(255, v + (p < PIXELS / 2 ? 0 : 60));
        f.set([w, w, w], p * 4);
      }
      return f;
    };
    const frames: [Uint8Array, number][] = [[drift(0), 0], [flat(0), 30], [drift(0), 60], [drift(step), 62], [drift(step * 2), 64], [flat(120), 200]];
    const slides = frames.map(([, videoTime], i) => ({ ...slide(i + 1, 1), videoTime }));
    const thumbs = new Map(frames.map(([img], i) => [slides[i]!.filename, img] as [string, Uint8Array]));
    const d = pickShownSlides(slides, thumbs, 0.65, undefined, 'first');
    // 60 秒に戻った 2 枚は外れるが、そこから離れた 64 秒の画面は載る（60〜200 秒が画像なしにならない）
    expect(d.map((x) => [x.shown, x.reason])).toEqual([
      [true, undefined], [true, undefined], [false, 'revisit'], [false, 'revisit'], [true, undefined], [true, undefined],
    ]);
  });

  it('戻っている間に画面が少しずつ変わっても、合計 10 秒を超えたらそこから載せる', () => {
    // 1 枚ずつの「この画面が続いた時間」だけで決めると、6 秒ごとに少し変わる長い戻りが丸ごと外れて、
    // その区間に載る画像が 1 枚も無くなっていた
    const step = Math.floor(PIXELS * 0.04);
    /** 上半分が白、下半分が灰色の画面（「ほぼ一色」にはしない）。上半分の先頭 flipped 画素だけ黒くする */
    const drift = (flipped: number) => {
      const f = new Uint8Array(PIXELS * 4).fill(255);
      for (let p = PIXELS / 2; p < PIXELS; p++) f.set([100, 100, 100], p * 4);
      for (let p = 0; p < flipped; p++) f.set([0, 0, 0], p * 4);
      return f;
    };
    /** 濃さ v の画面（上半分 v、下半分 v + 60。「ほぼ一色」にはしない） */
    const flat = (v: number) => {
      const f = new Uint8Array(PIXELS * 4).fill(255);
      for (let p = 0; p < PIXELS; p++) {
        const w = Math.min(255, v + (p < PIXELS / 2 ? 0 : 60));
        f.set([w, w, w], p * 4);
      }
      return f;
    };
    // A（0 秒）→ B（60 秒）→ A に戻って 6 秒ごとに 8% ずつ揺れる（120〜150 秒）→ C（240 秒）
    const frames: Array<[Uint8Array, number]> = [
      [drift(0), 0], [drift(step), 5], [flat(200), 60],
      [drift(0), 120], [drift(step * 2), 126], [drift(0), 132], [drift(step * 2), 138],
      [flat(120), 240],
    ];
    const slides = frames.map(([, videoTime], i) => ({ ...slide(i + 1, 1), videoTime }));
    const thumbs = new Map(frames.map(([img], i) => [slides[i]!.filename, img] as [string, Uint8Array]));
    const d = pickShownSlides(slides, thumbs, 0.65, undefined, 'first');
    // 120・126 秒は短い戻りとして外れるが、10 秒を超えた 132 秒からは載る（120〜240 秒が画像なしにならない）
    expect(d.map((x) => [x.shown, x.reason])).toEqual([
      [true, undefined], [false, 'identical'], [true, undefined],
      [false, 'revisit'], [false, 'revisit'], [true, undefined], [true, undefined],
      [true, undefined],
    ]);
  });

  it('最後の 1 枚を載せる設定でも、戻っただけの画像は今の画面の代わりに選ばない', () => {
    // B のまとまりは [B, 戻っただけの A]。載せるのは B のまま
    const d = pick([1, 2, 1, 3], [0, 36, 58, 63], 'last');
    expect(d.map((x) => [x.filename, x.shown])).toEqual([['slide_001.png', true], ['slide_002.png', true], ['slide_003.png', false], ['slide_004.png', true]]);
    // [B, 戻っただけの A, B] なら最後の B を載せ、戻っただけの A もその画像を指す
    const e = pick([1, 2, 1, 2, 3], [0, 36, 58, 65, 77], 'last');
    expect(e.map((x) => x.shown)).toEqual([true, false, false, true, true]);
    expect(e[3]).toMatchObject({ standsFor: 'slide_002.png' });
    expect(e[2]).toMatchObject({ reason: 'revisit', sameSceneAs: 'slide_004.png' });
  });
});

describe('ほぼ一色の画像（2026-09-22）', () => {
  const solid = (v: number) => new Uint8Array(PIXELS * 4).fill(v);
  /** 一色の地に、marks 画素だけ反対の色の印を置く */
  const withMark = (v: number, marks: number) => {
    const f = solid(v);
    for (let p = 0; p < marks; p++) f.set([255 - v, 255 - v, 255 - v], p * 4);
    return f;
  };
  const thumbs = (...frames: Uint8Array[]) => new Map(frames.map((f, i) => [`slide_${String(i + 1).padStart(3, '0')}.png`, f] as [string, Uint8Array]));

  it('uniformFraction は一色なら 1、印のある分だけ下がる', () => {
    expect(uniformFraction(solid(0))).toBe(1);
    expect(uniformFraction(solid(128))).toBe(1);
    expect(uniformFraction(withMark(0, 144))).toBeCloseTo(0.99, 3);
    expect(uniformFraction(footage(1))).toBeLessThan(0.9);
  });

  it('真っ黒・灰色の画像は載せず、比較の基準にもしない（前後の同じ場面はつながったまま）', () => {
    const d = pickShownSlides([slide(1, 0.2), slide(2, 0.2), slide(3, 0.2)], thumbs(footage(1, 60), solid(0), footage(2, 60)), 0.65, undefined, 'first');
    expect(d.map((x) => [x.shown, x.reason])).toEqual([[true, undefined], [false, 'blank'], [false, 'same-scene']]);
    // 今載っている画像を指す（間の発話はその下に入る。scenes.json から辿れる）
    expect(d[1]!.sameSceneAs).toBe('slide_001.png');
    // 最初の 1 枚が一色（動画の先頭の灰色）でも、次の画像が基準になる
    const e = pickShownSlides([slide(1, 0.2), slide(2, 0.2)], thumbs(solid(128), footage(1)), 0.65, undefined, 'first');
    expect(e.map((x) => [x.shown, x.reason])).toEqual([[false, 'blank'], [true, undefined]]);
    // 最後の 1 枚を載せる設定でも、一色の画像はまとまりの代わりに選ばれない
    const f = pickShownSlides([slide(1, 0.2), slide(2, 0.2), slide(3, 0.2)], thumbs(footage(1, 60), footage(2, 60), solid(0)), 0.65, undefined, 'last');
    expect(f.map((x) => [x.filename, x.shown])).toEqual([['slide_001.png', false], ['slide_002.png', true], ['slide_003.png', false]]);
  });

  it('白地に短い見出しがあるだけの画像や、暗い画面に読める文字がある画像は残す（印が 1% あれば一色ではない）', () => {
    for (const frame of [withMark(255, 150), withMark(20, 300)]) {
      expect(uniformFraction(frame)).toBeLessThan(0.995);
      expect(pickShownSlides([slide(1, 1)], thumbs(frame), 0.65, undefined, 'first')[0]!.shown).toBe(true);
    }
  });

  it('画素ではほぼ一色でも、文字認識が何か読めた画像は残す（淡い文字のタイトル、細い罫線）', () => {
    const faint = withMark(255, 40); // 0.3% の印。画素だけなら一色
    expect(uniformFraction(faint)).toBeGreaterThan(0.995);
    const read = { distance: () => 1, tight: 0.2, photo: 0.55, text: () => '第3章' };
    expect(pickShownSlides([slide(1, 1)], thumbs(faint), 0.65, read, 'first')[0]!.shown).toBe(true);
    const unread = { ...read, text: () => '' };
    expect(pickShownSlides([slide(1, 1)], thumbs(faint), 0.65, unread, 'first')[0]!.reason).toBe('blank');
  });

  it('ほぼ一色の画像は、直前の画像としての比較にも使わない（真っ黒と「暗い背景に字幕」は画素差 3% で同じに見える）', () => {
    const caption = withMark(20, 400); // 暗い背景に字幕（一色ではない: 97.2%）
    expect(pixelDiff(solid(0), caption)).toBeLessThan(0.05);
    const d = pickShownSlides([slide(1, 1), slide(2, 1), slide(3, 1)], thumbs(footage(1, 128), solid(0), caption), 0.65, undefined, 'first');
    expect(d.map((x) => [x.shown, x.reason])).toEqual([[true, undefined], [false, 'blank'], [true, undefined]]);
  });

  it('フェードのコマを挟んでも、「この画面が続いた時間」はそこで途切れない（長い戻りが短い戻りに見えない）', () => {
    const A = footage(1, 60);
    const B = footage(2, 220);
    const frames: Array<[Uint8Array, number]> = [[A, 0], [B, 10], [A, 20], [solid(0), 23], [A, 200]];
    const slides = frames.map(([, videoTime], i) => ({ ...slide(i + 1, 1), videoTime }));
    const d = pickShownSlides(slides, thumbs(...frames.map(([f]) => f)), 0.65, undefined, 'first');
    // 20 秒に戻った A は 200 秒まで続く（真っ黒を飛ばして測る）ので短い戻りではなく、載る
    expect(d.map((x) => [x.shown, x.reason])).toEqual([[true, undefined], [true, undefined], [true, undefined], [false, 'blank'], [false, 'identical']]);
  });
});

describe('画面を大きくスクロールした組（2026-09-22）', () => {
  // 色は 3 つだけにして、色の多様さが写真の判定（3 ビット）に届かないようにする（届くと写真同士の規則が先にまとめる）
  const RED = [230, 40, 40];
  const BLUE = [30, 90, 200];
  const DARK = [50, 50, 50];
  type Band = { y: number; h: number; color: number[]; x?: number; w?: number };
  /**
   * 帯が並ぶ長いページ（帯の高さ・間隔・横の位置と幅はそろえない。そろえると、数行の平行移動でも別の帯同士が合ってしまい
   * 5b が先にまとめる）。90 行より下の帯はスクロールすると現れる
   */
  const BANDS: Band[] = [
    { y: 4, h: 9, x: 0, w: 120, color: RED },
    { y: 20, h: 5, x: 30, w: 130, color: BLUE },
    { y: 31, h: 13, x: 10, w: 90, color: DARK },
    { y: 52, h: 7, x: 50, w: 100, color: RED },
    { y: 66, h: 11, x: 0, w: 70, color: BLUE },
    { y: 84, h: 4, x: 20, w: 140, color: DARK },
    { y: 96, h: 10, x: 40, w: 80, color: RED },
    { y: 112, h: 6, x: 5, w: 110, color: BLUE },
  ];
  const GREEN = [20, 150, 80];
  const ORANGE = [240, 150, 30];
  /** 別のページ: 帯の色も位置も高さも違う（余白の白は同じ） */
  const OTHER_BANDS: Band[] = [
    { y: 8, h: 16, x: 20, w: 100, color: GREEN },
    { y: 30, h: 3, x: 0, w: 160, color: ORANGE },
    { y: 39, h: 18, x: 60, w: 90, color: GREEN },
    { y: 63, h: 3, x: 10, w: 80, color: ORANGE },
    { y: 72, h: 15, x: 30, w: 120, color: GREEN },
  ];
  /** ページを sy 行だけ下に（sx 画素だけ右に）送った画面 */
  const page = (sy: number, bands = BANDS, sx = 0) => {
    const f = new Uint8Array(PIXELS * 4).fill(255);
    for (let y = 0; y < THUMB_HEIGHT; y++) {
      const band = bands.find((b) => y + sy >= b.y && y + sy < b.y + b.h);
      if (!band) continue;
      const x0 = Math.max(0, (band.x ?? 0) - sx);
      const x1 = Math.min(THUMB_WIDTH, (band.x ?? 0) + (band.w ?? THUMB_WIDTH) - sx);
      for (let x = x0; x < x1; x++) f.set([...band.color, 255], (y * THUMB_WIDTH + x) * 4);
    }
    return f;
  };
  const vision = (d: number, text?: (i: number) => string | undefined) => ({ distance: () => d, tight: 0.2, photo: 0.55, ...(text ? { text } : {}) });
  const pickPair = (a: Uint8Array, b: Uint8Array, v = vision(0.3)) =>
    pickShownSlides([slide(1, 1), slide(2, 1)], new Map([['slide_001.png', a], ['slide_002.png', b]]), 0.65, v, 'first');

  const scroll = (a: Uint8Array, b: Uint8Array) => rowScroll(rowProfile(a), rowProfile(b));
  /** カードが散らばる長いページ（位置も大きさもそろえない。列にも凹凸がある）。sy 行下に、sx 画素右に送った画面 */
  const CARDS: Band[] = [
    { y: 5, h: 12, x: 10, w: 40, color: DARK },
    { y: 20, h: 9, x: 70, w: 50, color: BLUE },
    { y: 38, h: 14, x: 20, w: 60, color: RED },
    { y: 60, h: 10, x: 90, w: 45, color: DARK },
    { y: 78, h: 8, x: 5, w: 35, color: BLUE },
    { y: 96, h: 12, x: 60, w: 70, color: RED },
    { y: 114, h: 9, x: 110, w: 40, color: DARK },
  ];
  const cards = (sy: number, sx = 0) => page(sy, CARDS, sx);

  it('rowScroll は、帯の並びが重なるずれと、そのときの一致を返す', () => {
    expect(colorEntropy(page(0))).toBeLessThan(3);
    const r = scroll(page(0), page(20));
    // a の行 y が b の行 y + dy と重なるので、20 行スクロールした画面とは dy = -20
    expect(Math.abs(r.dy! + 20)).toBeLessThanOrEqual(1);
    expect(r.match).toBeGreaterThan(0.8);
    expect(r.structure).toBeGreaterThan(0.3);
    // 別のページは、余白の白同士しか合わないので、まとめる線（0.6）に届かない
    expect(scroll(page(0), page(0, OTHER_BANDS)).match).toBeLessThan(0.6);
  });

  it('行の並びが周期的で中身の並びだけ違うリストは、列の並びが合わないので残す', () => {
    // 10 行周期のリスト。P は左端に、Q は右端に濃いセルがある（行の平均色は同じ）
    const list = (x0: number) => {
      const f = new Uint8Array(PIXELS * 4).fill(255);
      for (let y = 0; y < THUMB_HEIGHT; y++) {
        if (y % 10 >= 5) continue;
        for (let x = x0; x < x0 + 40; x++) f.set([40, 40, 40], (y * THUMB_WIDTH + x) * 4);
      }
      return f;
    };
    const P = list(0);
    const Q = list(120);
    const r = scroll(P, Q);
    expect(r.match).toBeGreaterThan(0.9); // 行だけ見れば「同じ」
    const col = columnMatch(P, Q, r.dy!);
    expect(col.informative).toBe(true);
    expect(col.match).toBeLessThan(0.6); // 列を見れば別物（横 40 画素まで探しても届かない）
    expect(pickPair(P, Q).map((x) => x.shown)).toEqual([true, true]);
    // 本当にスクロールした同じ一覧なら列も合う
    const c = columnMatch(cards(20), cards(0), scroll(cards(20), cards(0)).dy!);
    expect(c.informative).toBe(true);
    expect(c.match).toBeGreaterThan(0.9);
    // 横いっぱいの帯だけの画面は列に凹凸がなく、列では判断しない（行と文字に任せる）
    const FULL = BANDS.map((b) => ({ ...b, x: 0, w: THUMB_WIDTH }));
    expect(columnMatch(page(20, FULL), page(0, FULL), scroll(page(20, FULL), page(0, FULL)).dy!).informative).toBe(false);
    expect(pickPair(page(0, FULL), page(20, FULL)).map((x) => x.reason)).toEqual([undefined, 'scrolled']);
  });

  it('斜めに送った画面（縦にも横にもずれた）も、列のずれを探してまとめる', () => {
    const d = pickPair(cards(0), cards(20, 30));
    expect(d.map((x) => [x.shown, x.reason])).toEqual([[true, undefined], [false, 'scrolled']]);
    expect(Math.abs(d[1]!.scrollShift! - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(Math.abs(d[1]!.scrollShiftX!) - 30)).toBeLessThanOrEqual(1);
    // 横 40 画素を超えて動いた画面は残す
    expect(pickPair(cards(0), cards(20, 60)).map((x) => x.shown)).toEqual([true, true]);
  });

  it('文字認識の雑音（時計・ファイル名の断片・記号）は「別のラベル」に数えない', () => {
    expect(labelText('1月20日（月）16:42\n✕ 1125octracear047\n山\n35S\nカメラ本体')).toBe('カメラ本体');
    expect(labelText('35S\n19\n炭')).toBe('');
    // 時計とファイル名の断片だけが違うアプリの画面は、ラベルが違うとはみなさずまとめる（文字全体では 0.8 そろわないので文字の規則には掛からない）
    const clock = (i: number) => (i === 0 ? 'ファイル\n1月20日（月）16:42\n✕ 1125octracear047' : 'ファイル\n1月20日（月）17:03\n✕ 9977pctra31');
    expect(textSimilarity(clock(0), clock(1))).toBeLessThan(0.8);
    expect(pickPair(page(0), page(20), vision(0.3, clock)).map((x) => x.reason)).toEqual([undefined, 'scrolled']);
  });

  it('平行移動の探索範囲（縦 12 画素）を超えてスクロールしても、行の並びが重なれば外す', () => {
    for (const sy of [16, 24, 32]) {
      const d = pickPair(page(0), page(sy));
      expect(d.map((x) => [x.shown, x.reason]), `sy=${sy}`).toEqual([[true, undefined], [false, 'scrolled']]);
      // scrollShift は「基準の画像を何行ずらすと今の画像に重なるか」。下にスクロールした画面なら正
      expect(Math.abs(d[1]!.scrollShift! - sy), `sy=${sy}`).toBeLessThanOrEqual(1);
    }
  });

  it('別のページは残す', () => {
    expect(pickPair(page(0), page(0, OTHER_BANDS)).map((x) => x.shown)).toEqual([true, true]);
  });

  it('凹凸の少ないページ（白地にロゴや数行だけ）は、中身のある行だけで重ねる', () => {
    // 白地の Web ページを少し送った: 小さなロゴと数行の文字が 10 行下に動いた。動いた画素は全体の 1 割に満たない
    const SPARSE: Band[] = [
      { y: 12, h: 8, x: 20, w: 40, color: DARK },
      { y: 30, h: 3, x: 20, w: 90, color: DARK },
      { y: 36, h: 3, x: 20, w: 70, color: DARK },
      { y: 60, h: 10, x: 60, w: 50, color: BLUE },
      { y: 100, h: 4, x: 20, w: 100, color: DARK },
    ];
    const sparse = (sy: number) => page(sy, SPARSE);
    // 平行移動の探索範囲（縦 12 画素）の外まで送っても、中身のある行だけなら重なる
    const r = scroll(sparse(20), sparse(0));
    expect(r.sparse).toBe(true);
    expect(r.structure).toBeLessThan(0.3);
    expect(Math.abs(r.dy! - 20)).toBeLessThanOrEqual(1);
    expect(r.match).toBeGreaterThan(0.8);
    expect(pickPair(sparse(0), sparse(20)).map((x) => [x.shown, x.reason])).toEqual([[true, undefined], [false, 'scrolled']]);
    // 同じ白地でも、中身の位置と大きさが違う別のページは重ならない
    const OTHER_SPARSE: Band[] = [
      { y: 8, h: 12, x: 90, w: 50, color: BLUE },
      { y: 44, h: 3, x: 20, w: 120, color: DARK },
      { y: 70, h: 6, x: 30, w: 30, color: DARK },
    ];
    expect(scroll(page(0, OTHER_SPARSE), sparse(0)).match).toBeLessThan(0.6);
    expect(pickPair(sparse(0), page(0, OTHER_SPARSE)).map((x) => x.shown)).toEqual([true, true]);
    // 帯 1 本だけの画面でも、別のラベルが付いていれば残る（文字の歯止めは凹凸の少ないページでも効く）
    const banner = (y: number) => page(0, [{ y, h: 10, color: DARK }]);
    const labels = (i: number) => (i === 0 ? '第1章 導入' : '第2章 観察');
    expect(pickPair(banner(10), banner(40), vision(0.3, labels)).map((x) => x.shown)).toEqual([true, true]);
  });

  it('別のラベルが付いた写真は、行の並びが重なっても残す（写真同士の規則と同じ歯止め）', () => {
    const labels = (i: number) => (i === 0 ? 'カメラ本体' : '粗微動ユニット');
    expect(pickPair(page(0), page(20), vision(0.3, labels)).map((x) => x.shown)).toEqual([true, true]);
    // 片方にしかラベルがなければ「別のラベル」ではない（同じラベルなら文字の規則が先にまとめる）
    const oneLabel = (i: number) => (i === 0 ? 'カメラ本体' : '');
    expect(pickPair(page(0), page(20), vision(0.3, oneLabel)).map((x) => x.reason)).toEqual([undefined, 'scrolled']);
  });

  it('基準の画像とだけ比べるので、送り続けると探す範囲（45 行）を超えたところで次の 1 枚が残る。最後の 1 枚を載せる設定でも同じ', () => {
    const frames = [page(0), page(20), page(40), page(70)];
    const slides = frames.map((_, i) => slide(i + 1, 1));
    const thumbs = new Map(frames.map((f, i) => [`slide_${String(i + 1).padStart(3, '0')}.png`, f] as [string, Uint8Array]));
    const first = pickShownSlides(slides, thumbs, 0.65, vision(0.3), 'first');
    expect(first.map((x) => [x.shown, x.reason])).toEqual([[true, undefined], [false, 'scrolled'], [false, 'scrolled'], [true, undefined]]);
    const last = pickShownSlides(slides, thumbs, 0.65, vision(0.3), 'last');
    expect(last.map((x) => x.shown)).toEqual([false, false, true, true]);
    expect(last[2]).toMatchObject({ standsFor: 'slide_001.png' });
    expect(last[0]).toMatchObject({ reason: 'superseded', sameSceneAs: 'slide_003.png' });
  });

  it('見た目の距離が 0.4 を超える組や、Vision を使わない設定では使わない', () => {
    expect(pickPair(page(0), page(20), vision(0.45)).map((x) => x.shown)).toEqual([true, true]);
    expect(pickPair(page(0), page(20), { distance: () => 0, tight: 0, photo: 0 }).map((x) => x.shown)).toEqual([true, true]);
  });

  it('両方に 3 行以上の文字があるなら「別のラベル」の歯止めは使わず、共通する行が少なければ同じ配色の別のページとして残す', () => {
    // 送れば本文は入れ替わるので、文字がそろわないこと自体は根拠にしない。共通する行で見る
    const scrolled = (i: number) => (i === 0 ? '春の企画展\n出品作品の一覧\n入場は無料です' : '出品作品の一覧\n入場は無科です\n会期は来月まで');
    const s = pickPair(page(0), page(20), vision(0.3, scrolled));
    expect(s.map((x) => x.reason)).toEqual([undefined, 'scrolled']);
    expect(s[1]!.sharedLines).toBeCloseTo(0.667, 2);
    // 同じ配色で本文がまるごと違うページ: 「別のラベル」の歯止めは（本文が 3 行以上なので）使わず、共通する行が無いことで残る
    const different = (i: number) => (i === 0 ? '春の企画展\n出品作品の一覧\n入場は無料です' : '秋の講演会\n登壇者の紹介\n会場は本館です');
    const d = pickPair(page(0), page(20), vision(0.3, different));
    expect(d.map((x) => x.shown)).toEqual([true, true]);
    expect(d[1]!.sharedLines).toBe(0);
  });

  it('sharedLineRatio は少ない方の行のうち相手にもある割合。3 行に満たなければ判断しない', () => {
    expect(sharedLineRatio('a\nb\nc', 'a\nb\nc')).toBeUndefined();
    expect(sharedLineRatio('京都芸術大学\n漁師見習いの字\nムカデにかまれた\nみぎてのじ', '京都芸術大学\n漁師見習いの字\nムカチくん\nムカデにかまれた')).toBeCloseTo(0.75);
    expect(sharedLineRatio('春の企画展\n出品作品の一覧\n入場は無料です', '秋の講演会\n登壇者の紹介\n会場は本館です')).toBe(0);
  });
});

describe('同じショットの続き（切り替えの瞬間の変化が小さい写真・映像、2026-09-22）', () => {
  /** 色とりどりの写真。palette の色を画素ごとにランダムに置く（色の多様さは 3 ビット超）。seed で並びが変わる */
  const PALETTE_A = [[200, 30, 30], [30, 160, 60], [40, 80, 220], [240, 200, 20], [120, 60, 160], [20, 200, 200], [250, 140, 40], [90, 90, 90], [230, 230, 230], [10, 10, 10]];
  /** 別の場面: 色の階調（RGB 各 8 段階）が A と 1 つも重ならない */
  const PALETTE_B = [[60, 120, 200], [180, 20, 120], [20, 60, 20], [140, 140, 20], [220, 100, 100], [70, 200, 120], [160, 90, 40], [210, 210, 90], [30, 30, 90], [130, 130, 130]];
  const photo = (seed: number, palette: number[][]) => {
    const f = new Uint8Array(PIXELS * 4);
    let r = seed;
    for (let p = 0; p < PIXELS; p++) {
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      f.set([...palette[(r >> 16) % palette.length]!, 255], p * 4);
    }
    return f;
  };
  /** 静止部分が多い（スライドらしいと測られた）、自動で保存された画像。diffPrev は切り替えを検知した瞬間の変化率 */
  const shot = (n: number, diffPrev: number, reason = 'change'): SlideEntry => ({ filename: `slide_${String(n).padStart(3, '0')}.png`, seq: n, videoTime: n * 10, reason, trigger: { diffPrev, stillFraction: 0.9 } });
  const vision = (text?: (i: number) => string | undefined) => ({ distance: () => 0.8, tight: 0.2, photo: 0.55, ...(text ? { text } : {}) });
  const pick = (slides: SlideEntry[], a: Uint8Array, b: Uint8Array, v = vision()) =>
    pickShownSlides(slides, new Map([['slide_001.png', a], ['slide_002.png', b]]), 0.65, v, 'first');

  it('写真は色の多様さが 3 ビットを超え、色の分布は同じ palette なら高く、別の palette なら 0', () => {
    expect(colorEntropy(photo(1, PALETTE_A))).toBeGreaterThan(3);
    expect(colorEntropy(paper(1))).toBeLessThan(3);
    expect(colorMatch(photo(1, PALETTE_A), photo(2, PALETTE_A))).toBeGreaterThan(0.9);
    expect(colorMatch(photo(1, PALETTE_A), photo(1, PALETTE_B))).toBe(0);
  });

  it('カメラが動いただけ（切り替えの瞬間の変化が小さい）なら、静止部分が多く測られていても色の分布でまとめる', () => {
    const d = pick([shot(1, 0.9), shot(2, 0.2)], photo(1, PALETTE_A), photo(2, PALETTE_A));
    expect(d.map((x) => [x.shown, x.reason])).toEqual([[true, undefined], [false, 'same-scene']]);
  });

  it('カット（切り替えの瞬間の変化が大きい）なら、色の分布が同じでも別の写真として残す', () => {
    expect(pick([shot(1, 0.9), shot(2, 0.9)], photo(1, PALETTE_A), photo(2, PALETTE_A)).map((x) => x.shown)).toEqual([true, true]);
    // 記録がない画像も残す
    expect(pick([slide(1, 0.9), slide(2, 0.9)], photo(1, PALETTE_A), photo(2, PALETTE_A)).map((x) => x.shown)).toEqual([true, true]);
  });

  it('手動・開始時の保存は、diffPrev が安定後の値（≒ 0）なので見ない（利用者がわざわざ撮った写真を色で消さない）', () => {
    for (const reason of ['manual', 'initial']) {
      expect(pick([shot(1, 0.9), shot(2, 0.001, reason)], photo(1, PALETTE_A), photo(2, PALETTE_A)).map((x) => x.shown), reason).toEqual([true, true]);
    }
  });

  it('色の分布が違えば別の場面。写真でない画面（白地に線）には使わない', () => {
    expect(pick([shot(1, 0.9), shot(2, 0.2)], photo(1, PALETTE_A), photo(1, PALETTE_B)).map((x) => x.shown)).toEqual([true, true]);
    expect(pick([shot(1, 0.9), shot(2, 0.1)], paper(1), paper(2)).map((x) => x.shown)).toEqual([true, true]);
  });

  it('両方に文字があって中身が違えば残す（別のラベルが付いた別の写真）。同じ字幕なら外す', () => {
    const labels = (i: number) => (i === 0 ? '地面のカタバミ' : '石垣に咲く花');
    expect(pick([shot(1, 0.9), shot(2, 0.2)], photo(1, PALETTE_A), photo(2, PALETTE_A), vision(labels)).map((x) => x.shown)).toEqual([true, true]);
    const caption = () => '観察してその結果をまとめる';
    expect(pick([shot(1, 0.9), shot(2, 0.2)], photo(1, PALETTE_A), photo(2, PALETTE_A), vision(caption)).map((x) => x.reason)).toEqual([undefined, 'same-scene']);
  });
});

describe('撮影した紙面の上で手（指）が動いただけの組（2026-09-24）', () => {
  const PALETTE = [[200, 30, 30], [30, 160, 60], [40, 80, 220], [240, 200, 20], [120, 60, 160], [20, 200, 200], [250, 140, 40], [90, 90, 90], [230, 230, 230], [10, 10, 10]];
  /** カメラで撮った色とりどりの紙面（色の多様さは 3 ビット超）。seed で中身が変わる */
  const page = (seed: number, palette = PALETTE) => {
    const f = new Uint8Array(PIXELS * 4);
    let r = seed;
    for (let p = 0; p < PIXELS; p++) {
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      f.set([...palette[(r >> 16) % palette.length]!, 255], p * 4);
    }
    return f;
  };
  /** 白地に黒と赤だけの紙面（色の多様さは 3 ビット未満。写真同士・同じショットの規則は使われない） */
  const FLAT = [[230, 230, 230], [230, 230, 230], [40, 40, 40], [200, 30, 30]];
  /** 紙面の (x, y) から w×h 画素を手（肌色）が隠した画面。40×30 なら全体の 8% */
  const withHand = (base: Uint8Array, x: number, y: number, w = 40, h = 30) => {
    const f = new Uint8Array(base);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) f.set([210, 160, 120, 255], (yy * THUMB_WIDTH + xx) * 4);
    return f;
  };
  /** 撮影された紙面として記録された画像（静止部分が半分以上 0.976 未満、自動保存）。diffPrev は切り替えの瞬間の変化 */
  const filmed = (n: number, stillFraction = 0.85, diffPrev = 0.05, reason = 'change'): SlideEntry => ({
    filename: `slide_${String(n).padStart(3, '0')}.png`,
    seq: n,
    videoTime: n * 10,
    reason,
    trigger: { stillFraction, diffPrev },
  });
  const vision = (d: number | ((a: number, b: number) => number), text?: (i: number) => string | undefined) => ({
    distance: typeof d === 'number' ? () => d : d,
    tight: 0.2,
    photo: 0.55,
    ...(text ? { text } : {}),
  });
  const texts = (...lines: string[][]) => (i: number) => lines[i]?.join('\n');
  const pick = (slides: SlideEntry[], thumbs: Uint8Array[], v: ReturnType<typeof vision>) =>
    pickShownSlides(slides, new Map(thumbs.map((t, i) => [slides[i]!.filename, t])), 0.65, v, 'first');
  /** 同じページを、手が左を隠した画面と右を隠した画面で読んだ文字（隠れる行と読み違いが変わる） */
  const LEFT = ['岡田税理士事務所', '関', '税理士事務所', '信人命け国價'];
  const RIGHT = ['岡田税理士事ム所', '鑑服', '関税理士事務所', '信人会け区供（営業品）'];
  /** 別のページ */
  const OTHER = ['那須ロコ', '丸浜みかん', '岡林農園'];
  const handA = withHand(page(1), 20, 30);
  const handB = withHand(page(1), 100, 30);

  it('sharedLabelLines は、ラベルらしい行のうち相手にもある行の割合。1 行ずつでも測り、5 文字以上続けて同じなら切れ方が違っても同じ行', () => {
    expect(sharedLabelLines('サクラブチケン（コンタク', 'サクラブチケア（コンタク▶レンズ量28）CURE')).toBe(1);
    expect(sharedLabelLines(LEFT.join('\n'), RIGHT.join('\n'))).toBeCloseTo(2 / 3);
    // 手で隠れて 2 行しか読めなかった側があっても測る（sharedLineRatio は 3 行に満たないと判断しない）
    expect(sharedLineRatio('岡田税理士事務所\n部', RIGHT.join('\n'))).toBeUndefined();
    expect(sharedLabelLines('岡田税理士事務所\n部', RIGHT.join('\n'))).toBe(1);
    expect(sharedLabelLines(LEFT.join('\n'), OTHER.join('\n'))).toBe(0);
    // 数字や記号だけ・3 文字未満の行は数えないので、それしかない側があれば判断しない
    expect(sharedLabelLines('16:42\n山', 'nico')).toBeUndefined();
  });

  it('手の位置だけが違う（見た目・画素・色が近く、読み取れたラベルが共通する）なら外す', () => {
    const d = pick([filmed(1), filmed(2)], [handA, handB], vision(0.3, texts(LEFT, RIGHT)));
    expect(d[1]!.reason).toBe('hand');
    expect(d[1]!.sharedLines).toBeCloseTo(2 / 3);
    expect(pixelDiff(handA, handB)).toBeLessThan(0.25);
  });

  it('見た目が同じくらい近くても、ラベルが 1 行も共通しなければ別のページとして残す', () => {
    const d = pick([filmed(1), filmed(2)], [handA, handB], vision(0.3, texts(LEFT, OTHER)));
    expect(d.map((x) => x.shown)).toEqual([true, true]);
    expect(d[1]!.sharedLines).toBe(0);
  });

  it('静止部分が 0.976 以上（スライド）の画像や、切り替えの変化が大きい画像には使わない。基準がスライドでも使わない', () => {
    const v = vision(0.3, texts(LEFT, RIGHT));
    expect(pick([filmed(1), filmed(2, 0.98)], [handA, handB], v).map((x) => x.shown)).toEqual([true, true]);
    expect(pick([filmed(1), filmed(2, 0.85, 0.6)], [handA, handB], v).map((x) => x.shown)).toEqual([true, true]);
    expect(pick([filmed(1, 0.98), filmed(2)], [handA, handB], v).map((x) => x.shown)).toEqual([true, true]);
    // 記録のない画像（古いセッション）にも使わない
    expect(pick([slide(1), slide(2)], [handA, handB], v).map((x) => x.shown)).toEqual([true, true]);
  });

  it('基準がページをめくった瞬間の画像（変化が大きい）でも、そのあと手が動いた画像はまとめる', () => {
    const d = pick([filmed(1, 0.85, 0.6), filmed(2)], [handA, handB], vision(0.3, texts(LEFT, RIGHT)));
    expect(d[1]!.reason).toBe('hand');
  });

  it('ラベルが読めない紙面は、色の分布で見る（読めるときより厳しく）', () => {
    // 手が小さければ色の分布はほとんど変わらない
    expect(pick([filmed(1), filmed(2)], [handA, handB], vision(0.3))[1]!.reason).toBe('hand');
    // 手が大きく入ると（全体の 22%）色の分布が 0.8 前後まで下がる。ラベルが共通していれば許し、読めなければ残す
    // （色とりどりの紙面だと同じショットの規則（色の一致 0.65）が引き取るので、白地の紙面で見る）
    const flat = page(1, FLAT);
    const bigHand = withHand(flat, 40, 20, 80, 40);
    expect(colorEntropy(flat)).toBeLessThan(3);
    const match = colorMatch(flat, bigHand);
    expect(match).toBeGreaterThan(0.75);
    expect(match).toBeLessThan(0.85);
    expect(pick([filmed(1), filmed(2)], [flat, bigHand], vision(0.3, texts(LEFT, RIGHT)))[1]!.reason).toBe('hand');
    expect(pick([filmed(1), filmed(2)], [flat, bigHand], vision(0.3)).map((x) => x.shown)).toEqual([true, true]);
  });

  it('撮影された紙面の帯では、写真同士の緩い規則（0.55 まで）で別のページを吸わない', () => {
    // 1 → 2 は見た目がごく近く（手が少し動いた）まとまるが、文字の読み取りが食い違うので「読み取りが安定しない」扱いになり、
    // 別のラベルの歯止めが外れる。3 はめくった別のページ（Vision 0.5、ラベルは共通しない）
    const distance = (a: number, b: number) => (a + b === 1 ? 0.15 : 0.5);
    const slides = [filmed(1), filmed(2), filmed(3, 0.85, 0.6)];
    const thumbs = [handA, handB, withHand(page(2), 60, 30)];
    expect(colorEntropy(thumbs[2]!)).toBeGreaterThan(3);
    const d = pick(slides, thumbs, vision(distance, texts(LEFT, RIGHT, OTHER)));
    expect(d.map((x) => [x.shown, x.reason])).toEqual([[true, undefined], [false, 'vision'], [true, undefined]]);
    // 同じ 3 枚でも、静止部分がスライドの帯（0.98）なら従来どおり写真同士の規則が別のページを吸う（4 章で 6 見開きが消えた形）
    const asSlides = slides.map((s) => ({ ...s, trigger: { ...s.trigger, stillFraction: 0.98 } }));
    expect(pick(asSlides, thumbs, vision(distance, texts(LEFT, RIGHT, OTHER))).map((x) => x.reason)).toEqual([undefined, 'vision', 'vision']);
  });

  it('静止部分が帯の中でも、切り替えの瞬間に被写体が大きく動いた映像（0.3 以上）は写真同士の規則に任せる', () => {
    const moved = [filmed(1, 0.9, 0.4), filmed(2, 0.9, 0.45)];
    const d = pick(moved, [page(1), page(2)], vision(0.5));
    expect(d[1]!.reason).toBe('vision');
  });
});
