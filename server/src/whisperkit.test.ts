import { describe, expect, it } from 'vitest';
import { dropWindowArtifacts, isStockPhraseOnly, normalizeReport, whisperkitArgs } from './whisperkit.ts';

describe('normalizeReport', () => {
  it('reads { segments } and strips special tokens', () => {
    const raw = {
      text: 'ignored',
      segments: [
        { id: 1, start: 4, end: 2, text: '<|startoftranscript|><|ja|> 二番目 <|endoftext|>' },
        { id: 0, start: 0, end: 1.5, text: '  一番目  ' },
        { id: 2, start: 5, end: 6, text: '<|nospeech|>' },
      ],
    };
    expect(normalizeReport(raw)).toEqual([
      { start: 0, end: 1.5, text: '一番目' },
      { start: 4, end: 4, text: '二番目' },
    ]);
  });

  it('reads the real whisperkit-cli 1.1 report shape (chunks may overlap)', () => {
    // 実機の report: { text, segments: [{ id, seek, start, end, text, tokens, tokenLogProbs, ... }], language, timings }
    const raw = {
      text: '…',
      language: 'ja',
      timings: { fullPipeline: 12.3 },
      segments: [
        { id: 0, seek: 0, start: 0, end: 9, text: '第12章ということで', tokens: [1, 2], tokenLogProbs: [{ '50258': 0 }], avgLogprob: -0.2 },
        { id: 1, seek: 0, start: 9, end: 19, text: 'まずは', tokens: [3] },
        { id: 1, seek: 291200, start: 18.2, end: 22.2, text: '色々に働きあるので', tokens: [4] },
      ],
    };
    expect(normalizeReport(raw).map((s) => [s.start, s.end, s.text])).toEqual([
      [0, 9, '第12章ということで'],
      [9, 19, 'まずは'],
      [18.2, 22.2, '色々に働きあるので'],
    ]);
  });

  it('accepts an array of results and startTime/endTime keys', () => {
    const raw = [{ segments: [{ startTime: '1.0', endTime: '2.0', text: 'a' }] }, { segments: [{ start: 3, end: 4, text: 'b' }] }];
    expect(normalizeReport(raw)).toEqual([
      { start: 1, end: 2, text: 'a' },
      { start: 3, end: 4, text: 'b' },
    ]);
  });

  it('returns nothing for unknown shapes', () => {
    expect(normalizeReport({ foo: 1 })).toEqual([]);
    expect(normalizeReport(null)).toEqual([]);
  });
});

describe('whisperkitArgs', () => {
  it('builds the transcribe command line', () => {
    const args = whisperkitArgs({ audioPath: '/a.wav', model: 'large-v3', language: 'ja', reportDir: '/r' });
    expect(args.slice(0, 3)).toEqual(['transcribe', '--audio-path', '/a.wav']);
    expect(args).toContain('--report');
    expect(args[args.indexOf('--report-path') + 1]).toBe('/r');
    expect(args[args.indexOf('--language') + 1]).toBe('ja');
  });
});

