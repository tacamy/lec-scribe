import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignSlides } from './merge.ts';
import type { SlideEntry } from './merge.ts';
import {
  PICK_MAX_CANDIDATES,
  PICK_MIN_SPACING_SEC,
  acceptPicks,
  acceptResponse,
  acceptSwaps,
  arrangeImages,
  buildPickPrompt,
  findPickRegions,
  parsePicks,
  pickCap,
  pickRegion,
  mergeRegionResults,
  pickerCacheKey,
  runPicker,
  sceneGroups,
  type PickRegion,
} from './picker.ts';
import type { SceneDecision } from './scenes.ts';

function slide(name: string, videoTime: number, stillFraction?: number): SlideEntry {
  return { filename: name, videoTime, reason: 'change', ...(stillFraction !== undefined ? { trigger: { stillFraction } } : {}) };
}

function segment(videoStart: number, text: string) {
  return { videoStart, videoEnd: videoStart + 5, text };
}

describe('findPickRegions', () => {
  const segments = [segment(100, '腕を見てください。'), segment(130, 'こちらには折れません。'), segment(400, '別の話。')];

  it('スライドではない画面（stillFraction < 0.976）の外された画像だけを節にする', () => {
    const slides = [slide('slide_001.png', 90, 0.8), slide('slide_002.png', 110, 0.8), slide('slide_003.png', 120, 0.99), slide('slide_004.png', 125)];
    const decisions: SceneDecision[] = [
      { filename: 'slide_001.png', shown: true },
      { filename: 'slide_002.png', shown: false, reason: 'text' },
      { filename: 'slide_003.png', shown: false, reason: 'text' }, // スライドの画面
      { filename: 'slide_004.png', shown: false, reason: 'text' }, // 記録のない古い保存
    ];
    const regions = findPickRegions(segments, slides, decisions);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.candidates.map((c) => c.filename)).toEqual(['slide_001.png', 'slide_002.png']);
    expect(regions[0]!.candidates.map((c) => c.shown)).toEqual([true, false]);
    expect(regions[0]!.chunks.length).toBeGreaterThan(0);
  });

  it('identical・blank で外された画像は救わない', () => {
    const slides = [slide('slide_001.png', 100, 0.8), slide('slide_002.png', 110, 0.8)];
    const decisions: SceneDecision[] = [
      { filename: 'slide_001.png', shown: false, reason: 'identical' },
      { filename: 'slide_002.png', shown: false, reason: 'blank' },
    ];
    expect(findPickRegions(segments, slides, decisions)).toHaveLength(0);
  });

  it('離れた画像は別の節になり、発話のない窓は捨てる', () => {
    const slides = [slide('slide_001.png', 100, 0.8), slide('slide_002.png', 600, 0.8)];
    const decisions: SceneDecision[] = [
      { filename: 'slide_001.png', shown: false, reason: 'text' },
      { filename: 'slide_002.png', shown: false, reason: 'text' },
    ];
    // 600 秒付近に発話がないので、その節は作られない
    const regions = findPickRegions(segments, slides, decisions);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.candidates[0]!.filename).toBe('slide_001.png');
  });

  it('候補が多すぎる節は時間で割る', () => {
    const slides: SlideEntry[] = [];
    const decisions: SceneDecision[] = [];
    const segs: Array<{ videoStart: number; videoEnd: number; text: string }> = [];
    for (let i = 0; i < PICK_MAX_CANDIDATES + 10; i++) {
      const name = `slide_${String(i).padStart(3, '0')}.png`;
      slides.push(slide(name, 100 + i * 10, 0.8));
      decisions.push({ filename: name, shown: false, reason: 'text' });
      segs.push(segment(100 + i * 10, `発話 ${i}。`));
    }
    const regions = findPickRegions(segs, slides, decisions);
    expect(regions.length).toBeGreaterThan(1);
    for (const r of regions) expect(r.candidates.length).toBeLessThanOrEqual(PICK_MAX_CANDIDATES);
    // 境目の候補と段落はどちらか一方にだけ入る（両方に入ると同じ画像が 2 回選ばれる。2026-10-02 のレビュー）
    const names = regions.flatMap((r) => r.candidates.map((c) => c.filename));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(slides.length);
    const starts = regions.flatMap((r) => r.chunks.map((c) => c.start));
    expect(new Set(starts).size).toBe(starts.length);
  });
});

