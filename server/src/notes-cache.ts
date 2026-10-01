import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { workPath } from './layout.ts';
import type { Correction, Outline, PolishOutput } from './llm.ts';

/**
 * LLM の結果（整えた本文と話題の区切り）を .lecscribe/notes-cache.json に残す（SPEC §13.5b）。
 *
 * 「やり直す」で節約できるのは文字起こしだけで、ノート作成は毎回 LLM を呼び直していた。
 * Markdown の組み立てを変えただけのやり直しでもトークンを使ってしまうので、
 * 入力（節ごとの本文）と呼び出し先が前と同じなら、保存しておいた結果を使う。
 */

export const NOTES_CACHE_FILE = 'notes-cache.json';

export type NotesCacheInput = { id: string; text: string };

export type CacheSettings = {
  kind: string;
  model: string;
  charsPerCall: number;
  /** 校正（誤変換の修正）に使ったモデル。校正なしなら省く（古いキャッシュと鍵が変わらないように） */
  checkModel?: string;
};

export type NotesCache = {
  /** 入力と設定から作る鍵。変わっていれば呼び直す */
  key: string;
  generatedAt: string;
  backend: string;
  /** そのときの呼び出し先・モデル・分割の大きさ。節の区切りだけ変わったときの組み替えに使ってよいかの判断に使う */
  settings?: CacheSettings;
  /** そのときの入力（節ごとの本文）。節の区切りが変わったときに組み替えて使い回すために残す */
  inputs?: NotesCacheInput[];
  polished: PolishOutput[];
  outline?: Outline;
  /** 校正（誤変換の修正）で当てた直し。polished には当てたあとの本文が入る（§13.5、記録用。その回に当てた分だけで、組み替えでは引き継がない） */
  corrections?: Correction[];
  /**
   * 校正だけの失敗（枠切れなど）。本文は揃っていて直しが入らないだけなので、errors とは別に残し、
   * キャッシュの使い回しの判断（errors が空か）には使わない（2026-10-01 のレビュー）
   */
  checkErrors?: string[];
  /** LLM がうまく答えなかった節などの記録 */
  errors?: string[];
};

/** 節ごとの本文と、呼び出し先・モデル・分割の大きさから鍵を作る */
export function cacheKey(sections: readonly NotesCacheInput[], settings: CacheSettings): string {
  const hash = createHash('sha256');
  // 校正のモデルは有効なときだけ鍵に混ぜる（無効なら今までの鍵のままで、既存のキャッシュが無駄にならない）。
  // 節の行（id と本文の 2 欄）と混ざらないよう、設定の行の 4 つ目の欄として足す（2026-10-01 のレビュー）
  hash.update(`${settings.kind}\0${settings.model}\0${settings.charsPerCall}${settings.checkModel ? `\0check:${settings.checkModel}` : ''}\n`);
  for (const s of sections) hash.update(`${s.id}\0${s.text}\n`);
  return hash.digest('hex').slice(0, 32);
}

/** 保存してあるノートのキャッシュ。読めなければ null（呼び直しに倒す） */
export async function readNotesCache(dir: string): Promise<NotesCache | null> {
  try {
    const cache = JSON.parse(await readFile(workPath(dir, NOTES_CACHE_FILE), 'utf8')) as NotesCache;
    if (!Array.isArray(cache.polished)) return null;
    return cache;
  } catch {
    return null;
  }
}

/** 呼び出し先・モデル・分割の大きさが前と同じか。分からない（古いキャッシュ）なら使わない */
export function sameSettings(cache: NotesCache, settings: CacheSettings): boolean {
  const s = cache.settings;
  return !!s && s.kind === settings.kind && s.model === settings.model && s.charsPerCall === settings.charsPerCall && (s.checkModel ?? '') === (settings.checkModel ?? '');
}

