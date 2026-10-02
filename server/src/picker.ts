import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.ts';
import { workPath } from './layout.ts';
import { codexArgs, isModelUnavailable, readCodexDefaults } from './llm.ts';
import { slideStart, type SlideEntry } from './merge.ts';
import type { SceneDecision } from './scenes.ts';

/**
 * 映像・板書の節で、場面まとめ（§13.4b）が外した画像から「本文の助けになる瞬間」を救い出す（SPEC §13.4c）。
 *
 * 場面まとめは見た目の近さでしか判断できないので、腕の実演やホワイトボードに描いている途中の状態のような
 * 「動きこそが内容」の画像を、同じ場面として 1 枚に畳んでしまう（1 章 GD I-4 の腕の実演で確認）。
 * そこで、スライドではない画面（stillFraction < 0.976）の外された画像を文字起こしと一緒に LLM に見せ、
 * 本文に対応する動作が写っているものだけをノートに足す。足すだけで、規則が載せた画像は動かさない。
 *
 * モデルは gpt-5.6-luna を既定にする（2026-10-02 の実測: terra・astra と選択の質は同等の別解で、
 * 5 時間枠の消費はほぼゼロ。astra は同じ入力で約 7%、terra は約 3% 消費した）。
 * luna は近い画像を重ねて選びがちなので、機械的な歯止め（間隔と上限）をサーバー側でかける。
 */

/** これ以上なら「スライドの画面」とみなして救出の対象にしない（§13.4b の手の帯と同じ線） */
export const PICK_STILL_SLIDE = 0.976;
/** 外された画像同士がこれ以上離れていたら別の節（別の呼び出し）にする（秒） */
export const PICK_REGION_GAP_SEC = 90;
/** 節の前後に文脈として足す幅（秒） */
export const PICK_REGION_PAD_SEC = 20;
/** 文字起こしを段落にまとめる間隔（秒） */
export const PICK_CHUNK_GAP_SEC = 28;
/**
 * 採用する画像は、載っている画像・ほかの採用からこれ以上離す（秒）。近い画像はほぼ同じ場面の重複。
 * 実測では、捨てたい重複（字幕が変わっただけ・描き終わった直後）は 5〜10 秒差、
 * 残したい別のポーズの組（腕の実演の 020/021）は 14 秒差だったので、その間の 12 秒にした（2026-10-02）
 */
export const PICK_MIN_SPACING_SEC = 12;
/** 選んだ段落と画像の時刻がこれ以上ずれていたら、見間違いとみなして捨てる（秒） */
export const PICK_CHUNK_TOLERANCE_SEC = 90;
/** 1 回の呼び出しに付ける画像の上限。超えたら節を時間で半分に割る */
export const PICK_MAX_CANDIDATES = 60;

export type PickChunk = { start: number; text: string };
export type PickCandidate = {
  filename: string;
  videoTime: number;
  shown: boolean;
  /** 外された画像が属するまとまりの代表（載っている画像）。差し替え（swap）はまとまりの中でだけ許す */
  group?: string;
  /** Vision が読んだ文字の量（空白を除いた文字数）。字幕が写っている画像を文字のない画像に差し替えない歯止めに使う */
  textLen?: number;
};
export type PickRegion = { start: number; end: number; chunks: PickChunk[]; candidates: PickCandidate[] };

/** 1 つの節で採用できる枚数の上限。段落 3 つにつき 2 枚まで */
export function pickCap(region: PickRegion): number {
  return Math.ceil((region.chunks.length * 2) / 3);
}

/** 救出の対象にしない外し方。identical はまったく同じ画像、blank はほぼ一色 */
const UNRESCUABLE = new Set(['identical', 'blank']);

/**
 * 外された画像がどの掲載画像のまとまりに属するか（外された画像 → 代表の filename）。
 * sameSceneAs は判定した時点で載っていた画像を指すが、その画像があとで譲って外れることがあるので、
 * 載っている画像に行き着くまで辿る
 */
