import type { Segment } from './format.ts';

/**
 * whisperkit-cli の呼び出しと report JSON の正規化（SPEC §13.1）。
 * CLI のフラグや report の形は Phase 7 の実機確認で合わせる（Q-11）。
 */
export function whisperkitArgs(options: {
  audioPath: string;
  model: string;
  language: string;
  reportDir: string;
}): string[] {
  return [
    'transcribe',
    '--audio-path',
    options.audioPath,
    '--model',
    options.model,
    '--language',
    options.language,
    '--chunking-strategy',
    'vad',
    '--skip-special-tokens',
    '--report',
    '--report-path',
    options.reportDir,
  ];
}

/**
 * report JSON を {start, end, text} の配列にする。
 * 受け付ける形: { segments: [...] }、[{ segments }]（複数結果）、segments の配列そのもの。
 * 各 segment は start/end（秒）と text を持つ。特殊トークン <|...|> は取り除く。
 */
export function normalizeReport(raw: unknown): Segment[] {
  const collected: unknown[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      if (value.every((v) => v && typeof v === 'object' && 'text' in v && ('start' in v || 'startTime' in v))) {
        collected.push(...value);
      } else {
        for (const v of value) visit(v);
      }
      return;
    }
    if (value && typeof value === 'object' && 'segments' in value) visit((value as { segments: unknown }).segments);
  };
  visit(raw);

  const segments: Segment[] = [];
  for (const item of collected) {
    const s = item as Record<string, unknown>;
    const start = numberOf(s['start'] ?? s['startTime']);
    const end = numberOf(s['end'] ?? s['endTime']);
    const text = String(s['text'] ?? '')
      .replace(/<\|[^|>]*\|>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (start === null || end === null || !text) continue;
    segments.push({ start, end: Math.max(end, start), text });
  }
  return segments.sort((a, b) => a.start - b.start);
}

function numberOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
