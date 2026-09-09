import { describe, expect, it } from 'vitest';
import { assignSlides, buildLectureMarkdown, slideStart, toParagraph, type MergedSegment, type SlideEntry } from './merge.ts';

const seg = (videoStart: number, text: string): MergedSegment => ({ start: videoStart, end: videoStart + 2, videoStart, videoEnd: videoStart + 2, text });
const slides: SlideEntry[] = [
  { filename: 'slide_001.png', videoTime: 10, reason: 'initial' },
  { filename: 'slide_002.png', videoTime: 61.5, reason: 'change' },
  { filename: 'slide_003.png', videoTime: 120, reason: 'manual' },
];

describe('slideStart', () => {
  it('moves auto-detected slides 1.5 s earlier, keeps initial and manual ones', () => {
    expect(slideStart(slides[0]!)).toBe(10);
    expect(slideStart(slides[1]!)).toBe(60);
    expect(slideStart(slides[2]!)).toBe(120);
    expect(slideStart({ filename: 'x.png', videoTime: 1, reason: 'change' })).toBe(0);
  });
});

describe('assignSlides', () => {
  it('assigns each segment to the slide shown at its start (D-14)', () => {
    const out = assignSlides([seg(5, 'before'), seg(10, 'first'), seg(59.9, 'still first'), seg(60, 'second'), seg(119, 'second too'), seg(500, 'third')], slides);
    expect(out.map((s) => s.slide)).toEqual([undefined, 'slide_001.png', 'slide_001.png', 'slide_002.png', 'slide_002.png', 'slide_003.png']);
  });
});

describe('toParagraph', () => {
  it('joins segments and breaks lines at 。', () => {
    expect(toParagraph([' 今日は色について。', 'まず働きから ', '話します。'])).toBe('今日は色について。\nまず働きから話します。');
  });
});

describe('buildLectureMarkdown', () => {
  it('writes one section per slide with the image and its text', () => {
    const md = buildLectureMarkdown({
      title: '第12章 色',
      url: 'https://example.test/lecture',
      startedAt: '2026-09-08T10:59:03.000Z',
      segments: [seg(5, '冒頭です。'), seg(12, '一枚目の話。'), seg(70, '二枚目の話。')],
      slides,
    });
    expect(md.startsWith('# 第12章 色\n')).toBe(true);
    expect(md).toContain('- 元ページ: https://example.test/lecture');
    expect(md).toContain('文字起こし: 3 区間\n\n冒頭です。');
    expect(md).not.toContain('## 00:');
    expect(md).toContain('---\n\n![slide_001](slides/slide_001.png)\n\n一枚目の話。');
    expect(md).toContain('---\n\n![slide_002](slides/slide_002.png)\n\n二枚目の話。');
    expect(md).toContain('---\n\n![slide_003](slides/slide_003.png)\n\n（このスライドの間の発話はありません）');
  });

  it('works without slides and without text', () => {
    const md = buildLectureMarkdown({ segments: [seg(0, 'テキストだけ。')], slides: [] });
    expect(md).toContain('# 講義ノート');
    expect(md).toContain('\n\nテキストだけ。');
    expect(buildLectureMarkdown({ segments: [], slides: [] })).toContain('（文字起こしがありません）');
  });
});