describe('dropWindowArtifacts', () => {
  it('文字を含まない記号だけの区間（動画の最後の音楽の「♪」など）は発話ではないので捨てる', () => {
    const segments = [
      { start: 0, end: 5, text: 'アイデアの基礎の科目を担当します' },
      { start: 88, end: 90, text: ' ♪' },
      { start: 91, end: 92, text: '♪〜🎵' },
    ];
    const { kept, dropped } = dropWindowArtifacts(segments);
    expect(kept.map((s) => s.text)).toEqual(['アイデアの基礎の科目を担当します']);
    expect(dropped.map((d) => d.reason)).toEqual(['symbol', 'symbol']);
    // 言いよどみの音だけの区間も捨てる（実例: 2 章 GD I-4 の最後に、締めの音楽の上で 2 秒ずつの「ん」が 3 つ）
    const fillers = dropWindowArtifacts([
      { start: 400.8, end: 402.96, text: '不備のないように注意してください' },
      { start: 406.9, end: 408.9, text: 'ん' },
      { start: 409.9, end: 411.9, text: 'ん' },
      { start: 411.9, end: 413.9, text: 'ん' },
    ]);
    expect(fillers.kept.map((s) => s.text)).toEqual(['不備のないように注意してください']);
    expect(fillers.dropped.map((d) => d.reason)).toEqual(['filler', 'filler', 'filler']);
    // 発話が 1 つもない録音（音楽だけの動画など）は、全部を失敗にしないため何も捨てない
    const musicOnly = dropWindowArtifacts([{ start: 0, end: 5, text: '♪' }, { start: 5, end: 9, text: '🎵' }]);
    expect(musicOnly.kept).toHaveLength(2);
    expect(musicOnly.dropped).toHaveLength(0);
  });

  it('決まり文句だけの区間は、最後に間を空けて出ても捨てる（本物の締めでもノートの中身は失われない）', () => {
    const segments = [
      { start: 0, end: 95, text: '本編の話をしています' },
      { start: 95.5, end: 99, text: 'ご視聴ありがとうございました' },
      { start: 100, end: 160, text: '♪' },
    ];
    const { kept, dropped } = dropWindowArtifacts(segments);
    expect(kept.map((s) => s.text)).toEqual(['本編の話をしています']);
    expect(dropped.map((d) => d.reason)).toEqual(['phrase', 'symbol']);
  });

  it('記号区間は重なりの証拠には数える（音楽の帯としか重なっていない幻覚の窓も落とす）', () => {
    const segments = [
      { start: 0, end: 10, text: '本編の話をしています' },
      // 30 秒の窓いっぱいの幻覚。重なるのは音楽の帯だけ
      { start: 100, end: 130, text: 'この動画が役に立ったと思った方は高評価をお願いします' },
      { start: 100, end: 115, text: '♪' },
      { start: 115, end: 130, text: '♪〜' },
    ];
    const { kept, dropped } = dropWindowArtifacts(segments);
    expect(kept.map((s) => s.text)).toEqual(['本編の話をしています']);
    expect(dropped.map((d) => d.reason).sort()).toEqual(['overlap', 'symbol', 'symbol']);
  });

  it('drops 30-second window segments that overlap real speech, and long stock phrases', () => {
    // 実例（1章）: 59.6〜89.6 の決まり文句が 61〜86 秒の本物の発話と重なっていた
    const segments = [
      { start: 55.6, end: 59.6, text: 'この羽を外してみると、' },
      { start: 59.6, end: 89.58, text: 'ご視聴ありがとうございました' },
      { start: 61.3, end: 66.8, text: 'ここに見えているのがねじればねの頭になります' },
      { start: 68.3, end: 75.8, text: 'このように体の中にねじればねの本体が寄生しています' },
      { start: 75.8, end: 105.78, text: 'ご視聴ありがとうございました' },
      { start: 77.4, end: 86.4, text: '寄生とは、生物が他の生物についたりして、そこから栄養を取ることです' },
      { start: 300, end: 330, text: 'ここからは長い説明が続きますが本物の発話で、重なる区間はありません' },
      { start: 400, end: 402, text: 'ご視聴ありがとうございました' },
    ];
    const { kept, dropped } = dropWindowArtifacts(segments);
    expect(dropped.map((s) => s.start)).toEqual([59.6, 75.8, 400]);
    // 重なりのない長い区間は残す
    expect(kept.map((s) => s.start)).toEqual([55.6, 61.3, 68.3, 77.4, 300]);
  });

  it('drops the same overlapping windows by the overlap rule alone (no known phrase)', () => {
    // 決まり文句でない幻覚（窓いっぱいに広がるだけ）も、重なりだけで落ちる
    const { kept, dropped } = dropWindowArtifacts([
      { start: 55.6, end: 59.6, text: 'この羽を外してみると、' },
      { start: 59.6, end: 89.58, text: '窓いっぱいに広がった実在しない区間です' },
      { start: 61.3, end: 66.8, text: 'ここに見えているのがねじればねの頭になります' },
      { start: 68.3, end: 75.8, text: 'このように体の中にねじればねの本体が寄生しています' },
      { start: 300, end: 330, text: '長いけれど他と重ならない本物の発話なので残る' },
    ]);
    expect(dropped.map((s) => [s.start, s.reason])).toEqual([[59.6, 'overlap']]);
    expect(kept.map((s) => s.start)).toEqual([55.6, 61.3, 68.3, 300]);
  });

  it('keeps the real long segment that a hallucinated window overlaps', () => {
    // 幻覚の窓（長いほう）だけを落とし、巻き込まれた本物の長い区間は残す
    const { kept, dropped } = dropWindowArtifacts([
      { start: 60, end: 90, text: '窓いっぱいに広がった実在しない区間です' },
      { start: 62, end: 88, text: '本物の長い説明がここに入ります。26 秒あるので窓いっぱいの判定に引っかかる' },
    ]);
    expect(dropped.map((s) => s.start)).toEqual([60]);
    expect(kept.map((s) => s.start)).toEqual([62]);
  });

  it('drops a stock phrase that is too long for the words it contains', () => {
    const { kept, dropped } = dropWindowArtifacts([
      { start: 0, end: 4, text: 'こんにちは' },
      { start: 10, end: 40, text: 'ご視聴ありがとうございました。' },
    ]);
    expect(dropped.map((s) => s.reason)).toEqual(['phrase']);
    expect(kept).toHaveLength(1);
  });

  it('言い回しの違いや前置きの付いた決まり文句も、それだけの区間なら捨てる', () => {
    const { kept, dropped } = dropWindowArtifacts([
      { start: 0, end: 4, text: 'こんにちは' },
      // 実例（7 章 GD I-3）: 宣伝映像の音楽の上に 25 秒
      { start: 888.7, end: 914.0, text: 'それではご視聴ありがとうございました' },
      { start: 920, end: 922, text: '最後までご視聴いただきありがとうございました' },
      { start: 930, end: 932, text: 'チャンネル登録と高評価をよろしくお願いいたします' },
      { start: 940, end: 942, text: 'はい ありがとうございました' },
    ]);
    expect(dropped.map((s) => s.start)).toEqual([888.7, 920, 930, 940]);
    expect(kept.map((s) => s.start)).toEqual([0]);
  });

  it('drops a repeated stock phrase (Whisper のループ)', () => {
    const { kept, dropped } = dropWindowArtifacts([
      { start: 0, end: 4, text: 'こんにちは' },
      { start: 10, end: 40, text: 'ご視聴ありがとうございました。ご視聴ありがとうございました。ご視聴ありがとうございました。' },
    ]);
    expect(dropped.map((s) => s.reason)).toEqual(['phrase']);
    expect(kept.map((s) => s.start)).toEqual([0]);
  });

  it('keeps a long segment that merely contains a stock phrase', () => {
    const { kept, dropped } = dropWindowArtifacts([
      { start: 0, end: 30, text: '本日の講義はここまでです。ご視聴ありがとうございました。次回は色について話します。' },
    ]);
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });
});

