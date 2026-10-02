import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SlideEntry } from './merge.ts';
import {
  PICK_MAX_CANDIDATES,
  PICK_MIN_SPACING_SEC,
  acceptPicks,
  buildPickPrompt,
  findPickRegions,
  parsePicks,
  pickCap,
  pickRegion,
  pickerCacheKey,
  withRescued,
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
    expect(parsePicks('{"picks":[{"image":1,"after_paragraph":2,"reason":"r"},{"image":"x"}]}')).toHaveLength(1);
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
    expect(pickerCacheKey([region], 'm1')).toBe(base);
  });

  it('withRescued は時刻順に差し込む', () => {
    const all = [slide('slide_001.png', 10), slide('slide_002.png', 20), slide('slide_003.png', 30)];
    const shown = [all[0]!, all[2]!];
    expect(withRescued(shown, all, ['slide_002.png']).map((s) => s.filename)).toEqual(['slide_001.png', 'slide_002.png', 'slide_003.png']);
    expect(withRescued(shown, all, []).map((s) => s.filename)).toEqual(['slide_001.png', 'slide_003.png']);
  });

  it('withRescued は、繰り上げ区間に救った画像が入る代表を本来の時刻に戻す', () => {
    const all = [slide('slide_001.png', 10), slide('slide_002.png', 20), slide('slide_003.png', 30)];
    // slide_003 が slide_001 の位置（10 秒）に繰り上げられて載っている（standsFor）
    const anchored = { ...all[0]!, filename: 'slide_003.png' };
    const out = withRescued([anchored], all, ['slide_002.png']);
    expect(out.map((s) => s.filename)).toEqual(['slide_002.png', 'slide_003.png']);
    expect(out[1]!.videoTime).toBe(30);
    // 繰り上げ区間の外の救出なら、代表はそのまま
    const out2 = withRescued([anchored], [...all, slide('slide_004.png', 40)], ['slide_004.png']);
    expect(out2[0]!.videoTime).toBe(10);
  });
});

describe('pickRegion（codex スタブ）', () => {
  let tmp: string;
  let argsFile: string;

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

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-pick-test-'));
    argsFile = path.join(tmp, 'args.txt');
    await mkdir(path.join(tmp, 'slides'), { recursive: true });
  });

  it('画像を -i で渡し、返ってきた選択を歯止めに通す', async () => {
    const codex = await writeStub(
      'codex',
      `printf '%s\\n' "$@" > "${argsFile}"; out=""; prev=""; for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then out="$a"; fi; prev="$a"; done; printf '{"picks":[{"image":2,"after_paragraph":1,"reason":"実演"}]}' > "$out"`,
    );
    const log: string[] = [];
    const result = await pickRegion(path.join(tmp, 'slides'), region, { codexBin: codex, model: 'pick-model', fallbackModel: '' }, (l) => log.push(l));
    expect(result.error).toBeUndefined();
    expect(result.accepted.map((c) => c.filename)).toEqual(['slide_002.png']);
    const args = (await readFile(argsFile, 'utf8')).split('\n');
    // 候補の数だけ -i が付く（画像ファイルが無いので sips は失敗し、元のパスが渡る）
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    expect(args).toContain('--model');
    expect(args).toContain('pick-model');
  });

  it('モデルが使えないときは整えのモデルでやり直す', async () => {
    const codex = await writeStub(
      'codex',
      'for a in "$@"; do if [ "$a" = "gone-model" ]; then echo "ERROR: The model is not supported when using Codex with a ChatGPT account." >&2; exit 1; fi; done; '
        + 'out=""; prev=""; for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then out="$a"; fi; prev="$a"; done; printf \'{"picks":[]}\' > "$out"',
    );
    const log: string[] = [];
    const result = await pickRegion(path.join(tmp, 'slides'), region, { codexBin: codex, model: 'gone-model', fallbackModel: 'polish-model' }, (l) => log.push(l));
    expect(result.error).toBeUndefined();
    expect(result.model).toBe('polish-model');
    expect(log.some((l) => l.includes('使えない'))).toBe(true);
  });

  it('ほかの失敗は受け皿に行かず、エラーとして返す', async () => {
    const codex = await writeStub('codex', 'echo "temporarily rate limited" >&2; exit 1');
    const result = await pickRegion(path.join(tmp, 'slides'), region, { codexBin: codex, model: 'pick-model', fallbackModel: 'polish-model' }, () => {});
    expect(result.error).toContain('rate limited');
    expect(result.accepted).toHaveLength(0);
  });
});
