import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetResolvedBins, isExecutable, resolveBin } from './exec.ts';

describe('resolveBin', () => {
  const originalPath = process.env['PATH'];
  /** 作った一時ディレクトリ。テストごとに消す（消さないと毎回 2 つずつ残る） */
  const tmpDirs: string[] = [];
  const makeTmpDir = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-bin-'));
    tmpDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    // PATH が元から無ければ消す（undefined を代入すると文字列 "undefined" が入ってしまう）
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
    forgetResolvedBins();
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('少しの間は覚えていて、PATH を歩き直さない', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, 'lec-scribe-fake-tool');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
    process.env['PATH'] = `${dir}${path.delimiter}${originalPath ?? ''}`;
    forgetResolvedBins();
    expect(await resolveBin('lec-scribe-fake-tool')).toBe(file);
    // 消しても、覚えている間は同じ答え（PATH を歩いていない証拠）
    await rm(file);
    expect(await resolveBin('lec-scribe-fake-tool')).toBe(file);
    // 忘れれば、消えたことに気づく（brew uninstall しても「ある」と言い続けない）
    forgetResolvedBins();
    expect(await resolveBin('lec-scribe-fake-tool')).toBeNull();
  });

  it('見つからなかった結果も覚えるが、忘れればあとから入れたものを見つける', async () => {
    const dir = await makeTmpDir();
    process.env['PATH'] = dir;
    forgetResolvedBins();
    expect(await resolveBin('lec-scribe-later-tool')).toBeNull();
    const file = path.join(dir, 'lec-scribe-later-tool');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
    expect(await resolveBin('lec-scribe-later-tool')).toBeNull();
    forgetResolvedBins();
    expect(await resolveBin('lec-scribe-later-tool')).toBe(file);
  });

  it('パスで指定されたものはそのまま見る', async () => {
    expect(await resolveBin('/bin/sh')).toBe('/bin/sh');
    expect(await resolveBin('/no/such/lec-scribe')).toBeNull();
  });
});

describe('isExecutable', () => {
  it('ディレクトリや空のファイルは「実行できる」と言わない（access(X_OK) だけだと通ってしまう）', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-exec-'));
    try {
      expect(await isExecutable(dir)).toBe(false);
      const empty = path.join(dir, 'empty');
      await writeFile(empty, '');
      await chmod(empty, 0o755);
      expect(await isExecutable(empty)).toBe(false);
      const real = path.join(dir, 'real');
      await writeFile(real, '#!/bin/sh\n');
      await chmod(real, 0o755);
      expect(await isExecutable(real)).toBe(true);
      expect(await isExecutable(path.join(dir, 'missing'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
