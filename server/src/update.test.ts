import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBin, run } from './exec.ts';
import { applyUpdate, checkForUpdate } from './update.ts';

/** 署名や名前の設定に依らず commit できる git */
const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];

describe('自動更新', () => {
  it('origin/main が進んでいれば available、入れ替えると追いつく。開発機（変更あり・別ブランチ）では確認しない', async () => {
    const git = await resolveBin('git');
    if (!git) return; // git のない環境では飛ばす
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-update-'));
    const origin = path.join(tmp, 'origin.git');
    const work = path.join(tmp, 'work');
    const other = path.join(tmp, 'other');
    expect((await run(git, ['init', '--quiet', '--bare', '-b', 'main', origin])).code).toBe(0);
    expect((await run(git, ['clone', '--quiet', origin, work])).code).toBe(0);
    await writeFile(path.join(work, 'a.txt'), '1\n');
    expect((await run(git, [...G, 'add', 'a.txt'], { cwd: work })).code).toBe(0);
    expect((await run(git, [...G, 'commit', '--quiet', '-m', 'first'], { cwd: work })).code).toBe(0);
    expect((await run(git, ['push', '--quiet', '-u', 'origin', 'HEAD:main'], { cwd: work })).code).toBe(0);
    expect((await run(git, ['checkout', '--quiet', '-B', 'main', 'origin/main'], { cwd: work })).code).toBe(0);

    expect(await checkForUpdate(work)).toEqual({ available: false, behind: 0 });

    // 別の clone から 1 コミット進める
    expect((await run(git, ['clone', '--quiet', origin, other])).code).toBe(0);
    await writeFile(path.join(other, 'a.txt'), '2\n');
    expect((await run(git, [...G, 'commit', '--quiet', '-am', 'second'], { cwd: other })).code).toBe(0);
    expect((await run(git, ['push', '--quiet', 'origin', 'HEAD:main'], { cwd: other })).code).toBe(0);

    expect(await checkForUpdate(work)).toEqual({ available: true, behind: 1 });
    expect(await applyUpdate(work)).toBe(true);
    expect(await checkForUpdate(work)).toEqual({ available: false, behind: 0 });

    // 手元に変更があれば触らない
    await writeFile(path.join(work, 'a.txt'), 'local\n');
    expect((await checkForUpdate(work)).skipped).toMatch(/変更/);
    expect((await run(git, ['checkout', '--quiet', '--', 'a.txt'], { cwd: work })).code).toBe(0);
    // main 以外にいても触らない
    expect((await run(git, ['checkout', '--quiet', '-b', 'feature'], { cwd: work })).code).toBe(0);
    expect((await checkForUpdate(work)).skipped).toMatch(/main/);
    // git リポジトリでなければ触らない
    expect((await checkForUpdate(tmp)).skipped).toMatch(/リポジトリ/);
  }, 60_000);
});
