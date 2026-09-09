/**
 * 録音時刻 ⇄ 動画時刻のタイムライン（SPEC §10）。
 *
 * 文字起こしの時刻は「録音開始からの秒」、スクショの時刻は video.currentTime。
 * 一時停止・シーク・再生速度の変更があると両者はずれるので、再生イベントを
 * 記録しておき、統合時に区分線形で変換する。
 */
export type TimelineState = 'playing' | 'paused' | 'waiting' | 'ended';

export type TimelineEventType =
  | 'start'
  | 'play'
  | 'pause'
  | 'seeked'
  | 'ratechange'
  | 'waiting'
  | 'playing'
  | 'ended'
  | 'tick'
  | 'stop';

export type TimelineEvent = {
  /** 録音開始からの秒 */
  t: number;
  /** video.currentTime */
  videoTime: number;
  /** video.playbackRate */
  rate: number;
  state: TimelineState;
  type: TimelineEventType;
};

/**
 * 録音時刻 t に対応する動画時刻。t 以下で最後のイベントを基準に、
 * 再生中ならその後の経過 × 再生速度を足す。イベントがなければ t をそのまま返す。
 */
export function toVideoTime(events: readonly TimelineEvent[], t: number): number {
  let base: TimelineEvent | undefined;
  for (const e of events) {
    if (e.t <= t) base = e;
    else break;
  }
  if (!base) {
    const first = events[0];
    // 最初のイベントより前: 開始時点の動画時刻から逆算する
    return first ? Math.max(0, first.videoTime - (first.t - t) * first.rate) : t;
  }
  return base.state === 'playing' ? base.videoTime + (t - base.t) * base.rate : base.videoTime;
}

/**
 * 直前と実質同じイベントか。Brightcove は 1 回のシークで同じ位置の `seeked` を
 * 数回発火するので、位置・状態・速度・種類が同じで 2 秒以内なら記録しない。
 */
export function isDuplicateEvent(prev: TimelineEvent | undefined, next: TimelineEvent): boolean {
  if (!prev) return false;
  return (
    prev.type === next.type &&
    prev.state === next.state &&
    prev.rate === next.rate &&
    Math.abs(prev.videoTime - next.videoTime) < 0.005 &&
    next.t - prev.t < 2
  );
}

/** 動画の再生状態を <video> の属性から決める */
export function videoState(video: {
  paused: boolean;
  ended: boolean;
  readyState: number;
}): TimelineState {
  if (video.ended) return 'ended';
  if (video.paused) return 'paused';
  return video.readyState > 2 ? 'playing' : 'waiting';
}
