import { describe, expect, it } from 'vitest';
import { assignSlides, buildLectureMarkdown, buildNotesMarkdown, endsSentence, groupSections, innerSentenceEnds, isSlideList, sentenceUnits, slideStart, toParagraph, type MergedSegment, type SlideEntry } from './merge.ts';

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

describe('isSlideList', () => {
  it('拡張が付ける名前（slide_001.png / .jpg）だけを受け付ける', () => {
    expect(isSlideList([{ filename: 'slide_001.png', videoTime: 0 }, { filename: 'slide_1234.jpg', videoTime: 5 }])).toBe(true);
    expect(isSlideList([])).toBe(true);
    // 名前はそのままパスにして ffmpeg や Vision に渡すので、フォルダの外を指す名前が 1 つでもあれば全体を捨てる
    for (const filename of ['../slide_001.png', '/etc/passwd', 'slide_001.png/../../x', 'slide_001.gif', 'x.png']) {
      expect(isSlideList([{ filename: 'slide_001.png', videoTime: 0 }, { filename, videoTime: 1 }])).toBe(false);
    }
    expect(isSlideList([{ filename: 'slide_001.png' }])).toBe(false);
    expect(isSlideList({ filename: 'slide_001.png', videoTime: 0 })).toBe(false);
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

  // 1 章 GD I-4 の腕の実演の形（2026-10-02）。区間の途中で前の話題が終わり、末尾の「次に」が次の話題の文につながる
  const arm = () => [
    { start: 155.9, end: 160.1, videoStart: 155.9, videoEnd: 160.1, text: 'アイデアというものがたくさん発想できるようになります' },
    { start: 160.1, end: 171.5, videoStart: 160.1, videoEnd: 171.5, text: 'できるということになりますなのでデッサンをすることがアイデアを生み出す そういう訓練になるということを覚えておいてほしいなというふうに思っています次に' },
    { start: 171.5, end: 182.3, videoStart: 171.5, videoEnd: 182.3, text: '自分の腕を見てほしいんですけれども 例えば手のひらを垂直にこう出した時に出して' },
    { start: 182.3, end: 192.3, videoStart: 182.3, videoEnd: 192.3, text: '肘の部分を固定しますその時に自然に腕が折れるのはこうはなかなか折れない' },
  ];
  const armSlides: SlideEntry[] = [
    { filename: 'slide_018.png', videoTime: 134.3, reason: 'change' },
    { filename: 'slide_020.png', videoTime: 175.2, reason: 'change' },
  ];

  it('画像の境目をまたぐ長い文は、区間の途中の文の切れ目で分ける（前の話題の締めを次の画像の後ろに送らない）', () => {
    const out = assignSlides(arm(), armSlides);
    expect(out.map((s) => [s.slide, s.text.slice(0, 8)])).toEqual([
      ['slide_018.png', 'アイデアというも'],
      ['slide_018.png', 'できるということ'],
      ['slide_020.png', '次に'],
      ['slide_020.png', '自分の腕を見てほ'],
      ['slide_020.png', '肘の部分を固定し'],
    ]);
    // 分けた位置の時刻は文字数の比で見積もる。もとの区間の範囲に収まり、隙間なく続く
    expect(out[1]!.videoStart).toBe(160.1);
    expect(out[1]!.videoEnd).toBeCloseTo(out[2]!.videoStart, 6);
    expect(out[2]!.videoEnd).toBe(171.5);
    expect(out[1]!.videoEnd).toBeGreaterThan(160.1);
    expect(out[1]!.videoEnd).toBeLessThan(171.5);
    // 分けなかった区間はそのまま
    expect(out[0]!.text).toBe(arm()[0]!.text);
  });

  it('分けた部分が短い（時刻の誤差で倒れやすい）なら分けない', () => {
    // 「続いてCです」はスライドが変わった直後に言う短い文。分けると前のスライドに付いてしまう
    const out = assignSlides([{ ...seg(58, '続いてCです 何が違うでしょうか'), videoEnd: 66 }], slides);
    expect(out).toHaveLength(1);
    expect(out[0]!.slide).toBe('slide_002.png');
  });

  it('次の話題の前置きで始まる文は、時刻の上で前の画像の間でも次の画像に付ける', () => {
    const intro = [
      { start: 40, end: 52, videoStart: 40, videoEnd: 52, text: '前のスライドの話をここまでしてきましたので覚えておいてください' },
      { start: 52, end: 72, videoStart: 52, videoEnd: 72, text: 'もう一つものの見方としてお話ししたいことは輪郭ですね輪郭というものをよく見てほしいんですけれどもこの影の部分というのは背景よりも濃くなっているはずです' },
    ];
    const out = assignSlides(intro, slides);
    expect(out.map((s) => s.slide)).toEqual(['slide_001.png', 'slide_002.png']);
    expect(out[1]!.text.startsWith('もう一つ')).toBe(true);
  });

  it('境目をまたがない文は、区間の途中に文の切れ目があっても分けない', () => {
    const out = assignSlides([{ ...seg(20, '一つ目です。二つ目です。三つ目です'), videoEnd: 40 }], slides);
    expect(out).toHaveLength(1);
  });
});

describe('innerSentenceEnds', () => {
  it('句点と丁寧形の文末の直後を返し、区間の末尾は含めない', () => {
    const text = 'なりますなのでデッサンを覚えておいてほしいと思っています次に';
    expect(innerSentenceEnds(text).map((at) => text.slice(0, at).slice(-4))).toEqual(['なります', 'ています']);
    expect(innerSentenceEnds('一つ目。二つ目。')).toEqual([4]);
  });

  it('文が続く形（ですから・ますので・ですが・ですかというと）では切らない', () => {
    expect(innerSentenceEnds('珍しい昆虫ですからメスを見つけるのも大変')).toEqual([]);
    expect(innerSentenceEnds('見ることができますので発想できる')).toEqual([]);
    expect(innerSentenceEnds('そうなんですが実は違う')).toEqual([]);
    expect(innerSentenceEnds('なぜでしょうかというと構造です')).toEqual([]);
  });

  it('「ですかね」「ましょうか」は付いた語まで含めて切る', () => {
    const text = 'こんな感じですかね一応わかりやすくします';
    expect(innerSentenceEnds(text).map((at) => text.slice(0, at))).toEqual(['こんな感じですかね']);
  });

  it('言いよどみの「ですね」（助詞の直後）では切らない', () => {
    expect(innerSentenceEnds('今度はですねこの参考に今ここね')).toEqual([]);
    expect(innerSentenceEnds('さらにですね1978年の空港')).toEqual([]);
    const text = 'お話ししたいことは輪郭ですね輪郭を見てください';
    expect(innerSentenceEnds(text).map((at) => text.slice(0, at))).toEqual(['お話ししたいことは輪郭ですね']);
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
    // 記号だけの本文（古い transcript に残った「♪」など）は発話ではないので、注意書きも本文も出さず画像だけにする
    const symbolOnly = [{ ...sections[0]!, texts: [' ♪'] }];
    const quiet = buildNotesMarkdown({ sections: symbolOnly, polished: new Map([['slide_001', { text: '' }]]) });
    expect(quiet).not.toContain('整えられなかったため');
    expect(quiet).not.toContain('♪');
    // 発話と記号が混ざった節では、発話だけを載せて記号は除く
    const mixed = [{ ...sections[0]!, texts: ['一枚目の話。', '♪'] }];
    const kept = buildNotesMarkdown({ sections: mixed, polished: new Map([['slide_001', { text: '' }]]) });
    expect(kept).toContain('（整えられなかったため文字起こしのまま）\n\n一枚目の話。');
    expect(kept).not.toContain('♪');
  });

  it('leaves a silent slide as the image alone', () => {
    const silent = groupSections([seg(12, '一枚目の話。')], slides);
    const md = buildNotesMarkdown({ sections: silent, polished: new Map([['slide_001', { text: '一枚目の本文。' }], ['slide_002', { text: '' }]]) });
    expect(md).not.toContain('（整えられなかった');
    expect(md.endsWith('![slide_002](slides/slide_002.png)\n')).toBe(true);
  });
});
