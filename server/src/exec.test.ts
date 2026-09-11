import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetResolvedBins, resolveBin } from './exec.ts';

describe('resolveBin', () => {
  const originalPath = process.env['PATH'];
  afterEach(() => {
    process.env['PATH'] = originalPath;
    forgetResolvedBins();
  });

  it('見つけた場所を覚え、その後ファイルが消えても同じ答えを返す（毎回 PATH を歩かない）', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-bin-'));
    const file = path.join(dir, 'lec-scribe-fake-tool');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
    process.env['PATH'] = `${dir}${path.delimiter}${originalPath ?? ''}`;
    forgetResolvedBins();
    expect(await resolveBin('lec-scribe-fake-tool')).toBe(file);
    await rm(file);
    expect(await resolveBin('lec-scribe-fake-tool')).toBe(file);
  });

  it('見つからなかった結果も覚える（あとから入れた場合は 1 分後に見つかる）', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-bin-'));
    process.env['PATH'] = dir;
    forgetResolvedBins();
    expect(await resolveBin('lec-scribe-later-tool')).toBeNull();
    const file = path.join(dir, 'lec-scribe-later-tool');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);
    // まだ覚えている（1 分以内）
    expect(await resolveBin('lec-scribe-later-tool')).toBeNull();
    // 忘れれば見つかる
    forgetResolvedBins();
    expect(await resolveBin('lec-scribe-later-tool')).toBe(file);
  });

  it('パスで指定されたものはそのまま見る', async () => {
    expect(await resolveBin('/bin/sh')).toBe('/bin/sh');
    expect(await resolveBin('/no/such/lec-scribe')).toBeNull();
  });
});