describe('話の途中の決まり文句', () => {
  it('「ありがとうございました」だけの区間は、話の途中でも最後でも捨てる', () => {
    // 実例（5 章）: 2.0 秒ちょうどの区間が話の途中に出る。最後に間を空けて出たものも、録音では無音だった（GD I-3 8 章・14 章）
    const { kept, dropped } = dropWindowArtifacts([
      { start: 170.2, end: 172.0, text: '実際にやってみましょう' },
      { start: 172.0, end: 174.0, text: 'ありがとうございました' },
      { start: 174.5, end: 177.9, text: 'こういう風に持って' },
      { start: 332.3, end: 334.0, text: '同じことが言えるのではないでしょうか' },
      { start: 334.0, end: 336.0, text: 'ありがとうございました' }, // 終わり近くでも、直前にぴったり続くものは幻覚
      { start: 349.6, end: 351.7, text: '次の動画もお楽しみに' },
      { start: 352.0, end: 354.0, text: 'ありがとうございました' },
    ]);
    expect(dropped.map((s) => s.start)).toEqual([172.0, 334.0, 352.0]);
    expect(kept.map((s) => s.start)).toEqual([170.2, 174.5, 332.3, 349.6]);
  });

  it('「チャンネル登録をお願いいたします」は捨てる（言い回しの違いも決まり文句に数える）', () => {
    // 実例（1 章 GD I-4、2026-10-02）: 音声の最後の区間で、直前の区間の終わりと同じ時刻に始まる
    const { kept, dropped } = dropWindowArtifacts([
      { start: 782.92, end: 784.8, text: '個人的にデッサンをやってみることも' },
      { start: 784.8, end: 786.8, text: 'お勧めしたいというふうに思います' },
      { start: 786.8, end: 788.58, text: 'チャンネル登録をお願いいたします。' },
    ]);
    expect(dropped.map((s) => s.text)).toEqual(['チャンネル登録をお願いいたします。']);
    expect(kept).toHaveLength(2);
    // 間を空けて出たものも捨てる
    const spaced = dropWindowArtifacts([
      { start: 784.8, end: 786.8, text: 'お勧めしたいというふうに思います' },
      { start: 787.5, end: 789.3, text: 'チャンネル登録よろしくお願いします' },
    ]);
    expect(spaced.dropped).toHaveLength(1);
  });
});

describe('isStockPhraseOnly', () => {
  it('中身のある言葉が付いた区間は決まり文句だけとみなさない（「含む」では捨てない）', () => {
    expect(isStockPhraseOnly('質問ありがとうございます')).toBe(false);
    expect(isStockPhraseOnly('チャンネル登録者数が10万人を超えました')).toBe(false);
    expect(isStockPhraseOnly('本日はここまでです。ご視聴ありがとうございました。')).toBe(false);
    expect(isStockPhraseOnly('皆さんお疲れ様でした')).toBe(false);
    expect(isStockPhraseOnly('ご視聴ありがとうございました。ご視聴ありがとうございました。')).toBe(true);
    expect(isStockPhraseOnly('おやすみなさい')).toBe(true);
  });
});
