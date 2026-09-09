import { describe, expect, it } from 'vitest';
import { normalizeReport, whisperkitArgs } from './whisperkit.ts';

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
