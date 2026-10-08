import { describe, expect, it } from 'vitest';
import { assignSlides, buildLectureMarkdown, buildNotesMarkdown, endsSentence, groupAssigned, groupSections, innerSentenceEnds, isSlideList, sentenceUnits, slideStart, toParagraph, type MergedSegment, type SlideEntry } from './merge.ts';

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

  it('分けた部分が短い（時刻の誤差で倒れやすい）なら分けず、文全体を長く映っていた方に付ける', () => {
    // 前置きの語を含まない文で、境目（60 秒）の手前の部分が 5 秒未満
    const out = assignSlides([{ ...seg(57, 'そうなります。これはとても大事な話なので最後までよく聞いておいてください'), videoEnd: 75 }], slides);
    expect(out).toHaveLength(1);
    expect(out[0]!.slide).toBe('slide_002.png');
  });

  it('前置きの語で始まる短い文も、次の画像に付く', () => {
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

  it('前置きの文が区間の途中にあっても、次の画像に寄せる（まとめて 1 つになっても前の画像に戻さない）', () => {
    const ab: SlideEntry[] = [
      { filename: 'slide_a.png', videoTime: 0, reason: 'manual' },
      { filename: 'slide_b.png', videoTime: 30, reason: 'manual' },
    ];
    const out = assignSlides([{ start: 10, end: 45, videoStart: 10, videoEnd: 45, text: 'まえのスライドの話はここまでになりますもう一つお話ししたいのは輪郭ですね輪郭というものは背景との関係で決まるのでよく見てほしいと思います' }], ab);
    expect(out.map((s) => [s.slide, s.text.slice(0, 4)])).toEqual([
      ['slide_a.png', 'まえのス'],
      ['slide_b.png', 'もう一つ'],
    ]);
    // 前置きの文と、そのあとの文が 1 つの区間でも、全体が前の画像（長く映っていた方）に戻らない
    const whole = assignSlides([{ start: 22, end: 40, videoStart: 22, videoEnd: 40, text: 'もう一つお話ししたいのは輪郭ですね輪郭は背景との関係で決まります' }], ab);
    expect(whole.every((s) => s.slide === 'slide_b.png')).toBe(true);
  });

  // 前置き 12 文字＋続き 36 文字の 1 区間（15〜45 秒）。前置きは 22.5 秒に終わる
  const cueSeg = () => [{ start: 15, end: 45, videoStart: 15, videoEnd: 45, text: '次に左の図を見てくださいこの写真では線の太さがかなり違っていて右の方が太くなっているのがわかります' }];
  const at = (name: string, videoTime: number): SlideEntry => ({ filename: name, videoTime, reason: 'manual' });

  it('前置きは、すぐ次の画像に切り替わる直前に終わるなら次の画像に寄せる', () => {
    const out = assignSlides(cueSeg(), [at('z.png', 0), at('b.png', 24)]);
    expect(out.map((s) => s.slide)).toEqual(['b.png']);
  });

  it('前置きは 1 枚先の画像までしか寄せない（スライドを飛ばさない）', () => {
    // 続きの文は b に付くが、前置き（z に付く）から見て b は 2 枚先（a を飛ばす）なので寄せない
    const out = assignSlides(cueSeg(), [at('z.png', 0), at('a.png', 20), at('b.png', 26)]);
    expect(out.map((s) => [s.slide, s.text.slice(0, 2)])).toEqual([
      ['z.png', '次に'],
      ['b.png', 'この'],
    ]);
  });

  it('前の画像の間に長く話した文は、前置きの語で始まっても次の画像に寄せない', () => {
    // 「では…」の文は 0〜37 秒（36 秒）。前の画像に長く映っていた
    const out = assignSlides(
      [{ start: 0, end: 60, videoStart: 0, videoEnd: 60, text: 'ではこの図の左側にある線の細かいところを順番に説明していきますのでよく見ておいてほしいと思いますこの線の太さと隣の写真の線の太さを比べると違いがわかるはず' }],
      [at('a.png', 0), at('b.png', 40)],
    );
    expect(out.map((s) => [s.slide, s.text.slice(0, 2)])).toEqual([
      ['a.png', 'では'],
      ['b.png', 'この'],
    ]);
  });

  it('前の区間が「今度は」で終わり、次の区間が「ですね」で始まるときは、言いよどみとして切らない', () => {
    const out = assignSlides(
      [
        { start: 10, end: 24, videoStart: 10, videoEnd: 24, text: '前の図の説明はここまでにして今度は' },
        { start: 24, end: 50, videoStart: 24, videoEnd: 50, text: 'ですねこの参考になる図を見ていきたいと思いますがよく見てください' },
      ],
      [at('a.png', 0), at('b.png', 30)],
    );
    expect(out.map((s) => s.text)).not.toContain('ですね');
  });

  it('区間の途中で動画を巻き戻していたら（動画の時刻が逆）、分けない', () => {
    const out = assignSlides([{ start: 0, end: 30, videoStart: 60, videoEnd: 20, text: 'ここまでになります次に新しい図の話をしていきますのでよく見てください' }], [at('a.png', 0), at('b.png', 40)]);
    expect(out).toHaveLength(1);
  });

  it('「ですかね」で分けた文は、そこで文が切れたものとして割り当てる', () => {
    const ab: SlideEntry[] = [
      { filename: 'slide_a.png', videoTime: 0, reason: 'manual' },
      { filename: 'slide_b.png', videoTime: 30, reason: 'manual' },
    ];
    const out = assignSlides([{ start: 14, end: 51, videoStart: 14, videoEnd: 51, text: '前のスライドの話はここまでで大体こんな感じですかねそれから新しい図の話をしていきたいと思いますのでよく見てください' }], ab);
    expect(out.map((s) => s.slide)).toEqual(['slide_a.png', 'slide_b.png']);
  });

  it('短い部分が 1 つでもあれば、ほかの部分が長くても分けない（短い部分だけ寄せる形は実データで悪くなった）', () => {
    const abc: SlideEntry[] = [
      { filename: 'slide_a.png', videoTime: 0, reason: 'manual' },
      { filename: 'slide_b.png', videoTime: 19, reason: 'manual' },
      { filename: 'slide_c.png', videoTime: 23, reason: 'manual' },
    ];
    const out = assignSlides([{ start: 0, end: 43, videoStart: 0, videoEnd: 43, text: 'Aの話をずっとしています長い説明です。Bです。Cの話をこれからずっとしていきます長い説明です' }], abc);
    expect(out).toHaveLength(1);
  });

  it('返した区間の slide を使って束ねれば、もう一度かけ直したときと同じ節になる', () => {
    const zab: SlideEntry[] = [
      { filename: 'slide_z.png', videoTime: 0, reason: 'manual' },
      { filename: 'slide_a.png', videoTime: 10, reason: 'manual' },
      { filename: 'slide_b.png', videoTime: 40, reason: 'manual' },
    ];
    const once = assignSlides([{ start: 5, end: 60, videoStart: 5, videoEnd: 60, text: 'まえの話になります次に新しい図を見てくださいここが大事ですこの写真の話をしますね今度は別のことをお話しします' }], zab);
    const twice = assignSlides(once, zab);
    expect(twice.map((s) => s.slide)).toEqual(once.map((s) => s.slide));
    const sections = groupAssigned(once as MergedSegment[], zab);
    expect(sections.map((s) => s.texts.join(''))).toEqual(['まえの話になります', ...['slide_a.png', 'slide_b.png'].map((f) => once.filter((s) => s.slide === f).map((s) => s.text).join(''))]);
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

  it('「ませんでした」「ましたら」「ですら」「〜」という」「ますます」「ますでしょうか」「ですかどうか」は文の途中', () => {
    const show = (t: string) => innerSentenceEnds(t).map((at) => t.slice(0, at));
    expect(show('わかりませんでしたなので次に')).toEqual(['わかりませんでした']);
    expect(show('わかりませんでしたがそれでも続けます')).toEqual([]);
    expect(show('描き終わりましたら次に進みます')).toEqual([]);
    expect(show('専門家ですらわからない問題です')).toEqual([]);
    expect(show('「よく見てください」という話をしました次に')).toEqual(['「よく見てください」という話をしました']);
    expect(show('「はい。」と言って始めます')).toEqual([]);
    expect(show('ますます面白くなります')).toEqual([]);
    expect(show('できますでしょうかと聞きます')).toEqual([]);
    expect(show('これでいいですかどうか確かめます')).toEqual([]);
    // 句点のあとは「し」で始まっても切る（「しかし」など）
    expect(show('そうなります。しかし違います')).toEqual(['そうなります。']);
  });

  it('次の語の頭（よく・かなり・よろしい）を文末の「よ」「か」として取り込まない', () => {
    const show = (t: string) => innerSentenceEnds(t).map((at) => t.slice(0, at));
    expect(show('今ここに線がありますよく見てくださいこの線の太さが')).toEqual(['今ここに線があります', '今ここに線がありますよく見てください']);
    expect(show('大事ですかなり重要')).toEqual(['大事です']);
    expect(show('いいですよろしい')).toEqual(['いいです']);
    // 文末の「ね」は空白をはさんでも取り込む
    expect(show('こういう感じになるんです ね 次にこちらの図を')).toEqual(['こういう感じになるんです ね']);
  });

  it('「で」＋「す」で始まる語、普通体の「〜ます」、「くださいました」の途中では切らない', () => {
    const show = (t: string) => innerSentenceEnds(t).map((at) => t.slice(0, at));
    expect(show('これですぐわかるように')).toEqual([]);
    expect(show('きれいな書体ですごくかっこいいですよね')).toEqual([]);
    expect(show('手でする作業です')).toEqual([]);
    expect(show('目を覚ます前に')).toEqual([]);
    expect(show('教えてくださいましたこの図')).toEqual(['教えてくださいました']);
  });

  it('続く句点・感嘆符・三点リーダーは 1 つの終わりとして扱う（記号だけの部分を作らない）', () => {
    const show = (t: string) => innerSentenceEnds(t).map((at) => t.slice(0, at));
    expect(show('本当ですか？！次に行きます')).toEqual(['本当ですか？！']);
    expect(show('そうなんです…。次に')).toEqual(['そうなんです…。']);
  });

  it('言いよどみの「ですね」（助詞の直後）では切らない', () => {
    expect(innerSentenceEnds('今度は ですね この参考に')).toEqual([]);
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
    // 話題ごとの要点（summary）は出さない。見出しのすぐ下に画像と本文（2026-10-08）
    expect(md).toContain('## 全体の要点\n\n- 全体 1\n\n## 導入\n\n![slide_001](slides/slide_001.png)\n\n一枚目の本文。');
    expect(md).not.toContain('導入の要点');
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
    // 言いよどみの音だけの節（実例: 2 章 GD I-4 の最後の「ん」「ん」「ん」）は、整えて空になっても画像だけにする
    const fillerOnly = [{ ...sections[0]!, texts: ['ん', 'ん', 'ん'] }];
    const filler = buildNotesMarkdown({ sections: fillerOnly, polished: new Map([['slide_001', { text: '' }]]) });
    expect(filler).not.toContain('整えられなかったため');
    expect(filler).not.toContain('ん\n');
  });

  it('leaves a silent slide as the image alone', () => {
    const silent = groupSections([seg(12, '一枚目の話。')], slides);
    const md = buildNotesMarkdown({ sections: silent, polished: new Map([['slide_001', { text: '一枚目の本文。' }], ['slide_002', { text: '' }]]) });
    expect(md).not.toContain('（整えられなかった');
    expect(md.endsWith('![slide_002](slides/slide_002.png)\n')).toBe(true);
  });
});
