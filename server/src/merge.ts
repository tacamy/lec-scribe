import type { Outline } from './llm.ts';
import { formatTimestamp, hasSpeechText, type Segment } from './format.ts';
import { SLIDE_FILE } from './layout.ts';

/**
 * スライドと文字起こしの統合（SPEC §13.4, D-14）。
 * 各区間は「その区間の開始時点で表示されていたスライド」に属する。
 */
export type MergedSegment = Segment & {
  /** 動画時刻（timeline.json で変換済み） */
  videoStart: number;
  videoEnd: number;
  /** 属するスライドのファイル名。スライド前の区間は undefined */
  slide?: string;
};

export type SlideEntry = {
  filename: string;
  seq?: number;
  videoTime: number;
  reason?: string;
  width?: number;
  height?: number;
  /** 拡張が保存を決めたときの数値。stillFraction が半分未満なら映像中心の画面 */
  trigger?: { diffPrev?: number; diffSaved?: number; cells?: number; stillFraction?: number };
};

/**
 * 自動検知で保存したスライドは切り替えの 1〜2 秒後に確定するので、
 * その分だけ早く表示が始まったとみなす（初回・手動保存はそのまま）。
 */
export const CHANGE_LEAD_SEC = 1.5;

export function slideStart(slide: SlideEntry, leadSec = CHANGE_LEAD_SEC): number {
  return slide.reason === 'change' ? Math.max(0, slide.videoTime - leadSec) : slide.videoTime;
}

/**
 * 区間の終わりが文末らしいか（SPEC §13.4）。
 * WhisperKit の区間は文の途中で切れることが多く、句点も付かないことがあるので、
 * 句点のほかに「です・ます・ました・でしょう」などの述語の終わりも文末とみなす。
 * 「〜が」「〜て」「〜、」で終わる区間は次の区間と同じ文とみなす
 */
const SENTENCE_END = /(?:[。．！？!?]|(?:です|ます|ません|でした|ました|ましょう|でしょう|ください|である|だ|ない|た)(?:ね|よ|よね|か)?)[」』）)]*$/;
/** 区間の間がこれ以上空いていれば、句点がなくても文が切れたとみなす（秒） */
export const SENTENCE_GAP_SEC = 2;

export function endsSentence(text: string): boolean {
  const t = text.trim();
  return t === '' || SENTENCE_END.test(t);
}

/** 区間を文ごとにまとめた index の範囲 [from, to) の並び。本文がなければ区間ごと */
export function sentenceUnits<T extends { videoStart: number; videoEnd?: number; text?: string }>(segments: readonly T[]): Array<[number, number]> {
  const units: Array<[number, number]> = [];
  let from = 0;
  for (let i = 1; i <= segments.length; i++) {
    const prev = segments[i - 1]!;
    const next = segments[i];
    const gap = next && prev.videoEnd !== undefined ? next.videoStart - prev.videoEnd : 0;
    if (!next || endsSentence(prev.text ?? '') || gap >= SENTENCE_GAP_SEC) {
      units.push([from, i]);
      from = i;
    }
  }
  return units;
}

/** 丁寧形の文末のあとに続いて、文が終わっていないことを示す語（「〜ますので」「〜ですから」「〜ですかというと」など） */
const CONTINUES_AFTER_POLITE = /^\s*(?:が|けど|けれど|ので|のに|から|し|と|って|よう|[、,])/;
const POLITE_END = /(?:です|ます|ません|でした|ました|ましょう|でしょう|ください)/g;
/**
 * 言いよどみの「ですね」（「今度は**ですね**、この…」「さらに**ですね**」）。助詞や「に・と」で終わる副詞の直後の「ですね」は
 * 文の終わりではない（2026-10-02。ここで切ると、文の途中で画像が挟まった）
 */
const FILLER_DESUNE = /[はがをにでもとへやの]$/;
const PUNCT_END = /[。．！？!?][」』）)]*/g;