export function sceneGroups(decisions: readonly SceneDecision[]): Map<string, string> {
  const byName = new Map(decisions.map((d) => [d.filename, d]));
  const out = new Map<string, string>();
  for (const d of decisions) {
    if (d.shown || (d.reason && UNRESCUABLE.has(d.reason))) continue;
    const seen = new Set<string>([d.filename]);
    let cur: SceneDecision | undefined = d;
    while (cur?.sameSceneAs) {
      const next = byName.get(cur.sameSceneAs);
      if (!next || seen.has(next.filename)) break;
      if (next.shown) {
        out.set(d.filename, next.filename);
        break;
      }
      seen.add(next.filename);
      cur = next;
    }
  }
  return out;
}

function clockOf(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 救出を試す節を組み立てる。
 * 外された画像のうち、スライドではない画面（stillFraction < 0.976）のものを時間でまとめ、
 * その窓にある発話（段落）と、載っている画像（文脈）を添える。
 * stillFraction の記録がない古いセッションでは何もしない
 */
export function findPickRegions(
  segments: readonly { videoStart: number; videoEnd: number; text: string }[],
  slides: readonly SlideEntry[],
  decisions: readonly SceneDecision[],
  texts?: ReadonlyMap<string, string>,
): PickRegion[] {
  const byName = new Map(slides.map((s) => [s.filename, s]));
  const shown = new Set(decisions.filter((d) => d.shown).map((d) => d.filename));
  const repOf = sceneGroups(decisions);
  const rescuable: SlideEntry[] = [];
  for (const d of decisions) {
    if (d.shown || (d.reason && UNRESCUABLE.has(d.reason))) continue;
    const slide = byName.get(d.filename);
    const still = slide?.trigger?.stillFraction;
    if (!slide || still === undefined || still >= PICK_STILL_SLIDE) continue;
    rescuable.push(slide);
  }
  if (rescuable.length === 0) return [];
  rescuable.sort((a, b) => a.videoTime - b.videoTime);

  // 外された画像を時間でまとめて節にする
  const groups: SlideEntry[][] = [];
  for (const slide of rescuable) {
    const last = groups[groups.length - 1];
    if (last && slide.videoTime - last[last.length - 1]!.videoTime <= PICK_REGION_GAP_SEC) last.push(slide);
    else groups.push([slide]);
  }

  const regions: PickRegion[] = [];
  for (const group of groups) {
    const start = Math.max(0, group[0]!.videoTime - PICK_REGION_PAD_SEC);
    const end = group[group.length - 1]!.videoTime + PICK_REGION_PAD_SEC;
    const candidates: PickCandidate[] = [];
    for (const s of slides) {
      if (s.videoTime < start || s.videoTime > end) continue;
      const isShown = shown.has(s.filename);
      // 載っている画像は文脈として見せる。外された画像は救出の対象だけ（identical・blank は見せる意味がない）
      if (!isShown && !group.includes(s)) continue;
      const rep = repOf.get(s.filename);
      const textLen = texts?.get(s.filename)?.replace(/\s+/g, '').length;
      candidates.push({
        filename: s.filename,
        videoTime: s.videoTime,
        shown: isShown,
        ...(rep ? { group: rep } : {}),
        ...(textLen !== undefined ? { textLen } : {}),
      });
    }
    const chunks: PickChunk[] = [];
    for (const seg of segments) {
      if (seg.videoStart < start || seg.videoStart > end) continue;
      const last = chunks[chunks.length - 1];
      if (last && seg.videoStart - last.start < PICK_CHUNK_GAP_SEC) last.text += seg.text;
      else chunks.push({ start: seg.videoStart, text: seg.text });
    }
    if (chunks.length === 0) continue; // 発話のない窓は本文との対応を測れない
    regions.push({ start, end, chunks, candidates });
  }

  // 候補が多すぎる節は時間で半分に割る（1 回の呼び出しが重くなりすぎないように）
  const sized: PickRegion[] = [];
  const split = (region: PickRegion) => {
    if (region.candidates.length <= PICK_MAX_CANDIDATES || region.chunks.length < 2) {
      sized.push(region);
      return;
    }
    const mid = region.candidates[Math.floor(region.candidates.length / 2)]!.videoTime;
    const half = (lo: number, hi: number): PickRegion => ({
      start: lo,
      end: hi,
      chunks: region.chunks.filter((c) => c.start >= lo && c.start <= hi),
      candidates: region.candidates.filter((c) => c.videoTime >= lo && c.videoTime <= hi),
    });
    const a = half(region.start, mid);
    const b = half(mid, region.end);
    if (a.chunks.length === 0 || b.chunks.length === 0) {
      sized.push(region);
      return;
    }
    split(a);
    split(b);
  };
  for (const r of regions) split(r);
  return sized;
}

/**
 * LLM に返させる形。picks は足す画像（置き場所は時刻から決まり、after_paragraph は検算に使う）、
 * swaps は「掲載済みの代表を、同じまとまりの未掲載画像に差し替える」提案
 */
export const PICK_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          image: { type: 'integer' },
          after_paragraph: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['image', 'after_paragraph', 'reason'],
        additionalProperties: false,
      },
    },
    swaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'integer' },
          to: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['from', 'to', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['picks', 'swaps'],
  additionalProperties: false,
} as const;

