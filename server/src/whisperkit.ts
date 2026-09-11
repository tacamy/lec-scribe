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

/** 決まり文句の照合用に、空白と句読点を落とす */
function normalizePhrase(text: string): string {
  return text.replace(/[\s。、.,!！?？]/g, '');
}

/**
 * Whisper が無音や区切りの悪い窓で出す決まり文句（学習データの動画の締めの言葉）。
 * 本物の発話でも言い得るので、これだけでは落とさず、窓いっぱい（15 秒以上）の区間のときだけ落とす。
 * 長い順に並べるのは、前方一致で短いほうに先に食われないようにするため
 */
/**
 * 日常的にも言う言い回し。幻覚として落とすには「遅すぎる」か「直前に密着している」という形の証拠が要る
 * （話の途中というだけでは落とさない。講師が実際にお礼を言う場面があるため）
 */
const EVERYDAY_PHRASES = ['ありがとうございました', 'ありがとうございます'];

function isEverydayPhrase(text: string): boolean {
  return EVERYDAY_PHRASES.includes(normalizePhrase(text));
}

const KNOWN_HALLUCINATIONS = ['ご視聴ありがとうございました', 'ご視聴ありがとうございます', 'ありがとうございました', 'チャンネル登録お願いします', 'チャンネル登録をお願いします', '最後までご視聴ありがとうございました', 'おやすみなさい']
  .map(normalizePhrase)
  .sort((a, b) => b.length - a.length);

/**
 * 本文が決まり文句だけでできているか。Whisper は同じ文を何度も繰り返して出すことがあるので、
 * 「ご視聴ありがとうございました。ご視聴ありがとうございました。」のような繰り返しも 1 つとみなす
 */
function isStockPhraseOnly(text: string): boolean {
  let rest = normalizePhrase(text);
  if (!rest) return false;
  while (rest.length > 0) {
    let matched = '';
    for (const phrase of KNOWN_HALLUCINATIONS) {
      if (rest.startsWith(phrase)) {
        matched = phrase;
        break;
      }
    }
    if (!matched) return false;
    rest = rest.slice(matched.length);
  }
  return true;
}

/**
 * 決まり文句だけの区間が「長すぎる」か。日本語の話し言葉は 1 文字あたり 0.15〜0.2 秒なので、
 * 0.35 秒/文字を超えるなら実際には言っていない（無音の窓に埋められた）とみなす。
 * 「ご視聴ありがとうございました」（14 文字）なら 4.9 秒以上が対象
 */
function isTooSlow(s: Segment): boolean {
  const chars = normalizePhrase(s.text).length;
  const seconds = s.end - s.start;
  return chars > 0 && seconds >= Math.max(PHRASE_MIN_SEC, chars * PHRASE_MAX_SEC_PER_CHAR);
}

/** 音声の終わりからこの秒数の中にある決まり文句は、本当に言っている締めの言葉かもしれないので残す */
const CLOSING_WINDOW_SEC = 60;
/** 直前の区間の終わりからこの秒数以内に始まる = 同じ窓の末尾に付け足された */
const GLUED_SEC = 0.02;

/** これより短ければ、本当に言っている可能性があるので残す */
const PHRASE_MIN_SEC = 3;
const PHRASE_MAX_SEC_PER_CHAR = 0.35;

/** 30 秒の窓いっぱいの区間とみなす長さ */
const WINDOW_ARTIFACT_SEC = 20;
/** 他の区間と重なる合計がこれ以上なら「窓の重複」= 実在しない区間 */
const OVERLAP_ARTIFACT_SEC = 5;

/** 捨てた区間。なぜ捨てたかをログに残せるように reason を付ける */
export type DroppedSegment = Segment & { reason: 'phrase' | 'overlap' };

/**
 * WhisperKit の VAD 分割で、30 秒の窓いっぱいに広がる区間が本物の区間と重なって出ることがある
 * （実例: 59.6〜89.6 秒の「ご視聴ありがとうございました」が 61〜86 秒の発話と重なる）。
 * 1 本の音声で区間が重なることはないので、長い区間が他の区間と大きく重なっていれば捨てる。
 * 決まり文句だけの長い区間も捨てる。
 *
 * 重なりは「まだ残っている区間」とだけ数え、長い区間から順に見る。単純に全区間と比べると、
 * 幻覚の窓に巻き込まれた本物の長い区間まで一緒に消えてしまうため（幻覚の窓のほうが長い）
 */
export function dropWindowArtifacts(segments: readonly Segment[]): { kept: Segment[]; dropped: DroppedSegment[] } {
  const dropped: DroppedSegment[] = [];
  const duration = (s: Segment) => s.end - s.start;

  // 決まり文句だけの区間は、(a) しゃべる速さから考えて長すぎる、または (b) 話の途中に出てくる
  // （締めの言葉は最後にしか言わない）なら捨てる。実例: 5 章で「ありがとうございました」が
  // 2.0 秒ちょうどの区間として話の途中に 3 回入っていた（直前の区間の終わりと同じ時刻に始まる）
  const talkEnd = segments.reduce((m, s) => Math.max(m, s.end), 0);
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const survivors = segments.filter((s) => {
    if (!isStockPhraseOnly(s.text)) return true;
    const midTalk = talkEnd - s.end > CLOSING_WINDOW_SEC;
    // 直前の区間の終わりにぴったり続く決まり文句は、窓の末尾に付け足された幻覚（本物の発話は VAD の区切りで少し間が空く）
    const prev = sorted[sorted.indexOf(s) - 1];
    const glued = prev !== undefined && Math.abs(s.start - prev.end) < GLUED_SEC;
    // 「ありがとうございました」のように本当に言うことがある短い言い回しは、話の途中というだけでは落とさない
    // （遅すぎる・直前に密着している、という幻覚らしい形のときだけ）。「ご視聴ありがとうございました」等は途中でも落とす
    const everyday = isEverydayPhrase(s.text);
    if (!isTooSlow(s) && !glued && (everyday || !midTalk)) return true;
    dropped.push({ ...s, reason: 'phrase' });
    return false;
  });

  const alive = new Set(survivors);
  for (const s of [...survivors].sort((a, b) => duration(b) - duration(a))) {
    if (duration(s) < WINDOW_ARTIFACT_SEC) break; // 長い順なので、ここから先は対象外
    let overlap = 0;
    for (const o of alive) {
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
