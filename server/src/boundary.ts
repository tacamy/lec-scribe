/**
 * 話題の境目を画像で判定する（SPEC §13.5、2026-10-15）。
 *
 * 話題の区切りは文字起こしだけで決めるので、画面が切り替わってから話し始めるデモでは、境目の画像が
 * どちらの話題のものかは画像を見ないと決められない。節の先頭から始まる話題ごとに、前の話題の最後の画面・
 * 話が途切れている間の画面・新しい話題の最初の発話の画面を縮小して LLM に見せ、「前の話題に残す画像の枚数」
 * だけを答えさせる。画像は境目のぶんだけ（1 本で 10〜30 枚）。結果は boundary-cache.json に残し、
 * 話題と節の並びが同じなら呼び直さない。失敗したら時間の規則（merge.ts）のまま
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasSpeechText } from './format.ts';
import { workPath } from './layout.ts';
import { createBackend, extractJson, withModelFallback, type JsonSchema, type Outline } from './llm.ts';
import { isSilentSection, topicStartIndex, walkBackOverSilent, type Section } from './merge.ts';
import { shrinkImages } from './picker.ts';

export type Topic = Outline['topics'][number];

export type Boundary = {
  /** topics の添字（先頭の話題には境目がないので 1 以上） */
  topic: number;
  heading: string;
  /** 前の話題の最後の画面（直前の節。無音の節で止まったときはその画面）と、前の話題の最後の発話の末尾 */
  before: { id: string; filename?: string; tail: string };
  /** 話が途切れている間に撮れた画面（本文の無い節）。前の話題と新しい話題の間 */
  silent: Array<{ id: string; filename: string }>;
  /** 新しい話題の最初の発話のある節。その画像と本文の冒頭 */
  after: { id: string; filename?: string; head: string };
};

/** 判定の結果。新しい話題を startId の節から始め、startAfterImage ならその節の画像は前の話題に残す */
export type Placement = { topic: number; startId: string; startAfterImage?: boolean };

/** プロンプトや答えの意味を変えたら上げる（キャッシュの鍵に入れ、古い判定を使い回さない） */
export const BOUNDARY_RULES = 1;
/** LLM に見せる本文の長さ（境目の前後） */
const EXCERPT = 120;
/** 1 回の呼び出しに付ける画像の上限。超えたら境目を分けて呼ぶ */
export const BOUNDARY_MAX_IMAGES = 40;

const sectionText = (section: Section, polished: ReadonlyMap<string, { text: string }>): string =>
  polished.get(section.id)?.text || section.texts.filter((t) => hasSpeechText(t)).join('');

/**
 * 判定が要る境目を集める。先頭の話題、判定済みの話題（placed）、最初の文（startText）が本文の先頭に無い話題
 * （途中で見つかる: 本文で決まっている。見つからない: 本文でも分からず、節の先頭に置いたまま）は除く。
 * 前後に発話のある節が無い境目も除く（判断の材料がない）。
 * 境目の画像は、直前に続く発話のない節の画像（ほかの話題が始まる節は越えない。merge.ts と同じ遡り方）と、
 * 新しい話題の最初の発話の節の画像。前の話題の最後の画面は参考に見せる
 */
