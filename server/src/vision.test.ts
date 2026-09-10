import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBin, run } from './exec.ts';
import { ensureVisionHelper, visionDistances } from './vision.ts';

describe('vision', () => {
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
    const distance = await visionDistances([a, b, c]);
    expect(distance).not.toBeNull();
    const ab = distance!(0, 1)!;
    const ac = distance!(0, 2)!;
    expect(ab).toBeLessThan(ac);
    expect(distance!(0, 0)).toBe(0);
  }, 120_000);
});
