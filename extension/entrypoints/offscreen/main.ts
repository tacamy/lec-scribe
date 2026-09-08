import type { Config } from '../../src/config';
import { LecError, toErrorInfo } from '../../src/errors';
import {
  hasTarget,
  replyWith,
  sendToBackground,
  type CaptureStartResult,
  type CaptureStats,
  type ToOffscreen,
} from '../../src/messages';

/**
 * Offscreen document: the only extension context with a DOM, so it owns the
 * MediaStream. Phase 1: acquire the tab audio and play it back through the
 * default output device so the user keeps hearing the lecture.
 */
type Capture = {
  sessionId: string;
  stream: MediaStream;
  startedEpochMs: number;
  passthrough: boolean;
  context: AudioContext;
  analyser: AnalyserNode;
  levelBuffer: Float32Array<ArrayBuffer>;
};

let capture: Capture | null = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!hasTarget(msg, 'offscreen')) return false;
  return replyWith(handleMessage)(msg, sender, sendResponse);
});

async function handleMessage(msg: ToOffscreen): Promise<object | void> {
  switch (msg.type) {
    case 'CAPTURE_START':
      return startCapture(msg.sessionId, msg.streamId, msg.config);
    case 'CAPTURE_STOP':
      return stopCapture();
    case 'GET_STATS':
      return getStats();
  }
}

async function startCapture(sessionId: string, streamId: string, config: Config): Promise<CaptureStartResult> {
  if (capture) throw new LecError('BUSY', 'すでにキャプチャ中です。');

  // Non-standard constraints understood by Chrome for tab capture; the
  // stream id comes from chrome.tabCapture.getMediaStreamId in the worker.
  const constraints = {
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    video: false,
  } as unknown as MediaStreamConstraints;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    throw new LecError('CAPTURE_FAILED', `タブ音声を取得できません: ${toErrorInfo(e).message}`);
  }
  const startedEpochMs = Date.now();

  const [track] = stream.getAudioTracks();
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new LecError('CAPTURE_FAILED', '取得したストリームに音声トラックがありません。');
  }

  // Capturing a tab silences it locally; route the audio back to the default
  // output device (SPEC D-02). The analyser only feeds the popup level meter.
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  if (config.audio.passthrough) source.connect(context.destination);
  await context.resume();

  track.addEventListener('ended', () => {
    void onTrackEnded('track ended');
  });

  capture = {
    sessionId,
    stream,
    startedEpochMs,
    passthrough: config.audio.passthrough,
    context,
    analyser,
    levelBuffer: new Float32Array(analyser.fftSize),
  };

  const settings = track.getSettings();
  return {
    recorderStartEpochMs: startedEpochMs,
    sampleRate: settings.sampleRate ?? context.sampleRate,
    channelCount: settings.channelCount ?? 0,
  };
}

async function stopCapture(): Promise<void> {
  const current = capture;
  capture = null;
  if (!current) return;
  current.stream.getTracks().forEach((t) => t.stop());
  await current.context.close().catch(() => undefined);
}

async function onTrackEnded(reason: string): Promise<void> {
  if (!capture) return;
  await stopCapture();
  try {
    await sendToBackground.captureEnded(reason);
  } catch {
    // The worker will reconcile on its next wake-up.
  }
}

function getStats(): CaptureStats {
  if (!capture) return { capturing: false, audioLevel: 0, passthrough: false, elapsedMs: 0 };
  capture.analyser.getFloatTimeDomainData(capture.levelBuffer);
  let sum = 0;
  for (const v of capture.levelBuffer) sum += v * v;
  const rms = Math.sqrt(sum / capture.levelBuffer.length);
  return {
    capturing: true,
    audioLevel: Math.min(1, rms),
    passthrough: capture.passthrough,
    elapsedMs: Date.now() - capture.startedEpochMs,
  };
}