/**
 * 区間の本文の途中にある文の終わり（その直後で切ってよい文字位置）。区間の末尾は sentenceUnits が見るので含めない。
 * 句点のほか、丁寧形の文末（です・ます・ました…）に「か」「ね」「よ」などが付いた形で、そのあとに
 * 「が・ので・から・と」などが続かない位置。「だ・た・ない」で終わる普通体は文の途中にもよく現れる
 * （「ただ」「ないと」）ので、区間の途中では見ない
 */
export function innerSentenceEnds(text: string): number[] {
  const cuts = new Set<number>();
  for (const m of text.matchAll(PUNCT_END)) cuts.add(m.index + m[0].length);
  for (const m of text.matchAll(POLITE_END)) {
    let at = m.index + m[0].length;
    if (CONTINUES_AFTER_POLITE.test(text.slice(at))) continue; // 「ですから」「ますので」
    if (m[0] === 'です' && text.startsWith('ね', at) && FILLER_DESUNE.test(text.slice(0, m.index))) continue; // 「今度はですね」
    at += /^か?(?:よね|ね|よ)?/.exec(text.slice(at))![0].length; // 「ですかね」「ましょうか」「ですよね」
    if (CONTINUES_AFTER_POLITE.test(text.slice(at))) continue; // 「ですかというと」
    at += /^[。．！？!?]?[」』）)]*/.exec(text.slice(at))![0].length;
    cuts.add(at);
  }
  return [...cuts].filter((at) => at > 0 && text.slice(at).trim() !== '').sort((a, b) => a - b);
}

/** 区間の一部（本文の [from, to) の文字）を、文字数の比で見積もった時刻で切り出す */
function slicePart<T extends { videoStart: number; videoEnd?: number; text?: string }>(segment: T, from: number, to: number): T {
  const text = segment.text ?? '';
  const ratio = (at: number) => (text.length === 0 ? 0 : at / text.length);
  const lerp = (a: number, b: number, r: number) => a + (b - a) * r;
  const end = segment.videoEnd ?? segment.videoStart;
  const part = { ...segment, text: text.slice(from, to).trim(), videoStart: lerp(segment.videoStart, end, ratio(from)) } as T & {
    start?: number;
    end?: number;
  };
  if (segment.videoEnd !== undefined) part.videoEnd = lerp(segment.videoStart, end, ratio(to));
  // 録音の時刻（start / end）があれば同じ比で切る
  const rec = segment as unknown as { start?: number; end?: number };
  if (typeof rec.start === 'number' && typeof rec.end === 'number') {
    part.start = lerp(rec.start, rec.end, ratio(from));
    part.end = lerp(rec.start, rec.end, ratio(to));
  }
  return part;
}

/**
 * 画像の境目をまたぐ文を、区間の途中の文の切れ目で分けるときに、分けた前後それぞれに要る長さ（秒）。
 * 短い部分は時刻の見積もり（文字数の比・切り替えの検知の遅れ）の誤差で反対側に倒れやすい。
 * 実例: スライドが変わった直後に言う「続いてCです」（約 1 秒）が前のスライドの節に移った。
 * 1 章 GD I-4 の腕の実演は、前（前の話題の締め）が約 11 秒、後ろ（腕の話）が約 21 秒（2026-10-02）
 */
export const SPLIT_MIN_SEC = 5;

/**
 * 次の話題の前置き（「次に」「続いて」「もう一つ」「それでは」など）で始まる文は、画像が切り替わる直前に言うことが多い。
 * 時刻の上では前の画像の間でも、次の画像の側に付ける（実例: 「もう一つものの見方としてお話ししたいことは輪郭ですね」が
 * 輪郭の画像の 1 秒前に終わり、前の話題の末尾に移った。2026-10-02）
 */
const NEXT_TOPIC_CUE = /^\s*(?:次に|次は|続いて|続きまして|もう一つ|もうひとつ|それでは|では|さて|ここからは|最後に)/;

