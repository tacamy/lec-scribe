/**
 * 録音時刻 → 動画時刻の変換（SPEC §10.2）。拡張側 extension/src/timeline.ts と同じ規則。
 * 文字起こしの時刻（録音開始からの秒）を動画の再生位置に直すために使う。
 */
export type TimelineEvent = {
  t: number;
  videoTime: number;
  rate: number;
  state: 'playing' | 'paused' | 'waiting' | 'ended';
  type: string;
};

export function toVideoTime(events: readonly TimelineEvent[], t: number): number {
  let base: TimelineEvent | undefined;
  for (const e of events) {
    if (e.t <= t) base = e;
    else break;
  }
  if (!base) {
    const first = events[0];
    return first ? Math.max(0, first.videoTime - (first.t - t) * first.rate) : t;
  }
  return base.state === 'playing' ? base.videoTime + (t - base.t) * base.rate : base.videoTime;
}

/** timeline.json の中身として妥当か（壊れていたら使わない） */
export function isTimeline(value: unknown): value is TimelineEvent[] {
  return (
    Array.isArray(value) &&
    value.every(
      (e) =>
        e &&
        typeof e === 'object' &&
        typeof (e as TimelineEvent).t === 'number' &&
        typeof (e as TimelineEvent).videoTime === 'number' &&
        typeof (e as TimelineEvent).rate === 'number' &&
        typeof (e as TimelineEvent).state === 'string',
    )
  );
}
