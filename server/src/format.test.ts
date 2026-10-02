import { describe, expect, it } from 'vitest';
import { formatClock, formatTimestamp, hasSpeechText, isFillerOnly, slugify, toSrt, toTxt, toVtt } from './format.ts';

const segments = [
  { start: 0, end: 8.5, text: '今日はデザインについて説明します。' },
  { start: 3599.25, end: 3661.999, text: '二つ目' },
];

describe('formatTimestamp', () => {
  it('rounds to the millisecond first so second boundaries carry over', () => {
    expect(formatTimestamp(59.9996)).toBe('00:01:00,000');
    expect(formatTimestamp(0.9999)).toBe('00:00:01,000');
    expect(formatTimestamp(3599.9995, '.')).toBe('01:00:00.000');
  });
  it('formats SRT and VTT timestamps', () => {
    expect(formatTimestamp(0)).toBe('00:00:00,000');
    expect(formatTimestamp(8.5)).toBe('00:00:08,500');
    expect(formatTimestamp(3661.999, '.')).toBe('01:01:01.999');
    expect(formatTimestamp(-3)).toBe('00:00:00,000');
    expect(formatClock(3599.25)).toBe('[00:59:59]');
  });
});

describe('subtitle writers', () => {
  it('writes SRT with 1-based indexes and blank lines between cues', () => {
    expect(toSrt(segments)).toBe(
      '1\n00:00:00,000 --> 00:00:08,500\n今日はデザインについて説明します。\n\n2\n00:59:59,250 --> 01:01:01,999\n二つ目\n',
    );
  });

  it('writes VTT with a header', () => {
    expect(toVtt(segments).startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:08.500\n')).toBe(true);
  });

  it('writes TXT with a clock prefix per line', () => {
    expect(toTxt(segments)).toBe('[00:00:00] 今日はデザインについて説明します。\n[00:59:59] 二つ目\n');
    expect(toTxt([])).toBe('');
  });
});

describe('slugify', () => {
  it('keeps Japanese, replaces separators and trims', () => {
    expect(slugify('LMS サンプル講座 - 12章｜グラフィックデザイン')).toBe('LMS_サンプル講座_12章｜グラフィックデザイン');
    expect(slugify('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(slugify(undefined)).toBe('');
    expect(slugify('x'.repeat(100)).length).toBe(60);
  });
});

describe('isFillerOnly / hasSpeechText', () => {
  it('言いよどみ・相づちの音だけの文は発話とみなさない', () => {
    for (const t of ['ん', 'んん', 'うん', 'ううん', 'えー', 'あー', 'んー', 'あ', 'え。', ' ん ']) {
      expect(isFillerOnly(t)).toBe(true);
      expect(hasSpeechText(t)).toBe(false);
    }
  });

  it('語になりうる仮名の組や、中身のある文は発話', () => {
    for (const t of ['おお', 'うえ', 'あお', 'うんと大きい', 'えーと、まず', 'はい', '線を引きます']) {
      expect(isFillerOnly(t)).toBe(false);
      expect(hasSpeechText(t)).toBe(true);
    }
    expect(hasSpeechText('♪')).toBe(false);
  });
});
