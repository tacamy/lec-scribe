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

/**
 * Whisper が無音や区切りの悪い窓で出す決まり文句（学習データの動画の締めの言葉）。
 * 本物の発話でも言い得るので、これだけでは落とさず、窓いっぱい（15 秒以上）の区間のときだけ落とす
 */
const KNOWN_HALLUCINATIONS = new Set(
  ['ご視聴ありがとうございました', 'ご視聴ありがとうございます', 'チャンネル登録お願いします', 'チャンネル登録をお願いします', '最後までご視聴ありがとうございました', 'おやすみなさい'].map(
    (s) => s.replace(/[\s。、.,!！?？]/g, ''),
  ),
);

/** 30 秒の窓いっぱいの区間とみなす長さ */
const WINDOW_ARTIFACT_SEC = 20;
/** 他の区間と重なる合計がこれ以上なら「窓の重複」= 実在しない区間 */
const OVERLAP_ARTIFACT_SEC = 5;

/**
 * WhisperKit の VAD 分割で、30 秒の窓いっぱいに広がる区間が本物の区間と重なって出ることがある
 * （実例: 59.6〜89.6 秒の「ご視聴ありがとうございました」が 61〜86 秒の発話と重なる）。
 * 1 本の音声で区間が重なることはないので、長い区間が他の区間と大きく重なっていれば捨てる。
 * 決まり文句だけの長い区間も捨てる。
 */
export function dropWindowArtifacts(segments: readonly Segment[]): { kept: Segment[]; dropped: Segment[] } {
  const kept: Segment[] = [];
  const dropped: Segment[] = [];
  for (const s of segments) {
    const duration = s.end - s.start;
    let reason: string | null = null;
    if (duration >= 15 && KNOWN_HALLUCINATIONS.has(s.text.replace(/[\s。、.,!！?？]/g, ''))) {
      reason = 'phrase';
    } else if (duration >= WINDOW_ARTIFACT_SEC) {
      let overlap = 0;
      for (const o of segments) {
        if (o === s) continue;
        overlap += Math.max(0, Math.min(s.end, o.end) - Math.max(s.start, o.start));
      }
      if (overlap >= OVERLAP_ARTIFACT_SEC) reason = 'overlap';
    }
    (reason ? dropped : kept).push(s);
  }
  return { kept, dropped };
}

function numberOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