export type Pick = { image: number; after_paragraph: number; reason: string };
export type SwapProposal = { from: number; to: number; reason: string };
export type PickResponse = { picks: Pick[]; swaps: SwapProposal[] };

export function buildPickPrompt(region: PickRegion): string {
  const lines: string[] = [
    'あなたは講義ノートの編集者です。講義動画の文字起こしの一部と、その時間帯に自動保存された画面キャプチャを渡します。いまのノートに足す価値のある画像（picks）と、差し替えた方がよい画像（swaps）を選んでください。',
    '',
    '守ること:',
    '- 講師が身振りや実物で何かを実演している瞬間、何かを指し示している瞬間、ホワイトボードや紙に描いている途中の状態は、本文の「こちら」「このように」を目に見える形で補うので、載せる価値が高い。文字起こしだけでは分からない動作が写っていたら picks で選ぶ',
    '- ただし見た目がほぼ同じ画像は代表 1 枚だけ。立って話しているだけ・内容が変わっていない・字幕が変わっただけの画像は選ばない',
    '- 「掲載済み」の画像はいまのノートに既に載っているので picks では選ばない。「未掲載」から救う価値のあるものだけを選ぶ',
    '- 掲載済みの画像（from）より、それと同じ場面の未掲載画像（to）の方が本文の動作をはっきり見せているときだけ、swaps で差し替えを提案する。明らかに良くなるときだけで、迷ったら差し替えない。字幕や説明の文字が写っている画像を、その文字が無い画像に差し替えない',
    '- 対応する画像がなければ選ばない（picks も swaps も空でよい）。picks の目安は段落 2 つにつき多くても 1 枚',
    '- after_paragraph はその番号の段落の近くの内容という意味（0 は冒頭）',
    '- 時刻は目安。キャプチャは発話より数秒あとに撮られていることがある',
    '',
    '段落（[動画内の開始時刻] 文字起こしそのまま）:',
  ];
  region.chunks.forEach((c, i) => lines.push(`${i + 1}. [${clockOf(c.start)}] ${c.text.trim()}`));
  lines.push('', '候補画像（添付の順）:');
  const indexOf = new Map(region.candidates.map((c, i) => [c.filename, i + 1]));
  region.candidates.forEach((c, i) => {
    const rep = c.group ? indexOf.get(c.group) : undefined;
    const mark = c.shown ? '掲載済み' : rep ? `未掲載、画像${rep}と同じ場面` : '未掲載';
    lines.push(`画像${i + 1} = [${clockOf(c.videoTime)}]（${mark}）`);
  });
  return lines.join('\n');
}

/** LLM の返答を読む。形の崩れた要素は捨てる（1 件の形崩れで全体を失敗にしない） */
export function parsePicks(raw: string): PickResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`picks が JSON として読めません: ${raw.slice(0, 120)}`);
  }
  const picks = (parsed as { picks?: unknown }).picks;
  if (!Array.isArray(picks)) throw new Error('picks が配列ではありません');
  const swaps = (parsed as { swaps?: unknown }).swaps;
  return {
    picks: picks.filter(
      (p): p is Pick =>
        typeof p === 'object' && p !== null && typeof (p as Pick).image === 'number' && typeof (p as Pick).after_paragraph === 'number',
    ),
    swaps: (Array.isArray(swaps) ? swaps : []).filter(
      (s): s is SwapProposal =>
        typeof s === 'object' && s !== null && typeof (s as SwapProposal).from === 'number' && typeof (s as SwapProposal).to === 'number',
    ),
  };
}

