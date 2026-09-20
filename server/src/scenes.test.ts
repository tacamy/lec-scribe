import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBin, run } from './exec.ts';
import type { SlideEntry } from './merge.ts';
import { colorEntropy, colorMatch, panResidual, pickShownSlides, readThumbnail, shownSlides, textContained, textSimilarity, THUMB_HEIGHT, THUMB_WIDTH } from './scenes.ts';

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

  it('探す範囲（横 24・縦 12 画素）を超えて動いた画面は、別の画面として残す', () => {
    for (const [sx, sy] of [[0, 18], [32, 0]] as const) {
      expect(pickPair(webPage(0, 0), webPage(sx, sy)).map((x) => x.shown), `(${sx}, ${sy})`).toEqual([true, true]);
    }
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
  /** 画面ごとに濃さの違う無地に近い画像。同じ番号なら中身が同じ、違う番号なら全画素が違う */
  const screen = (n: number) => {
    const f = new Uint8Array(PIXELS * 4).fill(255);
    for (let p = 0; p < PIXELS; p++) f.set([40 * n, 40 * n, 40 * n], p * 4);
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
    const drift = (flipped: number) => {
      const f = new Uint8Array(PIXELS * 4).fill(255);
      for (let p = 0; p < flipped; p++) f.set([0, 0, 0], p * 4);
      return f;
    };
    const flat = (v: number) => {
      const f = new Uint8Array(PIXELS * 4).fill(255);
      for (let p = 0; p < PIXELS; p++) f.set([v, v, v], p * 4);
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
