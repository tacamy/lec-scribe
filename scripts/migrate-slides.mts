// 以前の講義（旧配置: 全画像が slides/）をまとめて新配置に移し、slides/ を notes.md に合わせる（SPEC §14）。
// 1 本ずつ「やり直す」をしなくても、slides/ がノートに載せた画像だけになる。
//
//   node --experimental-transform-types scripts/migrate-slides.mts [--dry-run] [--out <フォルダ>]
//
// --dry-run: 何も動かさず、何をするかだけ出す
// --out:     セッションのあるフォルダ（既定 ~/LecScribe。サーバーの --out / LEC_SCRIBE_OUT と同じ）
//
// notes.md が無い講義と処理中の講義は触らない。改名とクローン（cp -c）だけなので数秒で終わり、容量も増えない。
// 新配置の講義にも当てて構わない（合っていれば何もしない）。サーバーが処理中でないときに実行する
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NOTES_FILE, SLIDE_FILE, SLIDES_DIR, migrateLayout, slidesInNotes, slidesSourcePath, syncSlides } from '../server/src/layout.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outArg = args[args.indexOf('--out') + 1];
const outRaw = args.includes('--out') && outArg ? outArg : (process.env.LEC_SCRIBE_OUT ?? path.join(os.homedir(), 'LecScribe'));
const outDir = outRaw.startsWith('~/') ? path.join(os.homedir(), outRaw.slice(2)) : outRaw;
if (!existsSync(outDir)) {
  console.error(`フォルダがありません: ${outDir}`);
  process.exit(1);
}

/** 処理中の段階（server/src/pipeline.ts の IN_PROGRESS と同じ。処理中の講義は触らない） */
const IN_PROGRESS = new Set(['queued', 'converting', 'transcribing', 'merging', 'polishing']);
const slideFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((n) => SLIDE_FILE.test(n)) : []);
const label = (name: string): string => (name.length > 64 ? `${name.slice(0, 61)}…` : name);

console.log(`${dryRun ? '確認だけ' : '整理'}: ${outDir}`);
const counts = { migrated: 0, unchanged: 0, skipped: 0, failed: 0 };
for (const name of readdirSync(outDir).sort()) {
  const dir = path.join(outDir, name);
  if (!statSync(dir).isDirectory()) continue;
  if (!existsSync(path.join(dir, NOTES_FILE))) {
    console.log(`- ${label(name)}: notes.md がないので触らない`);
    counts.skipped++;
    continue;
  }
  let stage: string | undefined;
  try {
    stage = (JSON.parse(readFileSync(path.join(dir, '.lecscribe', 'pipeline.json'), 'utf8')) as { stage?: string }).stage;
  } catch {
    // pipeline.json が無い・読めない: 処理中ではない
  }
  if (stage && IN_PROGRESS.has(stage)) {
    console.log(`- ${label(name)}: 処理中（${stage}）なので飛ばす`);
    counts.skipped++;
    continue;
  }
  const inSource = new Set(slideFiles(slidesSourcePath(dir)));
  const toMove = slideFiles(path.join(dir, SLIDES_DIR)).filter((n) => !inSource.has(n));
  if (dryRun) {
    const used = slidesInNotes(readFileSync(path.join(dir, NOTES_FILE), 'utf8')).size;
    console.log(`- ${label(name)}: 正本へ移す ${toMove.length} 枚（正本 ${inSource.size} 枚）→ slides/ は notes.md の ${used} 枚に`);
    if (toMove.length > 0) counts.migrated++;
    else counts.unchanged++;
    continue;
  }
  try {
    const moved = (await migrateLayout(dir)).filter((m) => m.startsWith(`${SLIDES_DIR}/`)).length;
    const synced = await syncSlides(dir);
    const source = slideFiles(slidesSourcePath(dir)).length;
    const copies = slideFiles(path.join(dir, SLIDES_DIR)).length;
    const changed = moved > 0 || (synced !== null && (synced.copied > 0 || synced.removed > 0));
    const missing = synced && synced.missing > 0 ? `、正本に無い ${synced.missing} 枚` : '';
    console.log(`- ${label(name)}: 正本 ${source} 枚、slides/ ${copies} 枚（移した ${moved}、写した ${synced?.copied ?? 0}、外した ${synced?.removed ?? 0}${missing}）`);
    if (changed) counts.migrated++;
    else counts.unchanged++;
  } catch (e) {
    console.log(`- ${label(name)}: 失敗: ${e instanceof Error ? e.message : String(e)}`);
    counts.failed++;
  }
}
console.log(`${dryRun ? '移す' : '移した'}: ${counts.migrated} 本、そのまま: ${counts.unchanged} 本、触らない: ${counts.skipped} 本${counts.failed > 0 ? `、失敗: ${counts.failed} 本` : ''}`);
if (counts.failed > 0) process.exitCode = 1;