export type Rejected = { filename: string; why: string };
export type Swap = { from: string; to: string };

/**
 * 差し替えの機械的な歯止め。差し替え先は「場面まとめが同じまとまりと判定した未掲載画像」に限る。
 * まとまりの外や掲載済みへの差し替えは、LLM が提案しても通さない（情報が失われる方向の失敗を防ぐ）
 */
export function acceptSwaps(region: PickRegion, proposals: readonly SwapProposal[]): { swaps: Swap[]; rejected: Rejected[] } {
  const swaps: Swap[] = [];
  const rejected: Rejected[] = [];
  const usedFrom = new Set<string>();
  const usedTo = new Set<string>();
  for (const p of proposals) {
    const from = region.candidates[p.from - 1];
    const to = region.candidates[p.to - 1];
    if (!from || !to) {
      rejected.push({ filename: `画像${!from ? p.from : p.to}`, why: '候補にない番号（差し替え）' });
      continue;
    }
    if (!from.shown || to.shown) {
      rejected.push({ filename: to.filename, why: '差し替えは掲載済み→未掲載だけ' });
      continue;
    }
    if (to.group !== from.filename) {
      rejected.push({ filename: to.filename, why: `${from.filename} と同じまとまりではない` });
      continue;
    }
    // 字幕・説明の文字が写っている代表を、文字のない（少ない）画像に差し替えない。
    // 「はじめに」（自然を観る）で、字幕の出た代表 016 を字幕の無い 014 に差し替える提案が実際に出た（2026-10-02）
    const fromLen = from.textLen ?? 0;
    if (fromLen >= 4 && (to.textLen ?? 0) < fromLen * 0.6) {
      rejected.push({ filename: to.filename, why: `${from.filename} より写っている文字が減る` });
      continue;
    }
    if (usedFrom.has(from.filename) || usedTo.has(to.filename)) continue;
    usedFrom.add(from.filename);
    usedTo.add(to.filename);
    swaps.push({ from: from.filename, to: to.filename });
  }
  return { swaps, rejected };
}

/**
 * 1 回の返答をまとめて歯止めに通す。差し替え先は掲載扱いにしてから picks を見る
 * （差し替えた画像のすぐ隣に同じ場面の画像を足さない。差し替え先を picks でも選んでいたら掲載済みとして落ちる）
 */
export function acceptResponse(region: PickRegion, response: PickResponse): { accepted: PickCandidate[]; swaps: Swap[]; rejected: Rejected[] } {
  const { swaps, rejected } = acceptSwaps(region, response.swaps);
  const swappedTo = new Set(swaps.map((s) => s.to));
  const adjusted: PickRegion = {
    ...region,
    candidates: region.candidates.map((c) => (swappedTo.has(c.filename) ? { ...c, shown: true } : c)),
  };
  const picked = acceptPicks(adjusted, response.picks);
  return { accepted: picked.accepted, swaps, rejected: [...rejected, ...picked.rejected] };
}

/**
 * 機械的な歯止め。モデルによらず同じ規律を守らせる:
 * - 未掲載の候補だけ（掲載済み・範囲外の番号は捨てる）
 * - 選んだ段落と画像の時刻が大きくずれていたら見間違いとみなす
 * - 載っている画像・ほかの採用から 15 秒以上離す（近い画像はほぼ同じ場面）
 * - 採用は段落 3 つにつき 2 枚まで
 */
