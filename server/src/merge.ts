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

function clock(seconds: number): string {
  return formatTimestamp(seconds).slice(0, 8);
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
}): string {
  const leadSec = input.leadSec ?? CHANGE_LEAD_SEC;
  const slides = [...input.slides].sort((a, b) => slideStart(a, leadSec) - slideStart(b, leadSec));
  const segments = assignSlides(input.segments, slides, leadSec);

  const lines: string[] = [`# ${input.title?.trim() || '講義ノート'}`, ''];
  const recorded = formatDate(input.startedAt);
  if (recorded) lines.push(`- 収録: ${recorded}`);
  if (input.url) lines.push(`- 元ページ: ${input.url}`);
  lines.push(`- スライド: ${slides.length} 枚 / 文字起こし: ${segments.length} 区間（時刻は動画の再生位置）`);
  lines.push('');

  const before = segments.filter((s) => !s.slide);
  if (before.length > 0) {
    lines.push(`## ${clock(before[0]!.videoStart)} 冒頭（スライドなし）`, '', toParagraph(before.map((s) => s.text)), '');
  }
  for (const slide of slides) {
    const own = segments.filter((s) => s.slide === slide.filename);
    const name = slide.filename.replace(/\.[a-z0-9]+$/i, '');
    lines.push(`## ${clock(slideStart(slide, leadSec))} ${name}`, '', `![${name}](slides/${slide.filename})`, '');
    lines.push(own.length > 0 ? toParagraph(own.map((s) => s.text)) : '（このスライドの間の発話はありません）', '');
  }
  if (slides.length === 0 && before.length === 0) lines.push('（文字起こしがありません）', '');
  return lines.join('\n');
}
