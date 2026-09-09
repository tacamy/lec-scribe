import type { Outline } from './llm.ts';
import { formatTimestamp, type Segment } from './format.ts';

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
};

/**
 * 自動検知で保存したスライドは切り替えの 1〜2 秒後に確定するので、
 * その分だけ早く表示が始まったとみなす（初回・手動保存はそのまま）。
 */
export const CHANGE_LEAD_SEC = 1.5;

export function slideStart(slide: SlideEntry, leadSec = CHANGE_LEAD_SEC): number {
  return slide.reason === 'change' ? Math.max(0, slide.videoTime - leadSec) : slide.videoTime;
}

/** 各区間に、開始時点で表示中のスライド（videoTime <= videoStart の最後）を割り当てる */
export function assignSlides<T extends { videoStart: number }>(
  segments: readonly T[],
  slides: readonly SlideEntry[],
  leadSec = CHANGE_LEAD_SEC,
): Array<T & { slide?: string }> {
  const ordered = [...slides].sort((a, b) => slideStart(a, leadSec) - slideStart(b, leadSec));
  return segments.map((segment) => {
    let current: SlideEntry | undefined;
    for (const slide of ordered) {
      if (slideStart(slide, leadSec) <= segment.videoStart) current = slide;
      else break;
    }
    return current ? { ...segment, slide: current.filename } : { ...segment };
  });
}

export function isSlideList(value: unknown): value is SlideEntry[] {
  return (
    Array.isArray(value) &&
    value.every((s) => s && typeof s === 'object' && typeof (s as SlideEntry).filename === 'string' && typeof (s as SlideEntry).videoTime === 'number')
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

  // 節の見出し（時刻 + ファイル名）は付けない。スライド画像そのものが区切りになる
  for (const [i, section] of sections.entries()) {
    if (i > 0) lines.push('---', '');
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
  let first = true;
  for (const section of input.sections) {
    const topic = topicAt.get(section.id);
    if (topic) {
      lines.push(`## ${topic.heading}`, '');
      if (topic.summary.length > 0) lines.push('**要点**', '', ...topic.summary.map((s) => `- ${s}`), '');
    } else if (!first) {
      lines.push('---', '');
    }
    first = false;
    if (section.slide) lines.push(`![${section.id}](slides/${section.slide.filename})`, '');
    // 発話のない節は画像だけ。整えた本文が空でも元の発話が残っているなら、文字起こしのまま載せて失わない
    const polished = input.polished.get(section.id)?.text;
    if (polished) {
      lines.push(polished, '');
    } else if (section.texts.length > 0) {
      lines.push('（整えられなかったため文字起こしのまま）', '', toParagraph(section.texts), '');
    }
  }
  return lines.join('\n');
}
