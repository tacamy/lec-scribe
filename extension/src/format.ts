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
