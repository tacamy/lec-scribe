import { describe, expect, it } from 'vitest';
import { applyPlacement, boundaryCacheKey, boundaryImages, buildBoundaryPrompt, findBoundaries, imageNumbers, keepMax, parseBoundaryResponse, placementFor, type Boundary, type Topic } from './boundary.ts';
import type { Section, SlideEntry } from './merge.ts';

const slide = (n: number): SlideEntry => ({ filename: `slide_${String(n).padStart(3, '0')}.png`, seq: n, videoTime: n * 10, t: n * 10, reason: 'change' });
const section = (n: number, ...texts: string[]): Section => ({ id: `slide_${String(n).padStart(3, '0')}`, heading: '', slide: slide(n), texts });

describe('話題の境目の画像判定（§13.5）', () => {
  // 1: 前の話題の本文、2: 途切れている間（無音）、3: 新しい話題の最初の発話、4: 続き
  const sections = [section(1, '一枚目の話。'), section(2), section(3, '三枚目の話。'), section(4, '四枚目の話。')];
  const polished = new Map([
    ['slide_001', { text: '一枚目の本文。' }],
    ['slide_003', { text: '三枚目の本文。' }],
    ['slide_004', { text: '四枚目の本文。' }],
  ]);
  const topics: Topic[] = [
    { heading: '導入', summary: [], startId: 'slide_001' },
    { heading: '本題', summary: [], startId: 'slide_003' },
  ];

  it('節の先頭から始まる話題ごとに、前の画面・途切れている間の画面・最初の発話の画面を集める', () => {
    const [b, ...rest] = findBoundaries(sections, polished, topics);
    expect(rest).toEqual([]);
    expect(b).toEqual({
      topic: 1,
      heading: '本題',
      before: { id: 'slide_001', filename: 'slide_001.png', tail: '一枚目の本文。' },
      silent: [{ id: 'slide_002', filename: 'slide_002.png' }],
      after: { id: 'slide_003', filename: 'slide_003.png', head: '三枚目の本文。' },
    });
    // Codex が無音の節を始まりにしていても同じ境目
    expect(findBoundaries(sections, polished, [topics[0]!, { ...topics[1]!, startId: 'slide_002' }])[0]).toEqual(b);
    expect(keepMax(b!)).toBe(2);
    expect(boundaryImages([b!])).toEqual(['slide_001.png', 'slide_002.png', 'slide_003.png']);
  });

  it('本文の途中から始まる話題と、判定済みの話題は集めない', () => {
    const mid = new Map([...polished, ['slide_003', { text: '前の締め。\n\n三枚目の本文。' }]]);
    expect(findBoundaries(sections, mid, [topics[0]!, { ...topics[1]!, startText: '三枚目の本文。' }])).toEqual([]);
    expect(findBoundaries(sections, polished, [topics[0]!, { ...topics[1]!, placed: true }])).toEqual([]);
    // 最初の文が節の先頭なら、節の先頭から始まる話題として集める
    expect(findBoundaries(sections, polished, [topics[0]!, { ...topics[1]!, startText: '三枚目の本文。' }])).toHaveLength(1);
  });

  it('keep（前の話題に残す枚数）を話題の始まりに写す', () => {
    const b = findBoundaries(sections, polished, topics)[0]!;
    expect(placementFor(b, 0)).toEqual({ topic: 1, startId: 'slide_002' }); // 無音の画面から新しい話題
    expect(placementFor(b, 1)).toEqual({ topic: 1, startId: 'slide_003' }); // 話し始めた画面から
    expect(placementFor(b, 2)).toEqual({ topic: 1, startId: 'slide_003', startAfterImage: true }); // 本文だけ新しい話題
    // 返答の読み取り: 範囲外・重複・知らない境目は捨てる
    expect(parseBoundaryResponse(JSON.stringify({ boundaries: [{ boundary: 1, keep: 2 }, { boundary: 1, keep: 0 }, { boundary: 2, keep: 0 }, { boundary: 1, keep: 3 }] }), [b])).toEqual([
      { topic: 1, startId: 'slide_003', startAfterImage: true },
    ]);
    expect(() => parseBoundaryResponse('not json', [b])).toThrow(); // JSON でない返答は投げる（呼び出し側が失敗として記録する）
  });

  it('判定を話題に当てると startText は捨て、placed が付く', () => {
    const applied = applyPlacement([topics[0]!, { ...topics[1]!, startText: '三枚目の本文。' }], [{ topic: 1, startId: 'slide_002' }]);
    expect(applied).toEqual([topics[0], { heading: '本題', summary: [], startId: 'slide_002', placed: true }]);
    const text = applyPlacement(topics, [{ topic: 1, startId: 'slide_003', startAfterImage: true }]);
    expect(text[1]).toEqual({ heading: '本題', summary: [], startId: 'slide_003', startAfterImage: true, placed: true });
  });

  it('プロンプトは画像の番号で境目を説明し、keep の範囲を示す', () => {
    const b = findBoundaries(sections, polished, topics)[0]!;
    const p = buildBoundaryPrompt([b], imageNumbers(boundaryImages([b])));
    expect(p).toContain('境目 1: 新しい話題「本題」');
    expect(p).toContain('[1] 前の話題の最後の画面（数えない）。そのときの本文の末尾: 「…一枚目の本文。」');
    expect(p).toContain('[2] 話が途切れている間の画面');
    expect(p).toContain('[3] 新しい話題の最初の発話の画面。本文の冒頭: 「三枚目の本文。…」');
    expect(p).toContain('keep は 0〜2');
    expect(p).toContain('前の話題に残す枚数');
  });

  it('鍵は話題と節の並びとモデルで決まる', () => {
    const b = findBoundaries(sections, polished, topics)[0]!;
    const other: Boundary = { ...b, silent: [] };
    expect(boundaryCacheKey([b], 'm')).toBe(boundaryCacheKey([b], 'm'));
    expect(boundaryCacheKey([b], 'm')).not.toBe(boundaryCacheKey([other], 'm'));
    expect(boundaryCacheKey([b], 'm')).not.toBe(boundaryCacheKey([b], 'n'));
  });
});
