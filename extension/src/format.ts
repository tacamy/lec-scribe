import { DETECT_STATUS_HEARTBEAT_MS } from './probe';

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
 * 検知スクリプトの報告が途切れたときに、進み続けないための上限（報告からの経過時間）。
 * 定期報告の間隔より少し長くして、次の報告が少し遅れても止まって見えないようにする
 */
const VIDEO_TIME_EXTRAPOLATE_MAX_MS = DETECT_STATUS_HEARTBEAT_MS + 1_000;

/**
 * いま表示する再生位置（秒）。検知スクリプトの報告は定期報告（DETECT_STATUS_HEARTBEAT_MS ごと）と再生・停止・シークなどの
 * イベント時だけなので、そのまま出すと数秒に 1 回しか進まない。再生中なら、報告からの経過に再生速度を掛けて足す（SPEC §15.1）。
 * 足すのは報告から上限の時間ぶんまで（足す秒数は上限 × 再生速度で止まる）で、動画の長さは超えない。時計が戻っていたら（経過が負）足さない。
 * 停止・シークの報告も service worker の直列の処理を通るので、送信などが走っている間は届くのが遅れ、
 * その間は実際より先に進んで見えて、届いた時点で戻る
 */
export function videoTimeNow(
  video: { currentTime: number; duration: number | null; playing: boolean; playbackRate: number; updatedAt: number },
  now: number = Date.now(),
): number {
  if (!video.playing) return video.currentTime;
  const sinceReport = Math.min(Math.max(0, now - video.updatedAt), VIDEO_TIME_EXTRAPOLATE_MAX_MS);
  const extrapolated = video.currentTime + (sinceReport / 1000) * video.playbackRate;
  // ended の報告が遅れても動画の長さは超えない。長さが分からない（ライブなど）ときは抑えない
  if (video.duration === null) return extrapolated;
  return Math.min(extrapolated, Math.max(video.currentTime, video.duration));
}

/**
 * サーバーの処理結果から、ノートを整えられなかったかを読む（§13.5）。整えられた・ノート作成が無効なら undefined。
 * 失敗してもサーバーの段階は done（文字起こしは済んでいて、notes.md には文字起こしがそのまま入る）なので、
 * ここで拾わないと利用者は notes.md を開くまで気づけない（Codex の利用上限に当たったときなど）
 */
export function notesProblemOf(result: { notes?: boolean; notesError?: string } | undefined): 'failed' | 'partial' | undefined {
  if (!result) return undefined;
  if (result.notes === false) return 'failed';
  return result.notes === true && result.notesError ? 'partial' : undefined;
}

/** 一覧に出す注意書き */
export function notesProblemText(problem: 'failed' | 'partial'): string {
  return problem === 'failed'
    ? 'ノートを整えられませんでした。時間をおいて「やり直す」を押してください'
    : 'ノートの一部を整えられませんでした。時間をおいて「やり直す」を押してください';
}