describe('acceptPicks', () => {
  const region: PickRegion = {
    start: 90,
    end: 300,
    chunks: [
      { start: 100, text: '段落 1。' },
      { start: 150, text: '段落 2。' },
      { start: 200, text: '段落 3。' },
    ],
    candidates: [
      { filename: 'slide_001.png', videoTime: 100, shown: true },
      { filename: 'slide_002.png', videoTime: 105, shown: false },
      { filename: 'slide_003.png', videoTime: 160, shown: false },
      { filename: 'slide_004.png', videoTime: 170, shown: false },
      { filename: 'slide_005.png', videoTime: 210, shown: false },
    ],
  };

  it('掲載済み・範囲外・時刻の合わない選択を捨てる', () => {
    const { accepted, rejected } = acceptPicks(region, [
      { image: 1, after_paragraph: 1, reason: '' }, // 掲載済み
      { image: 9, after_paragraph: 1, reason: '' }, // 範囲外
      { image: 5, after_paragraph: 3, reason: '' },
      { image: 3, after_paragraph: 2, reason: '' },
    ]);
    expect(accepted.map((a) => a.filename)).toEqual(['slide_003.png', 'slide_005.png']);
    expect(rejected.map((r) => r.why)).toContain('掲載済み');
    expect(rejected.map((r) => r.why)).toContain('候補にない番号');
  });

  it('載っている画像やほかの採用に近い選択を捨てる', () => {
    const { accepted, rejected } = acceptPicks(region, [
      { image: 2, after_paragraph: 1, reason: '' }, // shown の slide_001（100 秒）から 5 秒 → 近すぎ
      { image: 3, after_paragraph: 2, reason: '' },
      { image: 4, after_paragraph: 2, reason: '' }, // slide_003（160 秒）から 10 秒 → 近すぎ
    ]);
    expect(accepted.map((a) => a.filename)).toEqual(['slide_003.png']);
    expect(rejected.filter((r) => r.why.includes('近すぎ'))).toHaveLength(2);
  });

  it('時刻が段落から離れすぎた選択を捨てる', () => {
    const far: PickRegion = { ...region, chunks: [{ start: 100, text: '段落 1。' }], candidates: [{ filename: 'slide_009.png', videoTime: 250, shown: false }] };
    const { accepted, rejected } = acceptPicks(far, [{ image: 1, after_paragraph: 1, reason: '' }]);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]!.why).toContain('離れすぎ');
  });

  it('段落の番号が範囲外・小数なら捨てる（節の開始で検算しない）', () => {
    const r: PickRegion = { start: 90, end: 400, chunks: [{ start: 100, text: 'a' }, { start: 300, text: 'b' }], candidates: [{ filename: 'x.png', videoTime: 310, shown: false }] };
    expect(acceptPicks(r, [{ image: 1, after_paragraph: 3, reason: '' }]).rejected[0]!.why).toContain('段落の番号が不正');
    expect(acceptPicks(r, [{ image: 1, after_paragraph: 1.5, reason: '' }]).rejected[0]!.why).toContain('段落の番号が不正');
    expect(acceptPicks(r, [{ image: 1, after_paragraph: -1, reason: '' }]).rejected[0]!.why).toContain('段落の番号が不正');
    expect(acceptPicks(r, [{ image: 1, after_paragraph: 2, reason: '' }]).accepted.map((a) => a.filename)).toEqual(['x.png']);
  });

  it('上限（段落 3 つにつき 2 枚）を超えた分は捨てる', () => {
    const many: PickRegion = {
      start: 0,
      end: 1000,
      chunks: [{ start: 0, text: 'a' }, { start: 300, text: 'b' }, { start: 600, text: 'c' }],
      candidates: Array.from({ length: 6 }, (_, i) => ({ filename: `slide_${i}.png`, videoTime: i * 100, shown: false })),
    };
    expect(pickCap(many)).toBe(2);
    const { accepted } = acceptPicks(many, many.candidates.map((_, i) => ({ image: i + 1, after_paragraph: 0, reason: '' })));
    // after_paragraph 0 の基準は節の開始なので、開始から 90 秒を超える候補は時刻の検算で落ち、残りから上限まで
    expect(accepted.length).toBeLessThanOrEqual(2);
  });

  it('間隔の規則は定数と一致する', () => {
    expect(PICK_MIN_SPACING_SEC).toBe(12);
  });
});

