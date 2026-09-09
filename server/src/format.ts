/** 文字起こしの 1 区間。時刻は秒 */
export type Segment = {
  start: number;
  end: number;
  text: string;
};

/** 00:00:00,000（SRT）/ 00:00:00.000（VTT） */
export function formatTimestamp(seconds: number, separator: ',' | '.' = ','): string {
  // 先にミリ秒に丸める（秒とミリ秒を別々に丸めると 59.9996 が 00:00:59,000 になる）
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}

/** [HH:MM:SS] */
export function formatClock(seconds: number): string {
  return `[${formatTimestamp(seconds).slice(0, 8)}]`;
}

export function toSrt(segments: readonly Segment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${formatTimestamp(s.start, ',')} --> ${formatTimestamp(s.end, ',')}\n${s.text}\n`)
    .join('\n');
}

export function toVtt(segments: readonly Segment[]): string {
  const body = segments.map((s) => `${formatTimestamp(s.start, '.')} --> ${formatTimestamp(s.end, '.')}\n${s.text}\n`).join('\n');
  return `WEBVTT\n\n${body}`;
}

export function toTxt(segments: readonly Segment[]): string {
  return segments.map((s) => `${formatClock(s.start)} ${s.text}`).join('\n') + (segments.length ? '\n' : '');
}

/** ファイル名に使えるようタイトルを整える（日本語はそのまま） */
export function slugify(title: string | undefined, maxLength = 60): string {
  if (!title) return '';
  // 空白・ハイフン類・パスに使えない記号をまとめて "_" にする
  const cleaned = title.replace(/[\s\-–—/\\:*?"<>|]+/g, '_').replace(/^_+|_+$/g, '');
  return Array.from(cleaned).slice(0, maxLength).join('');
}