/**
 * 各区間に表示中のスライドを割り当てる。
 * 1 つの文（sentenceUnits）は同じスライドに付ける。文の途中でスライドが変わっていたら、
 * その文の間に長く映っていた方のスライドに文ごと付ける（画像が文の途中に挟まらないように）。
 *
 * ただし、区間の末尾だけで文の切れ目を見ると、WhisperKit が「…覚えておいてほしいと思っています次に」のように
 * 前の話題の締めと次の話題の書き出しを 1 区間にまとめたとき、前の話題の締めが次の話題の文とつながり、
 * 次の画像の後ろに送られる（1 章 GD I-4 の腕の実演。2026-10-02）。そこで、画像の境目をまたぐ文だけは
 * 区間の本文の途中の文の切れ目（innerSentenceEnds）でも分け直し、分けた部分ごとに同じ規則で割り当てる。
 * 分けた部分がどれも SPLIT_MIN_SEC 以上あるときだけ採る（短い部分は時刻の誤差で倒れやすい）。
 * 区間の途中で分けた位置の時刻は文字数の比で見積もる。そのため、返す配列は入力より長くなることがある
 */
export function assignSlides<T extends { videoStart: number; videoEnd?: number; text?: string }>(
  segments: readonly T[],
  slides: readonly SlideEntry[],
  leadSec = CHANGE_LEAD_SEC,
): Array<T & { slide?: string }> {
  const ordered = [...slides].sort((a, b) => slideStart(a, leadSec) - slideStart(b, leadSec));
  const starts = ordered.map((s) => slideStart(s, leadSec));
  const shownAt = (t: number): SlideEntry | undefined => {
    let current: SlideEntry | undefined;
    for (let i = 0; i < ordered.length; i++) {
      if (starts[i]! <= t) current = ordered[i];
      else break;
    }
    return current;
  };
  /** [unitStart, unitEnd] の間にいちばん長く映っていたスライド（同じ長さなら先のもの） */
  const longestShown = (unitStart: number, unitEnd: number): SlideEntry | undefined => {
    let best = shownAt(unitStart);
    let bestCover = -1;
    let current = best;
    let at = unitStart;
    for (let i = 0; i < ordered.length; i++) {
      const start = starts[i]!;
      if (start <= unitStart) continue;
      if (start >= unitEnd) break;
      if (start - at > bestCover) {
        bestCover = start - at;
        best = current;
      }
      at = start;
      current = ordered[i];
    }
    if (unitEnd - at > bestCover) best = current;
    return best;
  };
  const spanOf = <S extends { videoStart: number; videoEnd?: number }>(list: readonly S[]) => {
    const first = list[0]!;
    const last = list[list.length - 1]!;
    return [first.videoStart, Math.max(first.videoStart, last.videoEnd ?? last.videoStart)] as const;
  };
  const crossesBoundary = (from: number, to: number) => starts.some((s) => s > from && s < to);

  const out: Array<T & { slide?: string }> = [];
  const withSlide = <S extends T>(part: S, slide: SlideEntry | undefined): S & { slide?: string } => (slide ? { ...part, slide: slide.filename } : { ...part });
  for (const [from, to] of sentenceUnits(segments)) {
    const unit = segments.slice(from, to);
    const [unitStart, unitEnd] = spanOf(unit);
    const whole = longestShown(unitStart, unitEnd);
    // 画像の境目をまたぐ文だけ、区間の途中の文の切れ目で分け直してみる
    if (crossesBoundary(unitStart, unitEnd)) {
      const pieces: Array<{ index: number; from: number; to: number; part: T }> = [];
      unit.forEach((segment, i) => {
        const text = segment.text ?? '';
        const cuts = [0, ...innerSentenceEnds(text), text.length];
        for (let c = 0; c + 1 < cuts.length; c++) {
          pieces.push({ index: i, from: cuts[c]!, to: cuts[c + 1]!, part: cuts.length === 2 ? segment : slicePart(segment, cuts[c]!, cuts[c + 1]!) });
        }
      });
      // 分けた文ごとにスライドを決め、同じスライドが続く部分にまとめる
      const owner: Array<SlideEntry | undefined> = Array.from({ length: pieces.length }, () => undefined);
      const parts = pieces.map((p) => p.part);
      for (const [a, b] of sentenceUnits(parts)) {
        const [s, e] = spanOf(parts.slice(a, b));
        const slide = longestShown(s, e);
        for (let k = a; k < b; k++) owner[k] = slide;
      }
      const runsOf = () => {
        const runs: Array<[number, number]> = [];
        for (let k = 0; k < pieces.length; k++) {
          const last = runs[runs.length - 1];
          if (last && owner[last[0]] === owner[k]) last[1] = k + 1;
          else runs.push([k, k + 1]);
        }
        return runs;
      };
      // 次の話題の前置きで始まる部分は、次の画像の側に付け直す（後ろから見て、続けて付け直せるように）
      const initial = runsOf();
      for (let r = initial.length - 2; r >= 0; r--) {
        const [a, b] = initial[r]!;
        if (!NEXT_TOPIC_CUE.test(parts[a]!.text ?? '')) continue;
        const next = owner[initial[r + 1]![0]];
        for (let k = a; k < b; k++) owner[k] = next;
      }
      const runs = runsOf();
      const longEnough = runs.every(([a, b]) => {
        const [s, e] = spanOf(parts.slice(a, b));
        return e - s >= SPLIT_MIN_SEC;
      });
      if (runs.length > 1 && longEnough) {
        // 同じ区間の部分が同じスライドに付いたら、もとの 1 区間に戻す
        for (let k = 0; k < pieces.length; ) {
          const { index } = pieces[k]!;
          let j = k;
          while (j < pieces.length && pieces[j]!.index === index && owner[j] === owner[k]) j++;
          const segment = unit[index]!;
          const isWhole = pieces[k]!.from === 0 && pieces[j - 1]!.to === (segment.text ?? '').length;
          out.push(withSlide(isWhole ? segment : slicePart(segment, pieces[k]!.from, pieces[j - 1]!.to), owner[k]));
          k = j;
        }
        continue;
      }
    }
    for (const segment of unit) out.push(withSlide(segment, whole));
  }
  return out;
}