export function findBoundaries(sections: readonly Section[], polished: ReadonlyMap<string, { text: string }>, topics: readonly Topic[]): Boundary[] {
  const out: Boundary[] = [];
  const starts = new Set(topics.map((t) => t.startId));
  const midText = (t: Topic): boolean => {
    const text = polished.get(t.startId)?.text;
    return !!t.startText && !!text && topicStartIndex(text, t.startText) > 0;
  };
  for (let i = 1; i < topics.length; i++) {
    const t = topics[i]!;
    if (t.placed) continue;
    if (t.startText) {
      const text = polished.get(t.startId)?.text;
      if (!text || topicStartIndex(text, t.startText) !== 0) continue;
    }
    const idx = sections.findIndex((s) => s.id === t.startId);
    if (idx < 0) continue;
    // 新しい話題の最初の発話の節: startId から前へ（startId 自体が無音なら、その次の発話のある節）。
    // 次の話題が始まる節までで、次の話題が同じ節の途中から始まるなら、その節までを含める
    let limit = sections.length;
    const next = topics[i + 1];
    if (next) {
      const ni = sections.findIndex((s) => s.id === next.startId);
      if (ni >= 0) limit = midText(next) ? ni + 1 : ni;
    }
    let a = idx;
    while (a < limit && isSilentSection(sections[a]!, polished)) a++;
    if (a >= limit) continue;
    // 直前に続く発話のない節（ほかの話題が始まる節は越えない）
    const first = walkBackOverSilent(sections, idx, polished, starts);
    const bi = first - 1;
    if (bi < 0) continue;
    // 前の話題の最後の発話（直前の節が無音で止まったときは、さらに手前の発話のある節）
    let ti = bi;
    while (ti >= 0 && isSilentSection(sections[ti]!, polished)) ti--;
    if (ti < 0) continue;
    const before = sections[bi]!;
    const after = sections[a]!;
    const silent = sections.slice(first, a).flatMap((s) => (s.slide ? [{ id: s.id, filename: s.slide.filename }] : []));
    if (!after.slide && silent.length === 0) continue;
    out.push({
      topic: i,
      heading: t.heading,
      before: { id: before.id, ...(before.slide ? { filename: before.slide.filename } : {}), tail: sectionText(sections[ti]!, polished).slice(-EXCERPT) },
      silent,
      after: { id: after.id, ...(after.slide ? { filename: after.slide.filename } : {}), head: sectionText(after, polished).slice(0, EXCERPT) },
    });
  }
  return out;
}

/** 境目に付ける画像（前の画面・途切れている間の画面・新しい話題の最初の画面）の順。同じ画像は 1 度だけ */
export function boundaryImages(boundaries: readonly Boundary[]): string[] {
  const files: string[] = [];
  for (const b of boundaries) {
    for (const f of [b.before.filename, ...b.silent.map((s) => s.filename), b.after.filename]) if (f && !files.includes(f)) files.push(f);
  }
  return files;
}

/** その境目で「前の話題に残す」と答えられる最大の枚数（途切れている間の画面 ＋ 新しい話題の最初の画面） */
export function keepMax(b: Boundary): number {
  return b.silent.length + (b.after.filename ? 1 : 0);
}

export const BOUNDARY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    boundaries: {
      type: 'array',
      items: {
        type: 'object',
        properties: { boundary: { type: 'number' }, keep: { type: 'number' } },
        required: ['boundary', 'keep'],
        additionalProperties: false,
      },
    },
  },
  required: ['boundaries'],
  additionalProperties: false,
};

/** 画像の番号（添付の順、1 から）を引けるように */
export function imageNumbers(files: readonly string[]): Map<string, number> {
  return new Map(files.map((f, i) => [f, i + 1]));
}

export function buildBoundaryPrompt(boundaries: readonly Boundary[], numbers: ReadonlyMap<string, number>): string {
  const no = (f: string | undefined): string => (f && numbers.has(f) ? `[${numbers.get(f)}]` : '');
  const items = boundaries.map((b, k) => {
    const lines = [`境目 ${k + 1}: 新しい話題「${b.heading}」`];
    if (b.before.filename) lines.push(`  ${no(b.before.filename)} 前の話題の最後の画面（数えない）。前の話題の本文の末尾: 「…${b.before.tail}」`);
    else lines.push(`  前の話題の本文の末尾: 「…${b.before.tail}」`);
    for (const s of b.silent) lines.push(`  ${no(s.filename)} 話が途切れている間の画面`);
    if (b.after.filename) lines.push(`  ${no(b.after.filename)} 新しい話題の最初の発話の画面。本文の冒頭: 「${b.after.head}…」`);
    else lines.push(`  （新しい話題の最初の発話の節に画面はない）本文の冒頭: 「${b.after.head}…」`);
    lines.push(`  keep は 0〜${keepMax(b)}`);
    return lines.join('\n');
  });
  return `あなたはスライド動画の解説をノートにまとめる編集者です。ノートは話題ごとに見出しを付け、その中に画面の画像と本文を順に並べます。話題の区切りは本文から決めてありますが、画面が切り替わってから話し始めることが多いので、境目の画像がどちらの話題のものかは画像を見ないと決められません。添付の画像は番号順で、[n] は n 番目の画像です。

境目ごとに、「話が途切れている間の画面」と「新しい話題の最初の発話の画面」を順に見て、そのうち前の話題に残す枚数を keep に答えてください（先頭から数えます）。
- 新しい話題の画面（新しいアートボード、新しいファイル、新しいスライド、新しい機能の画面）なら、話が途切れている間の画像でも新しい話題のものです。そこから keep を数え終えます
- 前の話題の結果や締めを見せているだけの画像は前の話題のものです
- 新しい話題の最初の発話の画面まで前の話題の結果なら（本文だけが新しい話題）、keep は最大の値にしてください
- 前の話題の最後の画面は参考に見せているだけで、数えません

${items.join('\n\n')}

出力は指定された JSON スキーマに従い、全部の境目について { "boundary": 番号, "keep": 枚数 } を返してください。`;
}

