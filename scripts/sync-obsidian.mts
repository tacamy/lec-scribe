// Obsidian などへコピーした notes.md と slides/ を、LecScribe の今の内容に合わせる（SPEC §14）。
//
//   node --experimental-transform-types scripts/sync-obsidian.mts --vault <フォルダ> [--dry-run] [--notes] [--force-notes] [--only <文字列>] [--out <LecScribe>]
//
// --vault:       講義のフォルダ（notes.md と slides/ を置いたフォルダ）が下にある場所。深さ 5 まで探す
// --dry-run:     何も動かさず、何をするかだけ出す
// --notes:       notes.md も置き換える（コピーしたあと手で直していないと分かるものだけ）
// --force-notes: 手で直した形跡があっても notes.md を置き換える（--only で対象を絞ってから使う）
// --only:        フォルダの相対パスにこの文字列を含むものだけ扱う
// --out:         LecScribe の出力フォルダ（既定 ~/LecScribe。LEC_SCRIBE_OUT でも）
//
// 対応と判定は server/src/vault.ts（テスト付き）。slides/ は LecScribe の slides/（notes.md に載せた画像だけ）と
// 同じ集合にする（余分を消し、無いものをクローンで写す）。ただし置き換えた先の notes.md が言及する画像が無くなる
// 場合は触らない。写したら各フォルダに記録（.lecscribe-sync.json）を残し、次回はその印で手で直したかを見る。
// LecScribe 側で処理中の講義は触らない。フォルダごとに失敗を受け止めて続け、失敗があれば終了コード 1
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SLIDE_FILE, cloneFile } from '../server/src/layout.ts';
import { SYNC_MANIFEST, type SyncManifest, imagesMentioned, matchSession, notesHash, notesUntouched, parseManifest } from '../server/src/vault.ts';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const value = (name: string): string | undefined => {
  const v = args[args.indexOf(name) + 1];
  return args.includes(name) && v !== undefined && !v.startsWith('--') ? v : undefined;
};
const usage = 'usage: node --experimental-transform-types scripts/sync-obsidian.mts --vault <フォルダ> [--dry-run] [--notes] [--force-notes] [--only <文字列>] [--out <LecScribe>]';
const dryRun = flag('--dry-run');
const forceNotes = flag('--force-notes');
const withNotes = flag('--notes') || forceNotes;
const only = value('--only');
const expand = (p: string): string => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
const vaultArg = value('--vault');
const vaultDir = vaultArg ? expand(vaultArg) : '';
const outDir = expand(value('--out') ?? process.env.LEC_SCRIBE_OUT ?? path.join(os.homedir(), 'LecScribe'));
if (!vaultDir || !isDir(vaultDir) || !isDir(outDir)) {
  console.error(usage);
  if (vaultDir && !isDir(vaultDir)) console.error(`--vault のフォルダがありません: ${vaultDir}`);
  if (!isDir(outDir)) console.error(`LecScribe のフォルダがありません: ${outDir}`);
  process.exit(1);
}

/** 処理中の段階（server/src/pipeline.ts の IN_PROGRESS と同じ） */
const IN_PROGRESS = new Set(['queued', 'converting', 'transcribing', 'merging', 'polishing']);
const imageFiles = (dir: string): string[] => (isDir(dir) ? readdirSync(dir).filter((n) => SLIDE_FILE.test(n)).sort() : []);

