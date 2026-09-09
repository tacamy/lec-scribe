import { describe, expect, it } from 'vitest';
import { dropWindowArtifacts, normalizeReport, whisperkitArgs } from './whisperkit.ts';

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
    expect(dropped.map((s) => s.start)).toEqual([59.6, 75.8]);
    // 重なりのない長い区間と、短い決まり文句（本当に言った締めの言葉）は残す
    expect(kept.map((s) => s.start)).toEqual([55.6, 61.3, 68.3, 77.4, 300, 400]);
  });

  it('drops a long stock phrase even without overlap', () => {
    const { kept, dropped } = dropWindowArtifacts([
      { start: 0, end: 4, text: 'こんにちは' },
      { start: 10, end: 40, text: 'ご視聴ありがとうございました。' },
    ]);
    expect(dropped).toHaveLength(1);
    expect(kept).toHaveLength(1);
  });
});