/**
 * 節の区切りだけが変わったとき（載せる画像を選び直した、など）、前回の結果を組み替えて使う。
 * 画像を外すと、その間の発話は 1 つ前の節に続くので、新しい節の本文は前回の節をいくつか
 * 順につないだものになる。つながりが一致した節は、整えた本文もつないで使える。
 * 話題の区切り（startId）は、前回の節が入った新しい節に付け替える。
 * 一致しない節（文字起こしが変わった）は返さず、呼び出し側が LLM に頼む
 */
export function deriveFromCache(
  cache: NotesCache,
  inputs: readonly NotesCacheInput[],
): { polished: Map<string, PolishOutput>; outline?: Outline; unmatched: string[] } {
  const polished = new Map<string, PolishOutput>();
  const unmatched: string[] = [];
  const oldInputs = cache.inputs ?? [];
  const oldPolished = new Map(cache.polished.map((p) => [p.id, p.text]));
  /** 前回の節 id → 今回の節 id */
  const movedTo = new Map<string, string>();
  let i = 0;
  for (const section of inputs) {
    // 発話のない節は整える対象がない。前回も同じ位置に空の節があれば消費しておく
    if (section.text === '') {
      polished.set(section.id, { id: section.id, text: '' });
      if (oldInputs[i]?.text === '') {
        movedTo.set(oldInputs[i]!.id, section.id);
        i++;
      }
      continue;
    }
    // 前回の節を i 以降のどこかから順につないで、今回の本文と一致するところを探す。
    // 載せる画像を「まとまりの最後の 1 枚」にしているので、まとまった節の id は最後の画像のものになり、
    // 本文は最初の画像の節から順につないだものになる（id の位置と本文の位置がずれる）。
    // そのため id で飛ばずに、本文が一致する開始位置を探す
    const found = findRun(oldInputs, i, section.text);
    if (found && found.parts.every((id) => oldPolished.has(id))) {
      polished.set(section.id, { id: section.id, text: found.parts.map((id) => oldPolished.get(id)!).filter(Boolean).join('\n\n') });
      for (const id of found.parts) movedTo.set(id, section.id);
      i = found.end;
    } else {
      unmatched.push(section.id);
      // 本文が変わった節は諦め、同じ id の節が前回にあればその次から拾い直す
      const byId = oldInputs.findIndex((o, k) => k >= i && o.id === section.id);
      if (byId >= 0) i = byId + 1;
    }
  }
  let outline: Outline | undefined;
  if (cache.outline && unmatched.length === 0) {
    const seen = new Set<string>();
    const topics = cache.outline.topics.flatMap((t) => {
      const startId = movedTo.get(t.startId);
      if (!startId || seen.has(startId)) return [];
      seen.add(startId);
      return [{ ...t, startId }];
    });
    outline = { overview: cache.outline.overview, topics };
  }
  return { polished, ...(outline ? { outline } : {}), unmatched };
}

/** 前回の節を start 以降の位置から順につないで text と一致する並びを探す。見つからなければ null */
function findRun(oldInputs: readonly NotesCacheInput[], from: number, text: string): { parts: string[]; end: number } | null {
  for (let start = from; start < oldInputs.length; start++) {
    // 先頭の節の本文が今回の本文の先頭にないなら、この位置からはつながらない（空の節は次の節を見る）
    const first = oldInputs[start]!.text;
    if (first !== '' && !text.startsWith(first)) continue;
    let joined = '';
    const parts: string[] = [];
    let j = start;
    while (j < oldInputs.length && joined.length < text.length) {
      joined += oldInputs[j]!.text;
      parts.push(oldInputs[j]!.id);
      j++;
    }
    if (joined === text && parts.length > 0) return { parts, end: j };
  }
  return null;
}

export async function writeNotesCache(dir: string, cache: NotesCache): Promise<void> {
  await writeFile(workPath(dir, NOTES_CACHE_FILE), JSON.stringify(cache, null, 2)).catch(() => undefined);
}
