import { describe, expect, it } from 'vitest';
import { formatBytes, formatElapsed, formatSessionId, makeSessionId, videoTimeNow } from './format';
import { DETECT_STATUS_HEARTBEAT_MS } from './probe';

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

describe('videoTimeNow（報告の間を補った再生位置）', () => {
  const at = 1_000_000;
  const playing = { currentTime: 100, duration: 3_600, playing: true, playbackRate: 1, updatedAt: at };
  it('再生中は報告からの経過を足す。再生速度も掛ける', () => {
    expect(videoTimeNow(playing, at)).toBe(100);
    expect(videoTimeNow(playing, at + 1_500)).toBe(101.5);
    expect(videoTimeNow({ ...playing, playbackRate: 1.5 }, at + 2_000)).toBe(103);
  });
  it('止まっていれば報告の値のまま', () => {
    expect(videoTimeNow({ ...playing, playing: false }, at + 3_000)).toBe(100);
  });
  it('次の定期報告が少し遅れても止まらない', () => {
    const late = DETECT_STATUS_HEARTBEAT_MS + 500;
    expect(videoTimeNow(playing, at + late)).toBe(100 + late / 1000);
  });
  it('報告が途切れても 6 秒ぶんの経過までしか足さない（足す秒数は再生速度に比例）', () => {
    expect(videoTimeNow(playing, at + 60_000)).toBe(106);
    expect(videoTimeNow({ ...playing, playbackRate: 2 }, at + 60_000)).toBe(112);
  });
  it('動画の長さは超えない。長さが分からなければ抑えない', () => {
    expect(videoTimeNow({ ...playing, currentTime: 3_598 }, at + 5_000)).toBe(3_600);
    expect(videoTimeNow({ ...playing, currentTime: 3_598, duration: null }, at + 5_000)).toBe(3_603);
  });
  it('時計が戻っていたら足さない', () => {
    expect(videoTimeNow(playing, at - 5_000)).toBe(100);
  });
});