describe('parsePicks / prompt / cache key', () => {
  it('壊れた返答は投げ、形の崩れた要素は黙って除く', () => {
    expect(() => parsePicks('not json')).toThrow();
    expect(() => parsePicks('{"nope":1}')).toThrow();
    const parsed = parsePicks('{"picks":[{"image":1,"after_paragraph":2,"reason":"r"},{"image":"x"}],"swaps":[{"from":1,"to":2,"reason":"r"},{"from":"x"}]}');
    expect(parsed.picks).toHaveLength(1);
    expect(parsed.swaps).toHaveLength(1);
    // swaps の無い古い形（またはモデルが省いた形）も読める
    expect(parsePicks('{"picks":[]}').swaps).toEqual([]);
  });

  it('プロンプトに段落・時刻・掲載の別が入る', () => {
    const region: PickRegion = {
      start: 90,
      end: 200,
      chunks: [{ start: 100, text: '腕を見てください。' }],
      candidates: [
        { filename: 'slide_001.png', videoTime: 100, shown: true },
        { filename: 'slide_002.png', videoTime: 110, shown: false },
      ],
    };
    const prompt = buildPickPrompt(region);
    expect(prompt).toContain('1. [01:40] 腕を見てください。');
    expect(prompt).toContain('画像1 = [01:40]（掲載済み）');
    expect(prompt).toContain('画像2 = [01:50]（未掲載）');
  });

  it('鍵は本文・候補・モデルのどれが変わっても変わる', () => {
    const region: PickRegion = {
      start: 0,
      end: 100,
      chunks: [{ start: 10, text: 'a' }],
      candidates: [{ filename: 's.png', videoTime: 20, shown: false }],
    };
    const base = pickerCacheKey([region], 'm1');
    expect(pickerCacheKey([region], 'm2')).not.toBe(base);
    expect(pickerCacheKey([{ ...region, chunks: [{ start: 10, text: 'b' }] }], 'm1')).not.toBe(base);
    expect(pickerCacheKey([{ ...region, candidates: [{ filename: 's.png', videoTime: 20, shown: true }] }], 'm1')).not.toBe(base);
    expect(pickerCacheKey([{ ...region, candidates: [{ filename: 's.png', videoTime: 20, shown: false, textLen: 5 }] }], 'm1')).not.toBe(base);
    expect(pickerCacheKey([{ ...region, candidates: [{ filename: 's.png', videoTime: 20, shown: false, group: 'r.png' }] }], 'm1')).not.toBe(base);
    expect(pickerCacheKey([region], 'm1')).toBe(base);
  });

  it('sceneGroups は sameSceneAs を載っている画像まで辿る', () => {
    const decisions: SceneDecision[] = [
      { filename: 'a.png', shown: false, reason: 'text', sameSceneAs: 'b.png' }, // b はあとで譲って外れた
      { filename: 'b.png', shown: false, reason: 'superseded', sameSceneAs: 'c.png' },
      { filename: 'c.png', shown: true },
      { filename: 'd.png', shown: false, reason: 'identical', sameSceneAs: 'c.png' }, // identical は差し替え先にしない
      { filename: 'e.png', shown: false, reason: 'blank' }, // 行き先なし
    ];
    const groups = sceneGroups(decisions);
    expect(groups.get('a.png')).toBe('c.png');
    expect(groups.get('b.png')).toBe('c.png');
    expect(groups.has('d.png')).toBe(false);
    expect(groups.has('e.png')).toBe(false);
  });
});