export function acceptPicks(region: PickRegion, picks: readonly Pick[]): { accepted: PickCandidate[]; rejected: Rejected[] } {
  const rejected: Rejected[] = [];
  const chosen: Array<{ candidate: PickCandidate; pick: Pick }> = [];
  const seen = new Set<string>();
  for (const pick of picks) {
    const candidate = region.candidates[pick.image - 1];
    if (!candidate) {
      rejected.push({ filename: `画像${pick.image}`, why: '候補にない番号' });
      continue;
    }
    if (candidate.shown) {
      rejected.push({ filename: candidate.filename, why: '掲載済み' });
      continue;
    }
    if (seen.has(candidate.filename)) continue;
    seen.add(candidate.filename);
    const anchor = pick.after_paragraph <= 0 ? region.start : (region.chunks[pick.after_paragraph - 1]?.start ?? region.start);
    if (Math.abs(candidate.videoTime - anchor) > PICK_CHUNK_TOLERANCE_SEC) {
      rejected.push({ filename: candidate.filename, why: `段落${pick.after_paragraph}と時刻が離れすぎ` });
      continue;
    }
    chosen.push({ candidate, pick });
  }
  // 時間順に、載っている画像とほかの採用から十分離れているものだけを通す
  chosen.sort((a, b) => a.candidate.videoTime - b.candidate.videoTime);
  const shownTimes = region.candidates.filter((c) => c.shown).map((c) => c.videoTime);
  const cap = pickCap(region);
  const accepted: PickCandidate[] = [];
  for (const { candidate } of chosen) {
    const near = [...shownTimes, ...accepted.map((a) => a.videoTime)].some((t) => Math.abs(candidate.videoTime - t) < PICK_MIN_SPACING_SEC);
    if (near) {
      rejected.push({ filename: candidate.filename, why: '載っている画像か別の採用に近すぎ' });
      continue;
    }
    if (accepted.length >= cap) {
      rejected.push({ filename: candidate.filename, why: `上限（${cap} 枚）` });
      continue;
    }
    accepted.push(candidate);
  }
  return { accepted, rejected };
}

/** 候補画像を 512px の JPEG に縮小する（macOS の sips）。失敗したら元の PNG をそのまま使う */
async function prepareImages(slidesDir: string, region: PickRegion, outDir: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  for (const [i, c] of region.candidates.entries()) {
    const src = path.join(slidesDir, c.filename);
    const dst = path.join(outDir, `${String(i + 1).padStart(3, '0')}.jpg`);
    const r = await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', '512', src, '--out', dst], { signal }).catch(
      () => ({ code: 1 }),
    );
    files.push(r.code === 0 ? dst : src);
  }
  return files;
}

export type PickerSettings = {
  codexBin: string;
  /** 救出に使うモデル。'' なら機能ごと止める */
  model: string;
  /** モデルが使えないときのやり直し先（整えのモデル）。'' なら codex の既定 */
  fallbackModel: string;
  signal?: AbortSignal;
};

export type RegionResult = { accepted: PickCandidate[]; swaps: Swap[]; rejected: Rejected[]; error?: string; model: string };

/** 1 つの節を codex に見せて選ばせる。モデルが使えないときは整えのモデルで 1 回だけやり直す */
export async function pickRegion(
  slidesDir: string,
  region: PickRegion,
  settings: PickerSettings,
  log: (line: string) => void,
): Promise<RegionResult> {
  const callOnce = async (model: string): Promise<{ accepted: PickCandidate[]; swaps: Swap[]; rejected: Rejected[] }> => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-pick-'));
    try {
      const images = await prepareImages(slidesDir, region, tmp, settings.signal);
      const schemaFile = path.join(tmp, 'schema.json');
      const outFile = path.join(tmp, 'last-message.txt');
      await writeFile(schemaFile, JSON.stringify(PICK_SCHEMA));
      const defaults = await readCodexDefaults();
      const args = codexArgs({
        dir: tmp,
        schemaFile,
        outFile,
        prompt: buildPickPrompt(region),
        model: model || defaults.model,
        effort: defaults.effort,
        images,
      });
      const r = await run(settings.codexBin, args, { signal: settings.signal });
      if (r.code !== 0) {
        throw new Error(`codex exec failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join(' / ')}`);
      }
      const response = parsePicks(await readFile(outFile, 'utf8'));
      return acceptResponse(region, response);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  };
  try {
    return { ...(await callOnce(settings.model)), model: settings.model };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isModelUnavailable(message) && settings.fallbackModel !== settings.model && !settings.signal?.aborted) {
      log(`画像の救出のモデル（${settings.model || '既定'}）が使えないため、整えのモデルでやり直します: ${message}`);
      try {
        return { ...(await callOnce(settings.fallbackModel)), model: settings.fallbackModel };
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        return { accepted: [], swaps: [], rejected: [], error: retryMessage, model: settings.fallbackModel };
      }
    }
    return { accepted: [], swaps: [], rejected: [], error: message, model: settings.model };
  }
}

