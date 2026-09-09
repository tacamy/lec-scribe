import { describe, expect, it } from 'vitest';
import { chooseCandidate, type ProbeResult, type ProbeVideo } from './probe';

function video(overrides: Partial<ProbeVideo>): ProbeVideo {
  return {
    index: 0,
    selector: 'video',
    player: 'html5',
    src: '',
    videoWidth: 0,
    videoHeight: 0,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    currentTime: 0,
    duration: null,
    paused: true,
    ended: false,
    playbackRate: 1,
    readyState: 0,
    playing: false,
    taintFree: null,
    drm: false,
    ...overrides,
  };
}

function frame(frameId: number, videos: ProbeVideo[]): { frameId: number; result: ProbeResult } {
  return { frameId, result: { frameUrl: `https://example.test/${frameId}`, visibility: 'visible', videos, crossOriginIframes: [] } };
}

describe('chooseCandidate', () => {
  it('returns undefined when no frame has a video', () => {
    expect(chooseCandidate([frame(0, []), { frameId: 1, result: undefined }])).toBeUndefined();
  });

  it('prefers a video with data over a larger one that has not loaded', () => {
    const loaded = video({ index: 1, readyState: 4, rect: { x: 0, y: 0, width: 320, height: 180 } });
    const empty = video({ index: 0, readyState: 0, rect: { x: 0, y: 0, width: 1920, height: 1080 } });
    expect(chooseCandidate([frame(0, [empty, loaded])])?.index).toBe(1);
  });

  it('prefers the playing video, then the largest one', () => {
    const small = video({ index: 0, readyState: 4, playing: true, rect: { x: 0, y: 0, width: 320, height: 180 } });
    const large = video({ index: 1, readyState: 4, playing: false, rect: { x: 0, y: 0, width: 1280, height: 720 } });
    const larger = video({ index: 2, readyState: 4, playing: false, rect: { x: 0, y: 0, width: 1920, height: 1080 } });
    expect(chooseCandidate([frame(0, [large, small, larger])])?.index).toBe(0);
    expect(chooseCandidate([frame(0, [large, larger])])?.index).toBe(2);
  });

  it('carries the frame id and url of the chosen video', () => {
    const chosen = chooseCandidate([frame(0, []), frame(7, [video({ readyState: 4 })])]);
    expect(chosen?.frameId).toBe(7);
    expect(chosen?.frameUrl).toBe('https://example.test/7');
  });

  it('uses the intrinsic size when the element is not laid out (hidden tab)', () => {
    const hidden = video({ index: 0, readyState: 4, videoWidth: 1280, videoHeight: 720 });
    const tiny = video({ index: 1, readyState: 4, rect: { x: 0, y: 0, width: 100, height: 100 } });
    expect(chooseCandidate([frame(0, [tiny, hidden])])?.index).toBe(0);
  });
});
