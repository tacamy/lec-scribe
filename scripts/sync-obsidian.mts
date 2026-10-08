// Obsidian などへコピーした notes.md と slides/ を、LecScribe の今の内容に合わせる（SPEC §14）。
//
//   node --experimental-transform-types scripts/sync-obsidian.mts --vault <フォルダ> [--dry-run] [--notes] [--force-notes] [--out <LecScribe>]
//
// --vault:       講義のフォルダ（notes.md と slides/ を置いたフォルダ）が下にある場所。深さ 5 まで探す
// --dry-run:     何も動かさず、何をするかだけ出す
// --notes:       notes.md も置き換える（コピーしたあと手で直していないと分かるものだけ）
// --force-notes: 手で直した形跡があっても notes.md を置き換える
// --out:         LecScribe の出力フォルダ（既定 ~/LecScribe。LEC_SCRIBE_OUT でも）
//
// 対応は notes.md の中身で取る: 中身が同じ、画像リンクの書き方だけ違う（Obsidian は vault 内の絶対パスや
// ファイル名だけの形に書き換える）、前回この道具で写したときの記録（.lecscribe-sync.json）、見出し行が 1 件に決まる、の順。
// slides/ は LecScribe の slides/（notes.md に載せた画像だけ）と同じ集合にする（余分を消し、無いものをクローンで写す）。
// ただし置き換えた先の notes.md が参照する画像が無くなる場合は触らない。
// notes.md は、前回写したときの記録と今の中身（リンクの形を揃えて）が一致するものだけ置き換える。記録が無い初回は、
// 「要点」の段落と画像リンクの形の違いを除いて一致するなら手で直していないとみなす。写したら記録を書く
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const value = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = flag('--dry-run');
const withNotes = flag('--notes') || flag('--force-notes');
const forceNotes = flag('--force-notes');
const expand = (p: string): string => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const vault = value('--vault');
if (!vault || !existsSync(expand(vault))) {
  console.error('usage: node --experimental-transform-types scripts/sync-obsidian.mts --vault <フォルダ> [--dry-run] [--notes] [--force-notes] [--out <LecScribe>]');
  process.exit(1);
}
const vaultDir = expand(vault);
const outDir = expand(value('--out') ?? process.env.LEC_SCRIBE_OUT ?? path.join(os.homedir(), 'LecScribe'));
const MANIFEST = '.lecscribe-sync.json';
const IMAGE = /^slide_[0-9]{3,}\.(png|jpg)$/;

const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
const imageFiles = (dir: string): string[] => (isDir(dir) ? readdirSync(dir).filter((n) => IMAGE.test(n)).sort() : []);
const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
/** Obsidian が書き換えた画像リンク（vault 内の絶対パス、ファイル名だけ）を LecScribe の形に戻す */
const normalizeLinks = (md: string): string => md.replace(/\]\([^)\n]*?(slide_[0-9]{3,}\.(?:png|jpg))\)/g, '](slides/$1)');
/** 「**要点**」の段落（見出しの下の箇条書き）を除く。2026-10-08 より前の notes.md と比べるため */
const stripPoints = (md: string): string => md.replace(/\*\*要点\*\*\n\n(?:- [^\n]*\n)+\n/g, '');
/** notes.md が参照している画像の名前 */
const imagesIn = (md: string): Set<string> => new Set([...md.matchAll(/(slide_[0-9]{3,}\.(?:png|jpg))\)/g)].map((m) => m[1]!));

type Session = { id: string; dir: string; notes: string; title: string; slides: string[] };
const sessions: Session[] = readdirSync(outDir)
  .filter((n) => isDir(path.join(outDir, n)) && existsSync(path.join(outDir, n, 'notes.md')))
  .map((n) => {
    const dir = path.join(outDir, n);
    const notes = readFileSync(path.join(dir, 'notes.md'), 'utf8');
    return { id: n.match(/[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/)?.[0] ?? n, dir, notes, title: notes.split('\n')[0] ?? '', slides: imageFiles(path.join(dir, 'slides')) };
  });

type Manifest = { sessionId: string; notesHash: string; syncedAt: string };
const readManifest = (dir: string): Manifest | null => {
  try {
    return JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8')) as Manifest;
  } catch {
    return null;
  }
};

/** コピー先のフォルダ（notes.md があるもの）を深さ 5 まで集める */
function targets(dir: string, depth = 0): string[] {
  if (depth > 5) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (!isDir(p)) continue;
    if (existsSync(path.join(p, 'notes.md'))) out.push(p);
    else out.push(...targets(p, depth + 1));
  }
  return out;
}

