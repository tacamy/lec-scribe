import { describe, expect, it } from 'vitest';
import { isDuplicateEvent, toVideoTime, videoState, type TimelineEvent } from './timeline';

const ev = (t: number, videoTime: number, state: TimelineEvent['state'], type: TimelineEvent['type'], rate = 1): TimelineEvent => ({
  t,
  videoTime,
  rate,
  state,
  type,
});

describe('toVideoTime', () => {
  it('follows playback linearly from the last event', () => {
    const events = [ev(0, 12, 'playing', 'start')];
    expect(toVideoTime(events, 0)).toBe(12);
    expect(toVideoTime(events, 30)).toBe(42);
  });

  it('holds the video time while paused and resumes after play', () => {
    const events = [ev(0, 0, 'playing', 'start'), ev(100, 100, 'paused', 'pause'), ev(160, 100, 'playing', 'play')];
    expect(toVideoTime(events, 130)).toBe(100);
    expect(toVideoTime(events, 170)).toBe(110);
  });

  it('jumps on seek', () => {
    const events = [ev(0, 0, 'playing', 'start'), ev(50, 600, 'playing', 'seeked')];
    expect(toVideoTime(events, 49)).toBe(49);
    expect(toVideoTime(events, 60)).toBe(610);
  });

  it('applies the playback rate', () => {
    const events = [ev(0, 0, 'playing', 'start'), ev(10, 10, 'playing', 'ratechange', 1.5)];
    expect(toVideoTime(events, 20)).toBe(25);
  });

  it('does not advance while buffering', () => {
    const events = [ev(0, 0, 'playing', 'start'), ev(10, 10, 'waiting', 'waiting'), ev(14, 10, 'playing', 'playing')];
    expect(toVideoTime(events, 12)).toBe(10);
    expect(toVideoTime(events, 16)).toBe(12);
  });

  it('extrapolates backwards before the first event and falls back to t without events', () => {
    expect(toVideoTime([ev(5, 20, 'playing', 'start')], 2)).toBe(17);
    expect(toVideoTime([ev(5, 1, 'playing', 'start')], 0)).toBe(0);
    expect(toVideoTime([], 42)).toBe(42);
  });
});

describe('isDuplicateEvent', () => {
  it('drops repeated seeked events at the same position', () => {
    const a = ev(35.065, 33.857648, 'paused', 'seeked');
    expect(isDuplicateEvent(a, ev(35.374, 33.857648, 'paused', 'seeked'))).toBe(true);
    expect(isDuplicateEvent(a, ev(35.4, 32.603661, 'paused', 'seeked'))).toBe(false);
  });

  it('keeps events that differ in type, rate or time', () => {
    const play = ev(54.696, 18.812635, 'playing', 'play');
    expect(isDuplicateEvent(play, ev(54.696, 18.813255, 'playing', 'playing'))).toBe(false);
    expect(isDuplicateEvent(ev(10, 10, 'playing', 'tick'), ev(20, 20, 'playing', 'tick'))).toBe(false);
    expect(isDuplicateEvent(ev(10, 10, 'paused', 'pause'), ev(13, 10, 'paused', 'pause'))).toBe(false);
    expect(isDuplicateEvent(undefined, play)).toBe(false);
  });
});

describe('videoState', () => {
  it('maps element flags to a state', () => {
    expect(videoState({ paused: false, ended: false, readyState: 4 })).toBe('playing');
    expect(videoState({ paused: false, ended: false, readyState: 2 })).toBe('waiting');
    expect(videoState({ paused: true, ended: false, readyState: 4 })).toBe('paused');
    expect(videoState({ paused: true, ended: true, readyState: 4 })).toBe('ended');
  });
});