describe('acceptSwaps / acceptResponse', () => {
  const region: PickRegion = {
    start: 90,
    end: 300,
    chunks: [
      { start: 100, text: '段落 1。' },
      { start: 150, text: '段落 2。' },
      { start: 200, text: '段落 3。' },
    ],
    candidates: [
      { filename: 'slide_001.png', videoTime: 100, shown: true },
      { filename: 'slide_002.png', videoTime: 110, shown: false, group: 'slide_001.png' },
      { filename: 'slide_003.png', videoTime: 160, shown: false, group: 'slide_005.png' },
      { filename: 'slide_004.png', videoTime: 170, shown: false },
      { filename: 'slide_005.png', videoTime: 210, shown: true },
    ],
  };

  it('差し替えは「掲載済み → 同じまとまりの未掲載」だけを通す', () => {
    const { swaps, rejected } = acceptSwaps(region, [
      { from: 1, to: 2, reason: '' }, // slide_001 → slide_002（同じまとまり）
      { from: 1, to: 3, reason: '' }, // from は使用済み（無視）
      { from: 5, to: 4, reason: '' }, // slide_004 はまとまりに属さない
      { from: 5, to: 1, reason: '' }, // 掲載済みへの差し替えは不可
      { from: 2, to: 4, reason: '' }, // from が未掲載
      { from: 9, to: 2, reason: '' }, // 範囲外
    ]);
    expect(swaps).toEqual([{ from: 'slide_001.png', to: 'slide_002.png' }]);
    expect(rejected.map((r) => r.why)).toContain('slide_005.png と同じまとまりではない');
    expect(rejected.map((r) => r.why)).toContain('差し替えは掲載済み→未掲載だけ');
  });

  it('字幕の写った代表を、文字のない（少ない）画像に差し替えない', () => {
    const subtitled: PickRegion = {
      ...region,
      candidates: [
        { filename: 'slide_016.png', videoTime: 130, shown: true, textLen: 13 },
        { filename: 'slide_014.png', videoTime: 120, shown: false, group: 'slide_016.png' },
        { filename: 'slide_015.png', videoTime: 125, shown: false, group: 'slide_016.png', textLen: 12 },
      ],
    };
    const { swaps, rejected } = acceptSwaps(subtitled, [
      { from: 1, to: 2, reason: '' }, // 文字 13 → 0: 弾く
      { from: 1, to: 3, reason: '' }, // 文字 13 → 12: 通す
    ]);
    expect(rejected.map((r) => r.why)).toContain('slide_016.png より写っている文字が減る');
    expect(swaps).toEqual([{ from: 'slide_016.png', to: 'slide_015.png' }]);
  });

  it('acceptResponse は差し替え先を掲載扱いにしてから picks を見る', () => {
    const { accepted, swaps, rejected } = acceptResponse(region, {
      swaps: [{ from: 1, to: 2, reason: '' }],
      picks: [
        { image: 2, after_paragraph: 1, reason: '' }, // 差し替え先 → 掲載済みとして落ちる
        { image: 4, after_paragraph: 2, reason: '' },
      ],
    });
    expect(swaps).toHaveLength(1);
    expect(accepted.map((a) => a.filename)).toEqual(['slide_004.png']);
    expect(rejected.map((r) => r.why)).toContain('掲載済み');
  });

});

describe('mergeRegionResults', () => {
  it('節の境目をまたいだ重複と近さを落とす', () => {
    const a: PickRegion = { start: 0, end: 100, chunks: [{ start: 10, text: 'a' }], candidates: [{ filename: 'x.png', videoTime: 97, shown: false }] };
    const b: PickRegion = { start: 100, end: 200, chunks: [{ start: 110, text: 'b' }], candidates: [{ filename: 'y.png', videoTime: 103, shown: false }] };
    const merged = mergeRegionResults(
      [a, b],
      [
        { accepted: [a.candidates[0]!], swaps: [], rejected: [], model: 'm' },
        { accepted: [b.candidates[0]!, a.candidates[0]!], swaps: [], rejected: [], model: 'm' },
      ],
    );
    expect(merged.accepted).toEqual(['x.png']);
    expect(merged.rejected.some((r) => r.filename === 'y.png' && r.why.includes('境目'))).toBe(true);
  });
});

