// 検知の記録（.lecscribe/trace.bin。SPEC §9.1e）を手元で再生し、検知の規則を変えたときに
// 何枚撮るか・ノートに使われた画像がどれだけ残るかを数える。
//
//   node --experimental-transform-types scripts/replay-trace.mts <セッションのフォルダ> [--check]
//
// --check: 記録に残った判定と、同じ設定で再生した判定が一致するかを確かめる（再生の仕組みの確認用）
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../extension/src/config.ts';
import { ChangeDetector, type Verdict } from '../extension/src/detect.ts';
import { readTrace, rgbToFrame, type TraceRecord } from '../extension/src/trace.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: replay-trace.mts <session dir> [--check]');
  process.exit(2);
}
const check = process.argv.includes('--check');
const work = path.join(dir, '.lecscribe');
const traceFile = path.join(work, 'trace.bin');
if (!existsSync(traceFile)) {
  console.error(`no trace: ${traceFile}`);
  process.exit(1);
}

const session = JSON.parse(readFileSync(path.join(work, 'session.json'), 'utf8')) as { config?: Partial<Config> };
const detect: Config['detect'] = { ...DEFAULT_CONFIG.detect, ...session.config?.detect };
const records = await readTrace(new Uint8Array(readFileSync(traceFile)));
const slides = existsSync(path.join(work, 'slides.json')) ? (JSON.parse(readFileSync(path.join(work, 'slides.json'), 'utf8')) as Array<{ filename: string; videoTime: number; reason: string }>) : [];
const scenes = existsSync(path.join(work, 'scenes.json')) ? (JSON.parse(readFileSync(path.join(work, 'scenes.json'), 'utf8')) as { decisions: Array<{ filename: string; shown: boolean }>; picker?: { accepted?: string[]; swaps?: Array<{ from: string; to: string }> } }) : null;

/** ノートに使われた自動キャプチャの動画時刻（場面まとめと救出・差し替えのあと） */
const used = new Set<number>();
if (scenes) {
  const shown = new Set(scenes.decisions.filter((d) => d.shown).map((d) => d.filename));
  for (const a of scenes.picker?.accepted ?? []) shown.add(a);
  for (const s of scenes.picker?.swaps ?? []) {
    shown.add(s.to);
    shown.delete(s.from);
  }
  for (const s of slides) if (s.reason === 'change' && shown.has(s.filename)) used.add(s.videoTime);
}

export type ReplayResult = { saves: number[]; mismatches: number };

/** 記録を頭から流し、保存を指示した動画時刻を返す */
export function replay(records: readonly TraceRecord[], cfg: Config['detect'], compare = false): ReplayResult {
  const detector = new ChangeDetector(cfg);
  const saves: number[] = [];
  let mismatches = 0;
  const same = (a: Verdict, b: NonNullable<TraceRecord['verdict']>) =>
    a.save === b.save && a.state === b.state && Math.abs(a.diffPrev - b.diffPrev) < 1e-4 && a.cells === b.cells && Math.abs(a.stillFraction - b.stillFraction) < 1e-4;
  for (const r of records) {
    const frame = rgbToFrame(r.rgb, r.width * r.height);
    switch (r.kind) {
      case 'sample':
      case 'flush': {
        const v = r.kind === 'sample' ? detector.sample(frame, r.now) : detector.flush(frame, r.now);
        if (v.save) saves.push(r.videoTime);
        if (compare && r.verdict && !same(v, r.verdict)) {
          mismatches++;
          if (mismatches <= 5) console.log(`  mismatch at ${r.videoTime.toFixed(1)}s: replay ${JSON.stringify(v)} vs recorded ${JSON.stringify(r.verdict)}`);
        }
        break;
      }
      case 'saved':
        detector.markSaved(frame, r.now);
        break;
      case 'replaced':
        detector.replaceSaved(frame);
        break;
    }
  }
  return { saves, mismatches };
}

/** 使われた画像のうち、再生の保存から 2 秒以内に相当するものがいくつ残るか */
function kept(saves: readonly number[]): number {
  let n = 0;
  for (const t of used) if (saves.some((s) => Math.abs(s - t) <= 2)) n++;
  return n;
}

const counts = records.reduce<Record<string, number>>((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {});
const span = records.length ? records[records.length - 1]!.videoTime - records[0]!.videoTime : 0;
console.log(`trace: ${records.length} records (${JSON.stringify(counts)}), ${(span / 60).toFixed(1)} min, ${records[0]?.width}x${records[0]?.height}`);
console.log(`recorded: ${slides.filter((s) => s.reason === 'change').length} auto captures, ${used.size} used in notes`);

const base = replay(records, detect, check);
console.log(`replay (current rules): ${base.saves.length} saves, keeps ${kept(base.saves)}/${used.size} used${check ? `, ${base.mismatches} verdict mismatches` : ''}`);