/** 返答を読む。境目の番号と keep が整数で範囲内のものだけ（null や空文字は答えとみなさない） */
export function parseBoundaryResponse(raw: string, boundaries: readonly Boundary[]): Placement[] {
  const parsed = extractJson(raw) as { boundaries?: unknown };
  const placements: Placement[] = [];
  const seen = new Set<number>();
  for (const item of Array.isArray(parsed?.boundaries) ? (parsed.boundaries as Array<Record<string, unknown>>) : []) {
    const k = item['boundary'];
    const keep = item['keep'];
    if (typeof k !== 'number' || !Number.isInteger(k) || typeof keep !== 'number' || !Number.isInteger(keep)) continue;
    const b = boundaries[k - 1];
    if (!b || seen.has(k) || keep < 0 || keep > keepMax(b)) continue;
    seen.add(k);
    placements.push(placementFor(b, keep));
  }
  return placements;
}

/** keep（前の話題に残す枚数）を、話題の始まりの節に写す */
export function placementFor(b: Boundary, keep: number): Placement {
  if (keep < b.silent.length) return { topic: b.topic, startId: b.silent[keep]!.id };
  if (keep === b.silent.length || !b.after.filename) return { topic: b.topic, startId: b.after.id };
  return { topic: b.topic, startId: b.after.id, startAfterImage: true };
}

/** 判定を話題に当てる。動かした話題の startText は捨てる（新しい節の本文の文ではない） */
export function applyPlacement(topics: readonly Topic[], placements: readonly Placement[]): Topic[] {
  const byTopic = new Map(placements.map((p) => [p.topic, p]));
  return topics.map((t, i) => {
    const p = byTopic.get(i);
    if (!p) return t;
    const { startText: _dropped, startAfterImage: _old, ...rest } = t;
    return { ...rest, startId: p.startId, ...(p.startAfterImage ? { startAfterImage: true } : {}), placed: true };
  });
}

export type BoundarySettings = {
  codexBin: string;
  /** 判定に使うモデル（画像の救出と同じ）。'' なら codex の既定 */
  model: string;
  /** モデルが使えないときのやり直し先（整えに実際に使ったモデル） */
  fallbackModel: string;
  signal?: AbortSignal;
};

export type BoundaryResult = { placements: Placement[]; errors: string[]; model: string };

/**
 * 境目を画像の枚数で分け、1 回ずつ LLM に見せる。画像は 1 度だけ縮小して使い回す。
 * 答えの無かった境目は失敗として記録する（キャッシュを使い回さず、次のやり直しで聞き直す）
 */