/** コピー先の notes.md に対応するセッション */
function match(notes: string, manifest: Manifest | null): { session: Session; how: string } | null {
  const normalized = normalizeLinks(notes);
  const same = sessions.find((s) => s.notes === notes || s.notes === normalized);
  if (same) return { session: same, how: same.notes === notes ? '同じ' : 'リンクの形だけ違う' };
  if (manifest) {
    const recorded = sessions.find((s) => s.id === manifest.sessionId);
    if (recorded) return { session: recorded, how: '前回の記録' };
  }
  const title = notes.split('\n')[0] ?? '';
  const byTitle = sessions.filter((s) => s.title === title);
  if (byTitle.length === 1) return { session: byTitle[0]!, how: '見出し' };
  return null;
}

const counts = { slides: 0, notes: 0, same: 0, skipped: 0, edited: 0 };
console.log(`${dryRun ? '確認だけ' : '同期'}: ${vaultDir} ← ${outDir}`);
for (const dir of targets(vaultDir)) {
  const label = path.relative(vaultDir, dir);
  const notes = readFileSync(path.join(dir, 'notes.md'), 'utf8');
  const manifest = readManifest(dir);
  const found = match(notes, manifest);
  if (!found) {
    console.log(`- ${label}: 対応する講義が決まらないので触らない`);
    counts.skipped++;
    continue;
  }
  const { session, how } = found;
  const actions: string[] = [];

  // notes.md: 手で直していないと分かるときだけ置き換える
  let notesAfter = notes;
  const notesDiffers = session.notes !== notes;
  if (withNotes && notesDiffers) {
    const current = normalizeLinks(notes);
    const untouched = manifest ? manifest.notesHash === hash(current) : stripPoints(current) === stripPoints(session.notes);
    if (untouched || forceNotes) {
      actions.push(`notes.md を置き換え${untouched ? '' : '（手で直した形跡があるが --force-notes）'}`);
      notesAfter = session.notes;
    } else {
      console.log(`- ${label}: notes.md はコピーしたあと手で直した形跡があるので置き換えない（--force-notes で置き換える）`);
      counts.edited++;
    }
  }

  // slides/: 置き換えたあとの notes.md が参照する画像が全部あるときだけ合わせる
  const slidesDir = path.join(dir, 'slides');
  const have = imageFiles(slidesDir);
  const need = imagesIn(notesAfter);
  const missing = [...need].filter((n) => !session.slides.includes(n));
  let toRemove: string[] = [];
  let toCopy: string[] = [];
  if (missing.length > 0) {
    console.log(`- ${label}: コピー先の notes.md が参照する ${missing.length} 枚が LecScribe の slides/ に無いので画像は触らない（${missing.slice(0, 3).join(', ')}）`);
  } else {
    toRemove = have.filter((n) => !session.slides.includes(n));
    toCopy = session.slides.filter((n) => !have.includes(n) || statSync(path.join(slidesDir, n)).size !== statSync(path.join(session.dir, 'slides', n)).size);
    if (toRemove.length > 0 || toCopy.length > 0) actions.push(`slides/ ${have.length} 枚 → ${session.slides.length} 枚（消す ${toRemove.length}、写す ${toCopy.length}）`);
  }

  if (actions.length === 0) {
    console.log(`- ${label}: 既に同じ（${how}。画像 ${have.length} 枚${notesDiffers && !withNotes ? '。notes.md は違うが --notes なし' : ''}）`);
    counts.same++;
    continue;
  }
  console.log(`- ${label}: ${actions.join('、')}（対応: ${how}）`);
  if (dryRun) {
    if (notesAfter !== notes) counts.notes++;
    if (toRemove.length > 0 || toCopy.length > 0) counts.slides++;
    continue;
  }
  if (notesAfter !== notes) {
    writeFileSync(path.join(dir, 'notes.md'), notesAfter);
    counts.notes++;
  }
  if (toRemove.length > 0 || toCopy.length > 0) {
    for (const n of toRemove) rmSync(path.join(slidesDir, n));
    if (toCopy.length > 0) {
      execFileSync('mkdir', ['-p', slidesDir]);
      execFileSync('/bin/cp', ['-c', ...toCopy.map((n) => path.join(session.dir, 'slides', n)), `${slidesDir}/`]);
    }
    const after = imageFiles(slidesDir);
    if (JSON.stringify(after) !== JSON.stringify(session.slides)) console.log(`  !! 置き換え後の slides/ が一致しない（${after.length} 枚）`);
    counts.slides++;
  }
  // 次回のために、写した notes.md（Obsidian が書き換える前の形）の印を残す
  writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ sessionId: session.id, notesHash: hash(normalizeLinks(notesAfter)), syncedAt: new Date().toISOString() } satisfies Manifest, null, 2));
}
console.log(
  `${dryRun ? '置き換える' : '置き換えた'}: notes.md ${counts.notes} 本、slides/ ${counts.slides} 本。既に同じ: ${counts.same} 本、手で直したので触らない: ${counts.edited} 本、対応が決まらない: ${counts.skipped} 本`,
);
