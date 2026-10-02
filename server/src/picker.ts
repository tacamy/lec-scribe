import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.ts';
import { workPath } from './layout.ts';
import { createBackend, isModelUnavailable } from './llm.ts';
import { slideStart, type SlideEntry } from './merge.ts';
import type { SceneDecision } from './scenes.ts';

/**
 * 映像・板書の節で、場面まとめ（§13.4b）が外した画像から「本文の助けになる瞬間」を救い出す（SPEC §13.4c）。
 *
 * 場面まとめは見た目の近さでしか判断できないので、腕の実演やホワイトボードに描いている途中の状態のような
 * 「動きこそが内容」の画像を、同じ場面として 1 枚に畳んでしまう（1 章 GD I-4 の腕の実演で確認）。
 * そこで、スライドではない画面（stillFraction < 0.976）の外された画像を文字起こしと一緒に LLM に見せ、
 * (1) 本文に対応する動作が写っているものを足し（picks）、(2) 載っている代表より同じまとまりの外された画像の方が
 * 本文の動作を見せているなら差し替える（swaps）。どちらも規則が載せた画像を減らさない（差し替えは同じまとまりの中だけ）。
 *
 * モデルは gpt-5.6-terra を既定にする（2026-10-02 の実測）。選んだものの質は luna・terra・astra とも
 * 間違いなしだが、luna には拾い漏れがあり（腕の実演の 2 ポーズ目を 3 回中 2 回逃す。採用 3 枚に対し
 * terra 7 枚・astra 8 枚で、増えた分も全部妥当だった）、astra は terra との差が小さいのに枠の消費が約 3 倍。
 * 5 時間枠の消費は講義 2 本で terra 約 3%・astra 約 8%・luna ほぼ 0%。節約したいときは
 * `--llm-pick-model gpt-5.6-luna`。どのモデルでも、選びすぎは機械的な歯止め（間隔と上限）で抑える。
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
/** 代表にこの文字数以上の文字（字幕・説明）が写っていたら、文字が減る差し替えを弾く */
export const SWAP_TEXT_MIN = 4;
/** 差し替え先の文字がこの割合を下回ったら「文字が減る」とみなす */
export const SWAP_TEXT_KEEP = 0.6;

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