describe('arrangeImages', () => {
  const seg = (t: number) => ({ start: t, end: t + 5, videoStart: t, videoEnd: t + 5, text: `${t}` });
  const segs = [105, 115, 125, 135, 165].map(seg);
  const owners = (slides: SlideEntry[]) => assignSlides(segs, slides).map((m) => m.slide);
  const P = slide('slide_001.png', 0);

  it('何も選ばれなければ、載せる並びをそのまま返す', () => {
    const shown = [P, slide('slide_002.png', 100)];
    expect(arrangeImages(shown, shown, [], [], [])).toEqual(shown);
  });

  it('繰り上げられた代表のまとまりに救った画像が入っても、まとまりの発話は前の別の場面に流れない', () => {
    // 代表 R=160 秒が、まとまりの先頭 A=100 秒の位置に繰り上げられて載っている（sceneKeep: last）。X=130 秒を救う
    const A = slide('slide_002.png', 100);
    const X = slide('slide_003.png', 130);
    const R = slide('slide_004.png', 160);
    const decisions: SceneDecision[] = [
      { filename: 'slide_001.png', shown: true },
      { filename: 'slide_002.png', shown: false, reason: 'superseded', sameSceneAs: 'slide_004.png' },
      { filename: 'slide_003.png', shown: false, reason: 'text', sameSceneAs: 'slide_002.png' },
      { filename: 'slide_004.png', shown: true, standsFor: 'slide_002.png' },
    ];
    const anchoredR = { ...A, filename: R.filename };
    const out = arrangeImages([P, anchoredR], [P, A, X, R], decisions, ['slide_003.png'], []);
    expect(out.map((s) => s.filename)).toEqual(['slide_001.png', 'slide_003.png', 'slide_004.png']);
    // 105〜135 秒は救った X、165 秒は R。前の slide_001 には付かない
    expect(owners(out)).toEqual(['slide_003.png', 'slide_003.png', 'slide_003.png', 'slide_003.png', 'slide_004.png']);
  });

  it('差し替えと救出が同じまとまりに重なっても、まとまりの先頭の位置を保つ（sceneKeep: first）', () => {
    // 代表 R=100 秒（繰り上げなし）を T=160 秒に差し替え、X=130 秒を救う
    const R = slide('slide_002.png', 100);
    const X = slide('slide_003.png', 130);
    const T = slide('slide_004.png', 160);
    const decisions: SceneDecision[] = [
      { filename: 'slide_001.png', shown: true },
      { filename: 'slide_002.png', shown: true },
      { filename: 'slide_003.png', shown: false, reason: 'text', sameSceneAs: 'slide_002.png' },
      { filename: 'slide_004.png', shown: false, reason: 'text', sameSceneAs: 'slide_002.png' },
    ];
    const out = arrangeImages([P, R], [P, R, X, T], decisions, ['slide_003.png'], [{ from: 'slide_002.png', to: 'slide_004.png' }]);
    expect(out.map((s) => s.filename)).toEqual(['slide_001.png', 'slide_003.png', 'slide_004.png']);
    expect(owners(out)).toEqual(['slide_003.png', 'slide_003.png', 'slide_003.png', 'slide_003.png', 'slide_004.png']);
  });

  it('差し替えだけなら、位置は代表のまま画像だけが入れ替わる', () => {
    const A = slide('slide_002.png', 100);
    const T = { ...slide('slide_003.png', 130), seq: 3, width: 1280, height: 720 };
    const R = slide('slide_004.png', 160);
    const decisions: SceneDecision[] = [
      { filename: 'slide_002.png', shown: false, reason: 'superseded', sameSceneAs: 'slide_004.png' },
      { filename: 'slide_003.png', shown: false, reason: 'text', sameSceneAs: 'slide_004.png' },
      { filename: 'slide_004.png', shown: true, standsFor: 'slide_002.png' },
    ];
    const anchoredR = { ...A, filename: R.filename };
    const out = arrangeImages([anchoredR], [A, T, R], decisions, [], [{ from: 'slide_004.png', to: 'slide_003.png' }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.filename).toBe('slide_003.png');
    expect(out[0]!.videoTime).toBe(100);
    expect(out[0]!.width).toBe(1280);
  });

  it('まとまりの外で救った画像は自分の撮影時刻に入る', () => {
    const shown = [P, slide('slide_002.png', 100)];
    const Y = slide('slide_009.png', 300);
    const out = arrangeImages(shown, [...shown, Y], [], ['slide_009.png'], []);
    expect(out.map((s) => s.filename)).toEqual(['slide_001.png', 'slide_002.png', 'slide_009.png']);
  });
});

describe('pickRegion / runPicker（codex スタブ）', () => {
  let tmp: string;
  let slidesDir: string;
  let argsFile: string;
  let callsFile: string;
  let savedCodexHome: string | undefined;

  const region: PickRegion = {
    start: 90,
    end: 300,
    chunks: [
      { start: 100, text: '腕を見てください。' },
      { start: 150, text: 'なぜかというと。' },
    ],
    candidates: [
      { filename: 'slide_001.png', videoTime: 100, shown: true },
      { filename: 'slide_002.png', videoTime: 130, shown: false },
    ],
  };

  async function writeStub(name: string, body: string): Promise<string> {
    const file = path.join(tmp, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  }

  /** 呼ばれた回数を callsFile に足し、引数を argsFile に残し、answer を返す codex */
  const answering = (answer: string) =>
    writeStub(
      'codex',
      `echo x >> "${callsFile}"; printf '%s\\n' "$@" > "${argsFile}"; out=""; prev=""; for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then out="$a"; fi; prev="$a"; done; printf '%s' '${answer}' > "$out"`,
    );
  const calls = async () => (await readFile(callsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-pick-test-'));
    // 利用者の ~/.codex/config.toml を読まない（モデルと推論の強さが開発者の設定で変わらないように）
    savedCodexHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = path.join(tmp, 'codex-home');
    argsFile = path.join(tmp, 'args.txt');
    callsFile = path.join(tmp, 'calls.txt');
    // フォルダ名にカンマを入れる（ページのタイトルから付くので起こりうる。codex にはこのパスを渡さない）
    slidesDir = path.join(tmp, 'Lecture 1, Part 2', 'slides');
    await mkdir(slidesDir, { recursive: true });
    await mkdir(path.join(tmp, 'Lecture 1, Part 2', '.lecscribe'), { recursive: true });
    // 中身は PNG ではないので sips は失敗し、一時フォルダへの写しに落ちる
    for (const c of region.candidates) await writeFile(path.join(slidesDir, c.filename), 'not a png');
  });

  afterAll(async () => {
    if (savedCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = savedCodexHome;
    await rm(tmp, { recursive: true, force: true });
  });

  it('画像は一時フォルダの写しを -i で渡し、返ってきた選択を歯止めに通す', async () => {
    const codex = await answering('{"picks":[{"image":2,"after_paragraph":1,"reason":"実演"}],"swaps":[]}');
    const result = await pickRegion(slidesDir, region, { codexBin: codex, model: 'pick-model', fallbackModel: '' }, () => {});
    expect(result.error).toBeUndefined();
    expect(result.accepted.map((c) => c.filename)).toEqual(['slide_002.png']);
    const args = (await readFile(argsFile, 'utf8')).split('\n');
    const images = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]!] : []));
    expect(images).toHaveLength(2);
    // セッションのフォルダ（カンマを含む）ではなく、一時フォルダの 001.png・002.png
    for (const image of images) expect(image).not.toContain(',');
    expect(images.map((f) => path.basename(f))).toEqual(['001.png', '002.png']);
    expect(args).toContain('pick-model');
    // prompt は -i の後ろの -- のあとに来る（-i が prompt を画像として飲み込まないように）
    expect(args.slice(args.indexOf('--') + 1).join('\n')).toContain('腕を見てください');
  });

  it('モデルが使えないときは整えのモデルでやり直す', async () => {
    const codex = await writeStub(
      'codex',
      'for a in "$@"; do if [ "$a" = "gone-model" ]; then echo "ERROR: The model is not supported when using Codex with a ChatGPT account." >&2; exit 1; fi; done; '
        + 'out=""; prev=""; for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then out="$a"; fi; prev="$a"; done; printf \'{"picks":[],"swaps":[]}\' > "$out"',
    );
    const log: string[] = [];
    const result = await pickRegion(slidesDir, region, { codexBin: codex, model: 'gone-model', fallbackModel: 'polish-model' }, (l) => log.push(l));
    expect(result.error).toBeUndefined();
    expect(result.model).toBe('polish-model');
    expect(log.some((l) => l.includes('使えない'))).toBe(true);
  });

  it('ほかの失敗は受け皿に行かず、エラーとして返す', async () => {
    const codex = await writeStub('codex', 'echo "temporarily rate limited" >&2; exit 1');
    const result = await pickRegion(slidesDir, region, { codexBin: codex, model: 'pick-model', fallbackModel: 'polish-model' }, () => {});
    expect(result.error).toContain('rate limited');
    expect(result.accepted).toHaveLength(0);
  });

  it('画像を用意できなければ、その節は呼ばずにエラーにする（番号がずれた画像を渡さない）', async () => {
    const codex = await answering('{"picks":[],"swaps":[]}');
    const before = await calls();
    const missing: PickRegion = { ...region, candidates: [...region.candidates, { filename: 'slide_404.png', videoTime: 200, shown: false }] };
    const result = await pickRegion(slidesDir, missing, { codexBin: codex, model: 'm', fallbackModel: '' }, () => {});
    expect(result.error).toBeDefined();
    expect(await calls()).toBe(before);
  });

  it('runPicker は結果を残し、同じ入力の次の回は呼ばずに使い回す', async () => {
    const dir = path.dirname(slidesDir);
    await rm(path.join(dir, '.lecscribe', 'picker-cache.json'), { force: true });
    const codex = await answering('{"picks":[{"image":2,"after_paragraph":1,"reason":"実演"}],"swaps":[]}');
    const settings = { codexBin: codex, model: 'm', fallbackModel: '' };
    const before = await calls();
    const first = await runPicker({ dir, slidesDir, regions: [region], settings, log: () => {} });
    expect(first.reused).toBe(false);
    expect(first.accepted).toEqual(['slide_002.png']);
    expect(await calls()).toBe(before + 1);
    const second = await runPicker({ dir, slidesDir, regions: [region], settings, log: () => {} });
    expect(second.reused).toBe(true);
    expect(second.accepted).toEqual(['slide_002.png']);
    expect(await calls()).toBe(before + 1);
  });

  it('runPicker は失敗が残った結果を使い回さない', async () => {
    const dir = path.dirname(slidesDir);
    await rm(path.join(dir, '.lecscribe', 'picker-cache.json'), { force: true });
    const failing = await writeStub('codex', `echo x >> "${callsFile}"; echo "temporarily rate limited" >&2; exit 1`);
    const failed = await runPicker({ dir, slidesDir, regions: [region], settings: { codexBin: failing, model: 'm', fallbackModel: '' }, log: () => {} });
    expect(failed.errors).toHaveLength(1);
    const codex = await answering('{"picks":[{"image":2,"after_paragraph":1,"reason":"実演"}],"swaps":[]}');
    const before = await calls();
    const retried = await runPicker({ dir, slidesDir, regions: [region], settings: { codexBin: codex, model: 'm', fallbackModel: '' }, log: () => {} });
    expect(retried.reused).toBe(false);
    expect(retried.accepted).toEqual(['slide_002.png']);
    expect(await calls()).toBe(before + 1);
  });

  it('runPicker は止められたら何も採らず、結果も残さない', async () => {
    const dir = path.dirname(slidesDir);
    const cacheFile = path.join(dir, '.lecscribe', 'picker-cache.json');
    await rm(cacheFile, { force: true });
    const codex = await answering('{"picks":[{"image":2,"after_paragraph":1,"reason":"実演"}],"swaps":[]}');
    const controller = new AbortController();
    controller.abort();
    const result = await runPicker({ dir, slidesDir, regions: [region], settings: { codexBin: codex, model: 'm', fallbackModel: '', signal: controller.signal }, log: () => {} });
    expect(result.accepted).toEqual([]);
    expect(await stat(cacheFile).then(() => true).catch(() => false)).toBe(false);
  });
});