type Session = { id: string; dir: string; notes: string; slides: string[]; busy: boolean };
const sessions: Session[] = readdirSync(outDir)
  .filter((n) => isDir(path.join(outDir, n)) && existsSync(path.join(outDir, n, 'notes.md')))
  .map((n) => {
    const dir = path.join(outDir, n);
    let stage: string | undefined;
    try {
      stage = (JSON.parse(readFileSync(path.join(dir, '.lecscribe', 'pipeline.json'), 'utf8')) as { stage?: string }).stage;
    } catch {
      // pipeline.json が無い・読めない: 処理中ではない
    }
    return { id: n.match(/[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/)?.[0] ?? n, dir, notes: readFileSync(path.join(dir, 'notes.md'), 'utf8'), slides: imageFiles(path.join(dir, 'slides')), busy: stage !== undefined && IN_PROGRESS.has(stage) };
  });

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

const counts = { notes: 0, slides: 0, same: 0, edited: 0, skipped: 0, failed: 0 };
console.log(`${dryRun ? '確認だけ' : '同期'}: ${vaultDir} ← ${outDir}`);
for (const dir of targets(vaultDir)) {
  const label = path.relative(vaultDir, dir);
  if (only && !label.includes(only)) continue;
  try {
    const notes = readFileSync(path.join(dir, 'notes.md'), 'utf8');
    const manifestFile = path.join(dir, SYNC_MANIFEST);
    const manifest = existsSync(manifestFile) ? parseManifest(readFileSync(manifestFile, 'utf8')) : null;
    const found = matchSession(notes, manifest, sessions);
    if (!found) {
      console.log(`- ${label}: 対応する講義が決まらないので触らない`);
      counts.skipped++;
      continue;
    }
    const { session, how } = found;
    if (session.busy) {
      console.log(`- ${label}: LecScribe 側が処理中なので触らない`);
      counts.skipped++;
      continue;
    }
    const actions: string[] = [];

    // notes.md: 手で直していないと分かるときだけ置き換える
    const notesDiffers = session.notes !== notes;
    const untouched = notesUntouched(notes, manifest, session.notes);
    let replaceNotes = false;
    if (withNotes && notesDiffers) {
      if (untouched || forceNotes) {
        replaceNotes = true;
        actions.push(`notes.md を置き換え${untouched ? '' : '（手で直したか区別できないが --force-notes）'}`);
      } else {
        console.log(`- ${label}: notes.md は${manifest?.notesHash ? 'コピーしたあと手で直した形跡があるので' : '手で直したか、やり直しで変わったか区別できないので'}置き換えない（--only ${label} --force-notes で置き換える）`);
        counts.edited++;
      }
    }
    const notesAfter = replaceNotes ? session.notes : notes;

    // slides/: 置き換えたあとの notes.md が言及する画像が全部あるときだけ合わせる
    const slidesDir = path.join(dir, 'slides');
    const have = imageFiles(slidesDir);
    const missing = [...imagesMentioned(notesAfter)].filter((n) => !session.slides.includes(n));
    let toRemove: string[] = [];
    let toCopy: string[] = [];
    if (missing.length > 0) {
      console.log(`- ${label}: コピー先の notes.md が言及する ${missing.length} 枚が LecScribe の slides/ に無いので画像は触らない（${missing.slice(0, 3).join(', ')}）`);
    } else {
      toRemove = have.filter((n) => !session.slides.includes(n));
      toCopy = session.slides.filter((n) => !have.includes(n) || statSync(path.join(slidesDir, n)).size !== statSync(path.join(session.dir, 'slides', n)).size);
      if (toRemove.length > 0 || toCopy.length > 0) actions.push(`slides/ ${have.length} 枚 → ${session.slides.length} 枚（消す ${toRemove.length}、写す ${toCopy.length}）`);
    }

    if (actions.length === 0) {
      console.log(`- ${label}: 既に同じ（${how}。画像 ${have.length} 枚${notesDiffers && !withNotes ? '。notes.md は違うが --notes なし' : ''}）`);
      counts.same++;
    } else {
      console.log(`- ${label}: ${actions.join('、')}（対応: ${how}）`);
      if (dryRun) {
        if (replaceNotes) counts.notes++;
        if (toRemove.length > 0 || toCopy.length > 0) counts.slides++;
        continue;
      }
    }
    if (dryRun) continue;

    // 画像を先に合わせ、notes.md はそのあとで書く（画像で失敗したときに、無い画像を指す notes.md を残さない）
    if (toRemove.length > 0 || toCopy.length > 0) {
      mkdirSync(slidesDir, { recursive: true });
      for (const n of toRemove) rmSync(path.join(slidesDir, n));
      for (const n of toCopy) {
        rmSync(path.join(slidesDir, n), { force: true });
        await cloneFile(path.join(session.dir, 'slides', n), path.join(slidesDir, n));
      }
      const after = imageFiles(slidesDir);
      if (JSON.stringify(after) !== JSON.stringify(session.slides)) throw new Error(`置き換え後の slides/ が LecScribe と一致しない（${after.length} 枚）`);
      counts.slides++;
    }
    if (replaceNotes) {
      writeFileSync(path.join(dir, 'notes.md'), session.notes);
      counts.notes++;
    }
    // 記録: 印は「この道具が写した」か「直していないと確かめた」ときだけ更新する。手で直したものは前の印のまま残す
    const hash = replaceNotes ? notesHash(session.notes) : untouched ? notesHash(notes) : manifest?.notesHash;
    const next: SyncManifest = { sessionId: session.id, ...(hash ? { notesHash: hash } : {}), syncedAt: new Date().toISOString() };
    writeFileSync(manifestFile, JSON.stringify(next, null, 2));
  } catch (e) {
    console.log(`- ${label}: 失敗: ${e instanceof Error ? e.message : String(e)}`);
    counts.failed++;
  }
}
console.log(
  `${dryRun ? '置き換える' : '置き換えた'}: notes.md ${counts.notes} 本、slides/ ${counts.slides} 本。既に同じ: ${counts.same} 本、notes.md を置き換えない: ${counts.edited} 本、触らない: ${counts.skipped} 本${counts.failed > 0 ? `、失敗: ${counts.failed} 本` : ''}`,
);
if (counts.failed > 0) process.exitCode = 1;
