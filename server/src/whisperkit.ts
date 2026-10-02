import { hasSpeechText, isFillerOnly, type Segment } from './format.ts';

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

/** 決まり文句の照合用に、空白と句読点を落とす */
function normalizePhrase(text: string): string {
  return text.replace(/[\s。、.,!！?？]/g, '');
}

/**
 * Whisper が無音・音楽・区切りの悪い窓で出す決まり文句（学習データの動画の締めの言葉）。言い回しの違いもまとめて当てる
 * （「ご視聴いただきありがとうございました」「チャンネル登録をよろしくお願いいたします」など）
 */
const STOCK_PHRASES =
  /(?:最後まで)?ご視聴(?:いただき|頂き)?(?:まして)?(?:誠に|本当に)?ありがとうございま(?:した|す)|(?:高評価(?:と|や)?)?チャンネル登録(?:と高評価)?を?(?:よろしく)?お願い(?:いた)?します|ありがとうございま(?:した|す)|おやすみなさい/g;
/** 決まり文句の前後に付いても、区間に中身があることにはならない言葉（「それではご視聴ありがとうございました」） */
const STOCK_FILLERS = /^(?:それでは|では|はい|皆さん|みなさん|えー|あの)*$/;

/**
 * 本文が決まり文句（と「それでは」「はい」程度）だけでできているか。Whisper は同じ文を何度も繰り返して出すことがあるので、
 * 「ご視聴ありがとうございました。ご視聴ありがとうございました。」のような繰り返しも決まり文句だけとみなす。
 * 「含む」ではなく「それだけ」で見る: 本物の発話と同じ区間に付いて出たとき（「本日はここまでです。ご視聴…。次回は…」）に、
 * 本物ごと捨てないため
 */
export function isStockPhraseOnly(text: string): boolean {
  const normalized = normalizePhrase(text);
  const rest = normalized.replace(STOCK_PHRASES, '');
  return rest !== normalized && STOCK_FILLERS.test(rest);
}

/** 30 秒の窓いっぱいの区間とみなす長さ */
const WINDOW_ARTIFACT_SEC = 20;
/** 他の区間と重なる合計がこれ以上なら「窓の重複」= 実在しない区間 */
const OVERLAP_ARTIFACT_SEC = 5;

/** 捨てた区間。なぜ捨てたかをログに残せるように reason を付ける */
export type DroppedSegment = Segment & { reason: 'phrase' | 'overlap' | 'symbol' | 'filler' };

/**
 * WhisperKit の VAD 分割で、30 秒の窓いっぱいに広がる区間が本物の区間と重なって出ることがある
 * （実例: 59.6〜89.6 秒の「ご視聴ありがとうございました」が 61〜86 秒の発話と重なる）。
 * 1 本の音声で区間が重なることはないので、長い区間が他の区間と大きく重なっていれば捨てる。
 * 決まり文句だけの区間も捨てる。
 *
 * 重なりは「まだ残っている区間」とだけ数え、長い区間から順に見る。単純に全区間と比べると、
 * 幻覚の窓に巻き込まれた本物の長い区間まで一緒に消えてしまうため（幻覚の窓のほうが長い）
 */
export function dropWindowArtifacts(segments: readonly Segment[]): { kept: Segment[]; dropped: DroppedSegment[] } {
  const dropped: DroppedSegment[] = [];
  const duration = (s: Segment) => s.end - s.start;

  // 文字（文字・数字）を 1 つも含まない区間と、言いよどみの音だけの区間は発話ではない（動画の最後の音楽が「♪」や「ん」と
  // 書き起こされる等。2026-10-01、2026-10-02）。残すと「発話があるのに整えると空」になり、notes.md に
  // 「（整えられなかったため文字起こしのまま）」と ♪ や「んんん」だけが載る。
  // 出力からは外すが、時間帯としては実在する音（音楽の帯）なので、下の「重なり」の判定には証拠として残す。
  // 発話が 1 つもない録音（音楽だけの動画など）は、全部を失敗にしないため何も捨てずそのまま返す
  const speech: Segment[] = [];
  const symbols: Segment[] = [];
  for (const s of segments) (hasSpeechText(s.text) ? speech : symbols).push(s);
  if (speech.length === 0) return { kept: [...segments], dropped: [] };
  for (const s of symbols) dropped.push({ ...s, reason: isFillerOnly(s.text) ? 'filler' : 'symbol' });

  // 決まり文句だけの区間は、いつでも捨てる（2026-10-02）。以前は「話の途中・直前の区間に密着・しゃべる速さから考えて長すぎる」の
  // どれかのときだけ捨て、最後に間を空けて言ったものは本物の締めかもしれないので残していた。50 セッションで残っていた 3 区間
  // （GD I-3 8 章・14 章の最後の「ありがとうございました。」と、7 章の途中の宣伝映像の音楽の上の 25 秒の
  // 「それではご視聴ありがとうございました」）を録音の音量で確かめると、2 つはほぼ無音（-70 dB 前後。直前の発話は -37 dB）、
  // 1 つは音楽だけで、どれも幻覚だった。本物の締めの言葉を捨てても、ノートの中身は何も失われない
  const survivors = speech.filter((s) => {
    if (!isStockPhraseOnly(s.text)) return true;
    dropped.push({ ...s, reason: 'phrase' });
    return false;
  });

  const alive = new Set(survivors);
  for (const s of [...survivors].sort((a, b) => duration(b) - duration(a))) {
    if (duration(s) < WINDOW_ARTIFACT_SEC) break; // 長い順なので、ここから先は対象外
    let overlap = 0;
    // 記号区間（音楽の帯）も重なりの証拠に数える。幻覚の窓が音楽としか重なっていない場合に取りこぼさない（2026-10-01 のレビュー）
    for (const o of [...alive, ...symbols]) {
      if (o === s) continue;
      overlap += Math.max(0, Math.min(s.end, o.end) - Math.max(s.start, o.start));
    }
    if (overlap < OVERLAP_ARTIFACT_SEC) continue;
    alive.delete(s);
    dropped.push({ ...s, reason: 'overlap' });
  }

  return { kept: survivors.filter((s) => alive.has(s)), dropped: dropped.sort((a, b) => a.start - b.start) };
}

function numberOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}