/** slides.json の中身か。ファイル名はパスにして読むので、拡張が付ける形（slide_001.png）以外があれば受け付けない */
export function isSlideList(value: unknown): value is SlideEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof (s as SlideEntry).filename === 'string' &&
        SLIDE_FILE.test((s as SlideEntry).filename) &&
        typeof (s as SlideEntry).videoTime === 'number',
    )
  );
}

/** 区間の本文をつなぎ、句点で改行した段落にする */
export function toParagraph(texts: readonly string[]): string {
  const joined = texts.map((t) => t.trim()).filter(Boolean).join('');
  return joined
    .replace(/。/g, '。\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

export function clock(seconds: number): string {
  return formatTimestamp(seconds).slice(0, 8);
}

/** lecture.md / notes.md の 1 節。冒頭（スライドなし）は slide が undefined */
export type Section = {
  id: string;
  heading: string;
  slide?: SlideEntry;
  texts: string[];
};

/** 区間をスライドごとに束ねる。冒頭の発話は id "intro" */
export function groupSections(
  segments: readonly MergedSegment[],
  slides: readonly SlideEntry[],
  leadSec = CHANGE_LEAD_SEC,
): Section[] {
  const ordered = [...slides].sort((a, b) => slideStart(a, leadSec) - slideStart(b, leadSec));
  const assigned = assignSlides(segments, ordered, leadSec);
  const sections: Section[] = [];
  const before = assigned.filter((s) => !s.slide);
  if (before.length > 0) {
    sections.push({ id: 'intro', heading: `${clock(before[0]!.videoStart)} 冒頭（スライドなし）`, texts: before.map((s) => s.text) });
  }
  for (const slide of ordered) {
    const name = slide.filename.replace(/\.[a-z0-9]+$/i, '');
    sections.push({
      id: name,
      heading: `${clock(slideStart(slide, leadSec))} ${name}`,
      slide,
      texts: assigned.filter((s) => s.slide === slide.filename).map((s) => s.text),
    });
  }
  return sections;
}

function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function buildLectureMarkdown(input: {
  title?: string;
  url?: string;
  startedAt?: string;
  segments: readonly MergedSegment[];
  slides: readonly SlideEntry[];
  leadSec?: number;
  /** 画像の相対パスの前置き。作業フォルダに置くときは "../slides/" */
  imagePrefix?: string;
  /** 見出し下に添える注記 */
  note?: string;
}): string {
  const leadSec = input.leadSec ?? CHANGE_LEAD_SEC;
  const imagePrefix = input.imagePrefix ?? 'slides/';
  const sections = groupSections(input.segments, input.slides, leadSec);

  const lines: string[] = [`# ${input.title?.trim() || 'ノート'}`, ''];
  const recorded = formatDate(input.startedAt);
  if (recorded) lines.push(`- 収録: ${recorded}`);
  if (input.url) lines.push(`- 元ページ: ${input.url}`);
  lines.push(`- スライド: ${input.slides.length} 枚 / 文字起こし: ${input.segments.length} 区間`);
  if (input.note) lines.push(`- ${input.note}`);
  lines.push('');

  // 節の見出しも区切り線も付けない。スライド画像そのものが区切りになる
  for (const section of sections) {
    if (section.slide) lines.push(`![${section.id}](${imagePrefix}${section.slide.filename})`, '');
    // 発話がなければ画像だけを置く（「発話はありません」の注記は出さない。画面が細かく変わる動画で邪魔になるため）
    if (section.texts.length > 0) lines.push(toParagraph(section.texts), '');
  }
  if (sections.length === 0) lines.push('（文字起こしがありません）', '');
  return lines.join('\n');
}

/**
 * notes.md: 冒頭に動画全体の要点、本文は LLM が決めた話題ごとに見出しと要点を付けて、
 * その中にスライド画像と整えた本文を順に並べる（SPEC §13.5）。
 * outline がなければ見出しなしで画像と本文だけ。整えられなかった節は文字起こしのまま載せる。
 */
export function buildNotesMarkdown(input: {
  title?: string;
  startedAt?: string;
  url?: string;
  sections: readonly Section[];
  polished: ReadonlyMap<string, { text: string }>;
  outline?: Outline;
}): string {
  const lines: string[] = [`# ${input.title?.trim() || 'ノート'}`, ''];
  const recorded = formatDate(input.startedAt);
  if (recorded) lines.push(`- 収録: ${recorded}`);
  if (input.url) lines.push(`- 元ページ: ${input.url}`);
  lines.push('');

  const overview = input.outline?.overview ?? [];
  if (overview.length > 0) lines.push('## 全体の要点', '', ...overview.map((s) => `- ${s}`), '');

  // 話題の開始 id → 話題。最初の話題は先頭の節から始まる
  const topicAt = new Map((input.outline?.topics ?? []).map((t) => [t.startId, t]));
  for (const section of input.sections) {
    const topic = topicAt.get(section.id);
    if (topic) {
      lines.push(`## ${topic.heading}`, '');
      if (topic.summary.length > 0) lines.push('**要点**', '', ...topic.summary.map((s) => `- ${s}`), '');
    }
    if (section.slide) lines.push(`![${section.id}](slides/${section.slide.filename})`, '');
    // 発話のない節は画像だけ。整えた本文が空でも元の発話が残っているなら、文字起こしのまま載せて失わない。
    // 記号だけの文（「♪」等。この対策より前に作った transcript に残っていることがある）は発話ではないので除き、
    // 発話が 1 つもなければ注意書きも本文も出さない（2026-10-01）
    const polished = input.polished.get(section.id)?.text;
    const spoken = section.texts.filter((t) => hasSpeechText(t));
    if (polished) {
      lines.push(polished, '');
    } else if (spoken.length > 0) {
      lines.push('（整えられなかったため文字起こしのまま）', '', toParagraph(spoken), '');
    }
  }
  return lines.join('\n');
}
