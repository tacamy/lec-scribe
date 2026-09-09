import { describe, expect, it } from 'vitest';
import { formatBytes, formatElapsed, formatSessionId, makeSessionId } from './format';

describe('formatElapsed', () => {
  it('formats hours, minutes and seconds with zero padding', () => {
    expect(formatElapsed(0)).toBe('00:00:00');
    expect(formatElapsed(999)).toBe('00:00:00');
    expect(formatElapsed(61_000)).toBe('00:01:01');
    expect(formatElapsed(3_723_000)).toBe('01:02:03');
  });

  it('clamps negative values', () => {
    expect(formatElapsed(-5000)).toBe('00:00:00');
  });
});

describe('formatBytes', () => {
  it('uses 1024-based units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(85 * 1024 * 1024)).toBe('85.0 MB');
  });

  it('handles invalid input', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('makeSessionId', () => {
  it('encodes the local date and time plus a 4-char suffix', () => {
    const id = makeSessionId(new Date(2026, 8, 8, 10, 30, 5), () => 0);
    expect(id).toBe('20260908-103005-aaaa');
  });

  it('only contains filesystem-safe characters', () => {
    expect(makeSessionId()).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
  });
});

describe('formatSessionId', () => {
  it('renders the timestamp part as a date and time', () => {
    expect(formatSessionId('20260908-103005-ab12')).toBe('2026-09-08 10:30:05');
  });

  it('leaves unknown ids alone', () => {
    expect(formatSessionId('smoke-1')).toBe('smoke-1');
  });
});