export const PICKER_CACHE_FILE = 'picker-cache.json';

export type PickerCache = {
  key: string;
  generatedAt: string;
  model: string;
  accepted: string[];
  /** 差し替え（代表 from を同じまとまりの to に）。古いキャッシュには無い */
  swaps?: Swap[];
  rejected: Rejected[];
  errors: string[];
};

/** 節（段落と候補）とモデルから鍵を作る。文字起こし・画像の集まり・まとまり・歯止めの間隔が変われば呼び直す */
export function pickerCacheKey(regions: readonly PickRegion[], model: string): string {
  const hash = createHash('sha256');
  hash.update(`${model}\0spacing:${PICK_MIN_SPACING_SEC}\0swaps\n`);
  for (const r of regions) {
    for (const c of r.chunks) hash.update(`c\0${Math.round(c.start)}\0${c.text}\n`);
    for (const c of r.candidates) hash.update(`i\0${c.filename}\0${Math.round(c.videoTime)}\0${c.shown ? 1 : 0}\0${c.group ?? ''}\0${c.textLen ?? ''}\n`);
  }
  return hash.digest('hex').slice(0, 32);
}

export async function readPickerCache(dir: string): Promise<PickerCache | null> {
  try {
    const cache = JSON.parse(await readFile(workPath(dir, PICKER_CACHE_FILE), 'utf8')) as PickerCache;
    if (typeof cache.key !== 'string' || !Array.isArray(cache.accepted)) return null;
    return cache;
  } catch {
    return null;
  }
}

export async function writePickerCache(dir: string, cache: PickerCache): Promise<void> {
  await writeFile(workPath(dir, PICKER_CACHE_FILE), JSON.stringify(cache, null, 2)).catch(() => undefined);
}

/**
 * 採用した画像を載せる並びに差し込む。
 * 場面まとめの代表画像は、まとまりの先頭の時刻に繰り上げて置かれていることがある（§13.4b の standsFor。
 * まとまり全体の発話を代表の下に置くため）。救い出した画像がその繰り上げ区間に入るときは、
 * 代表を本来の撮影時刻に戻す。先頭側の発話は救った画像（実際にその時刻の画面）に付くので、むしろ正しくなる。
 * 戻さないと、あとの時刻の代表が先に並んで順序が逆転する（1 章 GD I-4 の 020/024 で確認）
 */
/**
 * 代表の差し替えを適用する。位置（繰り上げを含む）とまとまりの役割は代表のまま、見せる画像だけ入れ替える。
 * 発話の割り当ては変わらないので、まとまりの中のどの瞬間を見せるかだけが変わる
 */
export function applySwaps(shown: readonly SlideEntry[], all: readonly SlideEntry[], swaps: readonly Swap[]): SlideEntry[] {
  if (swaps.length === 0) return [...shown];
  const byName = new Map(all.map((s) => [s.filename, s]));
  const map = new Map(swaps.map((s) => [s.from, s.to]));
  return shown.map((s) => {
    const to = map.get(s.filename);
    const raw = to ? byName.get(to) : undefined;
    if (!raw) return s;
    return { ...s, filename: raw.filename, seq: raw.seq, width: raw.width, height: raw.height };
  });
}

export function withRescued(shown: readonly SlideEntry[], all: readonly SlideEntry[], accepted: readonly string[]): SlideEntry[] {
  if (accepted.length === 0) return [...shown];
  const byName = new Map(all.map((s) => [s.filename, s]));
  const extra = accepted.map((f) => byName.get(f)).filter((s): s is SlideEntry => s !== undefined);
  const adjusted = shown.map((s) => {
    const raw = byName.get(s.filename);
    if (!raw || raw.videoTime === s.videoTime) return s;
    const anchored = Math.min(s.videoTime, raw.videoTime);
    const own = Math.max(s.videoTime, raw.videoTime);
    return extra.some((r) => r.videoTime >= anchored && r.videoTime <= own) ? raw : s;
  });
  return [...adjusted, ...extra].sort((a, b) => slideStart(a) - slideStart(b));
}
