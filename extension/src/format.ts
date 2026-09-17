/** 0 → "00:00:00", 3_723_000 → "01:02:03". Negative values clamp to zero. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** 1536 → "1.5 KB". Uses 1024-based units with one decimal above KB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(value)} ${units[i]}` : `${value.toFixed(1)} ${units[i]}`;
}

/** Session ids sort chronologically and stay filesystem-safe: YYYYMMDD-HHmmss-xxxx. */
export function makeSessionId(date: Date = new Date(), random: () => number = Math.random): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  return `${stamp}-${suffix}`;
}

/** "20260908-103005-ab12" → "2026-09-08 10:30:05". Unknown shapes are returned unchanged. */
export function formatSessionId(sessionId: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(sessionId);
  if (!m) return sessionId;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/**
 * 検知スクリプトの報告が途切れたときに、進み続けないための上限。
 * 定期報告は 5 秒ごと（detector.ts の HEARTBEAT_MS）なので、それより少し長く
 */
export const VIDEO_TIME_EXTRAPOLATE_MAX_MS = 6_000;

/**
 * いま表示する再生位置（秒）。検知スクリプトの報告は 5 秒ごと（と再生・停止・シークなどのイベント時）
 * なので、そのまま出すと 5 秒に 1 回しか進まない。再生中なら、報告からの経過に再生速度を掛けて足す。
 * 停止・バッファリング・シークはイベントで即報告されるので、ずれは次の報告で直る。
 * 報告が止まっても上限までしか進めない。時計が戻っていたら（経過が負）足さない
 */
export function videoTimeNow(
  video: { currentTime: number; playing: boolean; playbackRate: number; updatedAt: number },
  now: number = Date.now(),
): number {
  if (!video.playing) return video.currentTime;
  const sinceReport = Math.min(Math.max(0, now - video.updatedAt), VIDEO_TIME_EXTRAPOLATE_MAX_MS);
  return video.currentTime + (sinceReport / 1000) * video.playbackRate;
}