export async function judgeBoundaries(slidesDir: string, boundaries: readonly Boundary[], settings: BoundarySettings, log: (line: string) => void): Promise<BoundaryResult> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-boundary-'));
  try {
    const files = boundaryImages(boundaries);
    const shrunk = await shrinkImages(slidesDir, files, tmp, settings.signal);
    const pathOf = new Map(files.map((f, i) => [f, shrunk[i]!]));
    // 画像の多い講義は境目を分けて呼ぶ
    const chunks: Boundary[][] = [];
    for (const b of boundaries) {
      const last = chunks[chunks.length - 1];
      if (last && boundaryImages([...last, b]).length <= BOUNDARY_MAX_IMAGES) last.push(b);
      else chunks.push([b]);
    }
    const placements: Placement[] = [];
    const errors: string[] = [];
    let model = settings.model;
    for (const chunk of chunks) {
      if (settings.signal?.aborted) break;
      const chunkFiles = boundaryImages(chunk);
      const numbers = imageNumbers(chunkFiles);
      const prompt = buildBoundaryPrompt(chunk, numbers);
      const images = chunkFiles.map((f) => pathOf.get(f)!);
      const outcome = await withModelFallback(
        { model, fallbackModel: settings.fallbackModel, ...(settings.signal ? { signal: settings.signal } : {}) },
        async (useModel) => {
          const backend = createBackend({ kind: 'codex', model: useModel, codexBin: settings.codexBin, openaiApiKey: '', ollamaUrl: '', charsPerCall: 0, ...(settings.signal ? { signal: settings.signal } : {}) })!;
          log(`${backend.name}: boundary (${chunk.length} boundaries, ${images.length} images)`);
          return parseBoundaryResponse(await backend.complete(prompt, BOUNDARY_SCHEMA, { images }), chunk);
        },
        '話題の境目',
        log,
      );
      model = outcome.model;
      if (outcome.result) placements.push(...outcome.result);
      else errors.push(outcome.error ?? 'no result');
    }
    if (!settings.signal?.aborted) {
      const answered = new Set(placements.map((p) => p.topic));
      const unanswered = boundaries.filter((b) => !answered.has(b.topic));
      if (unanswered.length > 0 && errors.length === 0) errors.push(`答えの無かった境目が ${unanswered.length} か所（${unanswered.map((b) => b.heading).join('、')}）`);
    }
    return { placements, errors, model };
  } catch (error) {
    return { placements: [], errors: [error instanceof Error ? error.message : String(error)], model: settings.model };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export const BOUNDARY_CACHE_FILE = 'boundary-cache.json';
export type BoundaryCache = { key: string; model: string; generatedAt: string; placements: Placement[]; errors?: string[] };

/** 境目（話題と節の並び）・モデル・規則の版から鍵を作る。並びが同じなら前回の判定を使い回す */
export function boundaryCacheKey(boundaries: readonly Boundary[], model: string): string {
  const hash = createHash('sha256');
  hash.update(`rules:${BOUNDARY_RULES}\0${model}\n`);
  for (const b of boundaries) hash.update(`${b.topic}\0${b.heading}\0${b.before.id}\0${b.silent.map((s) => s.id).join(',')}\0${b.after.id}\0${b.after.filename ?? ''}\n`);
  return hash.digest('hex').slice(0, 32);
}

/** キャッシュを読む。形が違えば（途中で切れた、手で書き換えた）無いものとして扱い、判定し直す */
export async function readBoundaryCache(dir: string): Promise<BoundaryCache | null> {
  try {
    const v = JSON.parse(await readFile(workPath(dir, BOUNDARY_CACHE_FILE), 'utf8')) as Partial<BoundaryCache> | null;
    if (!v || typeof v !== 'object' || typeof v.key !== 'string' || typeof v.model !== 'string' || !Array.isArray(v.placements)) return null;
    if (!v.placements.every((p) => p && typeof p === 'object' && typeof p.topic === 'number' && typeof p.startId === 'string')) return null;
    return { key: v.key, model: v.model, generatedAt: typeof v.generatedAt === 'string' ? v.generatedAt : '', placements: v.placements, ...(Array.isArray(v.errors) ? { errors: v.errors.map(String) } : {}) };
  } catch {
    return null;
  }
}

export async function writeBoundaryCache(dir: string, cache: BoundaryCache): Promise<void> {
  await writeFile(workPath(dir, BOUNDARY_CACHE_FILE), JSON.stringify(cache, null, 2));
}

/** 判定を動かし、結果をキャッシュに残す。鍵が同じで失敗の残っていない前回の判定があれば使い回す */
export async function runBoundaries(input: {
  dir: string;
  slidesDir: string;
  boundaries: readonly Boundary[];
  settings: BoundarySettings;
  log: (line: string) => void;
}): Promise<BoundaryResult & { reused: boolean }> {
  const key = boundaryCacheKey(input.boundaries, input.settings.model);
  const cached = await readBoundaryCache(input.dir);
  if (cached && cached.key === key && (cached.errors ?? []).length === 0) return { placements: cached.placements, errors: [], model: cached.model, reused: true };
  const result = await judgeBoundaries(input.slidesDir, input.boundaries, input.settings, input.log);
  if (!input.settings.signal?.aborted) {
    await writeBoundaryCache(input.dir, { key, model: result.model, generatedAt: new Date().toISOString(), placements: result.placements, ...(result.errors.length > 0 ? { errors: result.errors } : {}) }).catch(() => undefined);
  }
  return { ...result, reused: false };
}
