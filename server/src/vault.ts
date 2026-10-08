/**
 * コピー先（Obsidian など）の notes.md と slides/ を LecScribe の今の内容に合わせるための判断（SPEC §14）。
 * ファイルを触る部分は scripts/sync-obsidian.mts にあり、ここは純粋な関数だけ（テストのため）。
 */
import { createHash } from 'node:crypto';

/** コピー先のフォルダに残す、前回写したときの記録 */
export const SYNC_MANIFEST = '.lecscribe-sync.json';
export type SyncManifest = {
  /** 対応するセッションの id（フォルダ名の末尾 20260908-103005-ab12） */
  sessionId: string;
  /** この道具が最後に写した notes.md の印（リンクの形を揃えたうえでの notesHash）。手で直したかの判定に使う。無ければ中身で判定 */
  notesHash?: string;
  syncedAt: string;
};

/** 記録を読む。形が違えば（途中で切れた、手で書き換えた）無いものとして扱う */
export function parseManifest(text: string): SyncManifest | null {
  try {
    const v = JSON.parse(text) as Partial<SyncManifest> | null;
    if (!v || typeof v !== 'object' || typeof v.sessionId !== 'string' || typeof v.syncedAt !== 'string') return null;
    if (v.notesHash !== undefined && typeof v.notesHash !== 'string') return null;
    return { sessionId: v.sessionId, syncedAt: v.syncedAt, ...(v.notesHash ? { notesHash: v.notesHash } : {}) };
  } catch {
    return null;
  }
}

/** Obsidian が書き換えた画像リンク（vault 内の絶対パス、ファイル名だけ）を LecScribe の形（slides/slide_NNN.png）に戻す */
export function normalizeLinks(md: string): string {
  return md.replace(/\]\([^)\n]*?(slide_[0-9]{3,}\.(?:png|jpg))\)/g, '](slides/$1)');
}

/** 「**要点**」の段落（見出しの下の箇条書き）を除く。2026-10-08 より前の notes.md と比べるため。最後の段落には空行が続かないことがある */
export function stripPoints(md: string): string {
  return md.replace(/\*\*要点\*\*\n\n(?:- [^\n]*\n)+\n?/g, '');
}

/**
 * notes.md が言及している画像の名前。Markdown のリンクに限らず、`<img src="…">` や Obsidian の `![[slide_001.png]]`、
 * ファイル名だけのリンクも拾う（多めに拾っても、消さない側に倒れるだけ）
 */
export function imagesMentioned(md: string): Set<string> {
  return new Set([...md.matchAll(/slide_[0-9]{3,}\.(?:png|jpg)/g)].map((m) => m[0]));
}

/** notes.md の印。リンクの形の違いは無視する */
export function notesHash(md: string): string {
  return createHash('sha256').update(normalizeLinks(md)).digest('hex').slice(0, 16);
}

/** 見出し・収録日時・元ページ（先頭の段落）。同じ講義を撮り直した別の録画は収録日時で区別できる */
export function headerOf(md: string): string {
  const lines = md.split('\n');
  const end = lines.indexOf('', 1);
  return lines.slice(0, end < 0 ? lines.length : end + 3).join('\n');
}

export type SessionLike = { id: string; notes: string };

/**
 * コピー先の notes.md に対応するセッション。中身が同じ（リンクの形の違いは無視）→ 前回の記録 → 先頭の段落
 * （見出しと収録日時）が 1 件に決まる、の順。決まらなければ null
 */
export function matchSession<T extends SessionLike>(notes: string, manifest: SyncManifest | null, sessions: readonly T[]): { session: T; how: string } | null {
  const normalized = normalizeLinks(notes);
  const same = sessions.find((s) => s.notes === notes || s.notes === normalized);
  if (same) return { session: same, how: same.notes === notes ? '同じ' : 'リンクの形だけ違う' };
  if (manifest) {
    const recorded = sessions.find((s) => s.id === manifest.sessionId);
    if (recorded) return { session: recorded, how: '前回の記録' };
  }
  const header = headerOf(normalized);
  const byHeader = sessions.filter((s) => headerOf(s.notes) === header);
  if (byHeader.length === 1) return { session: byHeader[0]!, how: '見出しと収録日時' };
  return null;
}

/**
 * コピー先の notes.md を、この道具が写したあと手で直していないとみなせるか。
 * 前回の記録に印があればそれと比べる。無い初回は、リンクの形と「要点」の段落を除いて LecScribe の今の notes.md と
 * 一致するときだけ（やり直しで中身が変わったあとだと区別できず、直していなくても false になる）
 */
export function notesUntouched(current: string, manifest: SyncManifest | null, sessionNotes: string): boolean {
  if (manifest?.notesHash) return manifest.notesHash === notesHash(current);
  return stripPoints(normalizeLinks(current)) === stripPoints(sessionNotes);
}