/** プロンプトに載せる時刻（MM:SS）。実測はこの形で行ったので変えない */
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

  // 候補が多すぎる節は時間で半分に割る（1 回の呼び出しが重くなりすぎないように）。
  // 前半は [start, mid)、後半は [mid, end] にして、境目の候補と段落を両方に入れない（2026-10-02 のレビュー。
  // 両方に入れると同じ画像が 2 回選ばれ、notes.md に同じ節が 2 つできた）
  const sized: PickRegion[] = [];
  const split = (region: PickRegion) => {
    if (region.candidates.length <= PICK_MAX_CANDIDATES || region.chunks.length < 2) {
      sized.push(region);
      return;
    }
    const mid = region.candidates[Math.floor(region.candidates.length / 2)]!.videoTime;
    const a: PickRegion = {
      start: region.start,
      end: mid,
      chunks: region.chunks.filter((c) => c.start < mid),
      candidates: region.candidates.filter((c) => c.videoTime < mid),
    };
    const b: PickRegion = {
      start: mid,
      end: region.end,
      chunks: region.chunks.filter((c) => c.start >= mid),
      candidates: region.candidates.filter((c) => c.videoTime >= mid),
    };
    if (a.chunks.length === 0 || b.chunks.length === 0 || a.candidates.length === 0) {
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
    if (fromLen >= SWAP_TEXT_MIN && (to.textLen ?? 0) < fromLen * SWAP_TEXT_KEEP) {
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
 * 足す画像（picks）の機械的な歯止め。モデルによらず同じ規律を守らせる:
 * - 未掲載の候補だけ（掲載済み・範囲外の番号は捨てる）
 * - 段落の番号が整数で、0（冒頭）か実在する段落であること。範囲外・小数は答えの崩れとみなして捨てる
 * - 選んだ段落と画像の時刻が大きくずれていたら見間違いとみなす
 * - 載っている画像・ほかの採用から PICK_MIN_SPACING_SEC（12 秒）以上離す（近い画像はほぼ同じ場面）
 * - 採用は段落 3 つにつき 2 枚まで
 */
export function acceptPicks(region: PickRegion, picks: readonly Pick[]): { accepted: PickCandidate[]; rejected: Rejected[] } {
  const rejected: Rejected[] = [];
  const chosen: PickCandidate[] = [];
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
    const p = pick.after_paragraph;
    if (!Number.isInteger(p) || p < 0 || p > region.chunks.length) {
      rejected.push({ filename: candidate.filename, why: `段落の番号が不正（${p}）` });
      continue;
    }
    const anchor = p === 0 ? region.start : region.chunks[p - 1]!.start;
    if (Math.abs(candidate.videoTime - anchor) > PICK_CHUNK_TOLERANCE_SEC) {
      rejected.push({ filename: candidate.filename, why: `段落${p}と時刻が離れすぎ` });
      continue;
    }
    chosen.push(candidate);
  }
  // 時間順に、載っている画像とほかの採用から十分離れているものだけを通す
  chosen.sort((a, b) => a.videoTime - b.videoTime);
  const shownTimes = region.candidates.filter((c) => c.shown).map((c) => c.videoTime);
  const cap = pickCap(region);
  const accepted: PickCandidate[] = [];
  for (const candidate of chosen) {
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

/**
 * 候補画像を一時フォルダに 001.jpg… の名前で用意する（sips で 512px の JPEG に縮小。失敗したら元の PNG を写す）。
 * セッションのフォルダ名はページのタイトルから付くので、元のパスをそのまま codex に渡さない:
 * カンマを含むパスは codex が読み込めず、しかもエラーにならずに画像が黙って欠け、番号がずれる（2026-10-02 に確認）
 */
async function prepareImages(slidesDir: string, region: PickRegion, outDir: string, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  for (const [i, c] of region.candidates.entries()) {
    const src = path.join(slidesDir, c.filename);
    const base = path.join(outDir, String(i + 1).padStart(3, '0'));
    const r = await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', '512', src, '--out', `${base}.jpg`], { signal }).catch(
      () => ({ code: 1 }),
    );
    // sips は元のファイルが無いと警告だけ出して 0 で終わり、何も書かない。終了コードではなく出力の有無で見る
    const made = r.code === 0 && (await stat(`${base}.jpg`).then((s) => s.size > 0).catch(() => false));
    if (made) {
      files.push(`${base}.jpg`);
    } else {
      // 写せなければ投げる（1 枚欠けると番号が全部ずれるので、この節は諦める）
      await copyFile(src, `${base}.png`);
      files.push(`${base}.png`);
    }
  }
  return files;
}

export type PickerSettings = {
  codexBin: string;
  /** 救出に使うモデル。'' なら codex の既定 */
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
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-pick-'));
  try {
    // 画像は 1 度だけ用意する（モデルの受け皿でやり直すときも使い回す）
    const images = await prepareImages(slidesDir, region, tmp, settings.signal);
    const prompt = buildPickPrompt(region);
    const callOnce = async (model: string) => {
      const backend = createBackend({
        kind: 'codex',
        model,
        codexBin: settings.codexBin,
        openaiApiKey: '',
        ollamaUrl: '',
        charsPerCall: 0,
        ...(settings.signal ? { signal: settings.signal } : {}),
      })!;
      return acceptResponse(region, parsePicks(await backend.complete(prompt, PICK_SCHEMA, { images })));
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
  } catch (error) {
    // 画像を用意できなかった
    return { accepted: [], swaps: [], rejected: [], error: error instanceof Error ? error.message : String(error), model: settings.model };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * 節ごとの結果をまとめる。節をまたいだ重複と近さもここで見直す
 * （節は時間で分かれているが、割った境目の両側で 12 秒以内の画像が別々に選ばれうる）
 */
export function mergeRegionResults(regions: readonly PickRegion[], results: readonly RegionResult[]): { accepted: string[]; swaps: Swap[]; rejected: Rejected[] } {
  const swaps: Swap[] = [];
  const usedFrom = new Set<string>();
  const usedTo = new Set<string>();
  for (const r of results) {
    for (const s of r.swaps) {
      if (usedFrom.has(s.from) || usedTo.has(s.to)) continue;
      usedFrom.add(s.from);
      usedTo.add(s.to);
      swaps.push(s);
    }
  }
  const shownTimes = new Map<string, number>();
  for (const region of regions) for (const c of region.candidates) if (c.shown || usedTo.has(c.filename)) shownTimes.set(c.filename, c.videoTime);
  const rejected: Rejected[] = results.flatMap((r) => r.rejected);
  const accepted: PickCandidate[] = [];
  const all = results.flatMap((r) => r.accepted).sort((a, b) => a.videoTime - b.videoTime);
  for (const c of all) {
    if (accepted.some((a) => a.filename === c.filename) || shownTimes.has(c.filename)) continue;
    const near = [...shownTimes.values(), ...accepted.map((a) => a.videoTime)].some((t) => Math.abs(c.videoTime - t) < PICK_MIN_SPACING_SEC);
    if (near) {
      rejected.push({ filename: c.filename, why: '載っている画像か別の採用に近すぎ（節の境目）' });
      continue;
    }
    accepted.push(c);
  }
  return { accepted: accepted.map((c) => c.filename), swaps, rejected };
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

/** 歯止めの線。キャッシュは歯止めを通したあとの結果なので、線を変えたら呼び直す */
const PICKER_RULES = JSON.stringify({
  still: PICK_STILL_SLIDE,
  gap: PICK_REGION_GAP_SEC,
  pad: PICK_REGION_PAD_SEC,
  chunk: PICK_CHUNK_GAP_SEC,
  spacing: PICK_MIN_SPACING_SEC,
  tolerance: PICK_CHUNK_TOLERANCE_SEC,
  max: PICK_MAX_CANDIDATES,
  textMin: SWAP_TEXT_MIN,
  textKeep: SWAP_TEXT_KEEP,
  cap: '2/3',
  schema: PICK_SCHEMA,
});

/**
 * 節（プロンプトの全文と候補）・モデル・歯止めの線から鍵を作る。
 * 文字起こし・画像の集まり・まとまり・プロンプトの文言・歯止めのどれかが変われば呼び直す
 */
export function pickerCacheKey(regions: readonly PickRegion[], model: string): string {
  const hash = createHash('sha256');
  hash.update(`${model}\0${PICKER_RULES}\n`);
  for (const r of regions) {
    hash.update(`p\0${buildPickPrompt(r)}\n`);
    for (const c of r.candidates) hash.update(`i\0${c.filename}\0${c.group ?? ''}\0${c.textLen ?? ''}\n`);
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

export type PickerRun = {
  accepted: string[];
  swaps: Swap[];
  rejected: Rejected[];
  errors: string[];
  model: string;
  /** 前回の選択を使い回した */
  reused: boolean;
};

/**
 * 節ごとに選ばせて、結果をまとめる。前回と鍵が同じで失敗が残っていなければ、呼ばずに前回の選択を返す。
 * 途中で止めたときは何も採らず、キャッシュも書かない（部分的な選択を次回に使い回さない）
 */
export async function runPicker(input: {
  dir: string;
  slidesDir: string;
  regions: readonly PickRegion[];
  settings: PickerSettings;
  log: (line: string) => void;
}): Promise<PickerRun> {
  const { dir, slidesDir, regions, settings, log } = input;
  const key = pickerCacheKey(regions, settings.model);
  const cached = await readPickerCache(dir);
  if (cached && cached.key === key && (cached.errors ?? []).length === 0) {
    return { accepted: cached.accepted, swaps: cached.swaps ?? [], rejected: cached.rejected ?? [], errors: [], model: cached.model, reused: true };
  }
  const results: RegionResult[] = [];
  let model = settings.model;
  for (const region of regions) {
    if (settings.signal?.aborted) break;
    const r = await pickRegion(slidesDir, region, settings, log);
    model = r.model;
    results.push(r);
  }
  if (settings.signal?.aborted) return { accepted: [], swaps: [], rejected: [], errors: [], model, reused: false };
  const merged = mergeRegionResults(regions, results);
  const errors = results.flatMap((r) => (r.error ? [r.error] : []));
  await writePickerCache(dir, { key, generatedAt: new Date().toISOString(), model, accepted: merged.accepted, swaps: merged.swaps, rejected: merged.rejected, errors });
  return { ...merged, errors, model, reused: false };
}

/**
 * 載せる画像の並びを作る（差し替えと救出を反映。§13.4c）。
 *
 * まとまり（場面まとめの代表と、そこへ辿れる外された画像）ごとに、見せる画像（代表か差し替え先、救った画像）を
 * 撮影時刻の順に並べ、いちばん早いものに代表の位置（まとまりの先頭への繰り上げ standsFor を含む）を渡し、
 * 残りは自分の撮影時刻に置く。こうするとまとまりの発話は、前の別の場面の画像に流れずにまとまりの画像の下に入る。
 * 何も変わらないまとまりは、代表をそのまま返す（2026-10-02 のレビュー。代表を本来の時刻に戻すだけだと、
 * 繰り上げ区間の発話が前の別のスライドに付いた）
 */
export function arrangeImages(
  shown: readonly SlideEntry[],
  all: readonly SlideEntry[],
  decisions: readonly SceneDecision[],
  accepted: readonly string[],
  swaps: readonly Swap[],
): SlideEntry[] {
  if (accepted.length === 0 && swaps.length === 0) return [...shown];
  const raw = new Map(all.map((s) => [s.filename, s]));
  const repOf = sceneGroups(decisions);
  const swapTo = new Map(swaps.map((s) => [s.from, s.to]));
  const shownNames = new Set(shown.map((s) => s.filename));
  // まとまりの終わり（代表と、そこへ辿れる画像のうち最も遅い撮影時刻）
  const groupEnd = new Map<string, number>();
  for (const s of shown) groupEnd.set(s.filename, raw.get(s.filename)?.videoTime ?? s.videoTime);
  for (const [member, rep] of repOf) {
    const t = raw.get(member)?.videoTime;
    if (t !== undefined && groupEnd.has(rep)) groupEnd.set(rep, Math.max(groupEnd.get(rep)!, t));
  }
  // 救った画像の行き先: まとまりが分かればその代表、分からなければ代表の位置〜まとまりの終わりに入るか
  const rescuedBy = new Map<string, SlideEntry[]>();
  const standalone: SlideEntry[] = [];
  for (const name of accepted) {
    const entry = raw.get(name);
    if (!entry) continue;
    let rep = repOf.get(name);
    if (!rep || !shownNames.has(rep)) {
      rep = shown.find((s) => entry.videoTime >= s.videoTime && entry.videoTime <= (groupEnd.get(s.filename) ?? s.videoTime))?.filename;
    }
    if (rep) rescuedBy.set(rep, [...(rescuedBy.get(rep) ?? []), entry]);
    else standalone.push(entry);
  }
  const out: SlideEntry[] = [];
  for (const s of shown) {
    const display = raw.get(swapTo.get(s.filename) ?? '') ?? raw.get(s.filename) ?? s;
    const extras = rescuedBy.get(s.filename) ?? [];
    if (display.filename === s.filename && extras.length === 0) {
      out.push(s);
      continue;
    }
    const members = [display, ...extras].sort((a, b) => a.videoTime - b.videoTime);
    const [first, ...rest] = members;
    out.push({ ...s, filename: first!.filename, seq: first!.seq, width: first!.width, height: first!.height });
    out.push(...rest);
  }
  out.push(...standalone);
  return out.sort((a, b) => slideStart(a) - slideStart(b));
}
