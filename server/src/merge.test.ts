import { describe, expect, it } from 'vitest';
import { assignSlides, buildLectureMarkdown, buildNotesMarkdown, endsSentence, groupSections, sentenceUnits, slideStart, toParagraph, type MergedSegment, type SlideEntry } from './merge.ts';

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

describe('endsSentence', () => {
  it('句点か、です・ます・でしょう などの述語で終われば文末', () => {
    for (const t of ['お話しします。', '説明してきました', '見てみましょう', '脳があるのでしょうか', 'いっぱいです」', 'ですね', '珍しいことです！', '']) {
      expect(endsSentence(t), t).toBe(true);
    }
  });
  it('助詞や「〜て」「、」で終われば文の途中', () => {
    for (const t of ['産むというのが', '珍しいため撮影も難しく', '成長段階がある昆虫であること、', 'できないので', '近くにいるカメムシを見つけて']) {
      expect(endsSentence(t), t).toBe(false);
    }
  });
});

describe('sentenceUnits', () => {
  it('文の途中で切れた区間を次の区間とまとめ、2 秒以上空けば句点がなくても切る', () => {
    const segments = [seg(0, 'メスが直接幼虫を産むというのが'), seg(2, 'イメージしにくいかもしれません'), seg(4, '次はねじれ羽の生活サイクルについて'), seg(9, 'お話しします'), seg(11, '次の動画もお楽しみに')];
    expect(sentenceUnits(segments)).toEqual([
      [0, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
  });
  it('本文のない区間は区間ごと', () => {
    expect(sentenceUnits([{ videoStart: 0 }, { videoStart: 1 }])).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });
});

describe('assignSlides', () => {
  it('assigns each segment to the slide shown at its start (D-14)', () => {
    const out = assignSlides([seg(5, '冒頭。'), seg(10, '一枚目。'), seg(57.9, 'まだ一枚目。'), seg(60, '二枚目。'), seg(119, 'まだ二枚目。'), seg(500, '三枚目。')], slides);
    expect(out.map((s) => s.slide)).toEqual([undefined, 'slide_001.png', 'slide_001.png', 'slide_002.png', 'slide_002.png', 'slide_003.png']);
  });

  it('文の途中でスライドが変わったら、長く映っていた方のスライドに文ごと付ける', () => {
    // 58.5〜62.5 秒の 1 文。切り替えは 60 秒: slide_001 に 1.5 秒、slide_002 に 2.5 秒
    const later = assignSlides([seg(58.5, 'メスが直接幼虫を産むというのが'), seg(60.5, 'イメージしにくいかもしれません'), seg(62.5, 'ここではその映像を見てみましょう')], slides);
    expect(later.map((s) => s.slide)).toEqual(['slide_002.png', 'slide_002.png', 'slide_002.png']);
    // 55〜61 秒の 1 文。slide_001 に 5 秒、slide_002 に 1 秒
    const earlier = assignSlides([seg(55, 'メスが直接幼虫を産むというのが'), seg(57, 'とても'), seg(59, 'イメージしにくいかもしれません'), seg(61, '映像を見てみましょう')], slides);
    expect(earlier.map((s) => s.slide)).toEqual(['slide_001.png', 'slide_001.png', 'slide_001.png', 'slide_002.png']);
  });

  it('1 つの区間の中で切り替わったときも、長く映っていた方に付ける', () => {
    const out = assignSlides([{ ...seg(59, '二枚目の話です。'), videoEnd: 64 }], slides);
    expect(out[0]!.slide).toBe('slide_002.png');
  });
});

describe('groupSections', () => {
  it('画像が文の途中に入らない', () => {
    const sections = groupSections([seg(50, '一枚目の話です。'), seg(58.5, 'メスが直接幼虫を産むというのが'), seg(60.5, 'イメージしにくいかもしれません'), seg(62.5, 'ここではその映像を見てみましょう')], slides);
    expect(sections.map((s) => s.texts)).toEqual([['一枚目の話です。'], ['メスが直接幼虫を産むというのが', 'イメージしにくいかもしれません', 'ここではその映像を見てみましょう'], []]);
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
    expect(md).toContain('![slide_001](slides/slide_001.png)\n\n一枚目の話。');
    expect(md).toContain('![slide_002](slides/slide_002.png)\n\n二枚目の話。');
    // 発話のないスライドは画像だけ（注記なし）。最後の節なので画像で終わる
    expect(md.endsWith('![slide_003](slides/slide_003.png)\n')).toBe(true);
    expect(md).not.toContain('発話はありません');
    expect(md).not.toContain('\n---\n');
  });

  it('works without slides and without text', () => {
    const md = buildLectureMarkdown({ segments: [seg(0, 'テキストだけ。')], slides: [] });
    expect(md).toContain('# ノート');
    expect(md).toContain('\n\nテキストだけ。');
    expect(buildLectureMarkdown({ segments: [], slides: [] })).toContain('（文字起こしがありません）');
  });
});

describe('buildNotesMarkdown', () => {
  const slides = [
    { filename: 'slide_001.png', seq: 1, videoTime: 10, t: 10, reason: 'initial' as const },
    { filename: 'slide_002.png', seq: 2, videoTime: 60, t: 60, reason: 'change' as const },
  ];
  const sections = groupSections([seg(12, '一枚目の話。'), seg(70, '二枚目の話。')], slides);
  const polished = new Map([['slide_001', { text: '一枚目の本文。' }]]);

  it('puts the overview first and headings at topic starts, with a rule between slides inside a topic', () => {
    const md = buildNotesMarkdown({
      title: '色',
      sections,
      polished,
      outline: { overview: ['全体 1'], topics: [{ heading: '導入', summary: ['導入の要点'], startId: 'slide_001' }] },
    });
    expect(md).toContain('## 全体の要点\n\n- 全体 1\n\n## 導入\n\n**要点**\n\n- 導入の要点\n\n![slide_001](slides/slide_001.png)\n\n一枚目の本文。');
    expect(md).toContain('![slide_002](slides/slide_002.png)\n\n（整えられなかったため文字起こしのまま）\n\n二枚目の話。');
  });

  it('works without an outline', () => {
    const md = buildNotesMarkdown({ sections, polished });
    expect(md).not.toContain('## ');
    expect(md).toContain('![slide_001](slides/slide_001.png)\n\n一枚目の本文。\n\n![slide_002]');
  });

  it('falls back to the transcript when the polished text came back empty', () => {
    // LLM が本文を落としてしまっても、発話があった節を黙って消さない
    const md = buildNotesMarkdown({ sections, polished: new Map([['slide_001', { text: '' }]]) });
    expect(md).toContain('![slide_001](slides/slide_001.png)\n\n（整えられなかったため文字起こしのまま）\n\n一枚目の話。');
  });

  it('leaves a silent slide as the image alone', () => {
    const silent = groupSections([seg(12, '一枚目の話。')], slides);
    const md = buildNotesMarkdown({ sections: silent, polished: new Map([['slide_001', { text: '一枚目の本文。' }], ['slide_002', { text: '' }]]) });
    expect(md).not.toContain('（整えられなかった');
    expect(md.endsWith('![slide_002](slides/slide_002.png)\n')).toBe(true);
  });
});
