import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { forgetResolvedBins, resolveBin, run } from './exec.ts';
import { ensureVisionHelper, visionDistances } from './vision.ts';

describe('vision', () => {
  it('作れなかったときは覚えず、次に呼ばれたらやり直す（#10）', async () => {
    // 補助コマンドがまだ無い HOME と、swiftc が見つからない PATH にして 1 回目を失敗させる。
    // 覚えてしまうと、あとから Command Line Tools を入れても常駐サーバーは気づけない（何日も動くので）
    const originalPath = process.env['PATH'];
    const originalHome = process.env['HOME'];
    const home = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-home-'));
    const empty = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-nopath-'));
    try {
      process.env['HOME'] = home;
      process.env['PATH'] = empty;
      forgetResolvedBins();
      expect(await ensureVisionHelper()).toBeNull();
      // 覚えていたら、swiftc が見つかる PATH に戻しても null のまま返ってくる。
      // HOME も普段の場所に戻してから呼ぶ（この一時 HOME はこのあと消すので、覚えられると次のテストが壊れる）
      process.env['PATH'] = originalPath ?? '';
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      forgetResolvedBins();
      if (process.platform === 'darwin' && (await resolveBin('swiftc'))) {
        expect(await ensureVisionHelper()).toBeTruthy();
      }
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      forgetResolvedBins();
      await Promise.all([rm(home, { recursive: true, force: true }), rm(empty, { recursive: true, force: true })]);
    }
  });

  it('macOS で swiftc があれば補助コマンドを作り、似た画像は近く・違う画像は遠い', async () => {
    if (process.platform !== 'darwin' || !(await resolveBin('swiftc')) || !(await resolveBin('ffmpeg'))) return; // CI などでは飛ばす
    const bin = await ensureVisionHelper();
    expect(bin).toBeTruthy();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-vision-'));
    const ffmpeg = (await resolveBin('ffmpeg'))!;
    const make = async (name: string, color: string, size: string) => {
      const file = path.join(dir, name);
      await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`, '-frames:v', '1', file]);
      return file;
    };
    const a = await make('a.png', 'red', '320x180');
    const b = await make('b.png', 'red', '300x170'); // ほぼ同じ
    const c = await make('c.png', 'blue', '320x180'); // 別物
    const measure = await visionDistances([a, b, c]);
    expect(measure).not.toBeNull();
    const ab = measure!.distance(0, 1)!;
    const ac = measure!.distance(0, 2)!;
    expect(ab).toBeLessThan(ac);
    expect(measure!.distance(0, 0)).toBe(0);
    // 文字のない画像は空文字（読めなかった場合だけ undefined）
    expect(['string', 'undefined']).toContain(typeof measure!.text(0));
    expect(measure!.text(0) ?? '').toBe('');
  }, 120_000);
});
