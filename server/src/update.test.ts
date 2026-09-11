import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBin, run } from './exec.ts';
import { selfUpdate } from './update.ts';

/** 署名や名前の設定に依らず commit できる git */
const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
const silent = () => undefined;

describe('自動更新', () => {
  it('進んでいれば入れ替え、追いつけば何もしない。開発機（変更あり・別ブランチ・非リポジトリ）では触らない', async () => {
    const git = await resolveBin('git');
    if (!git) return; // git のない環境では飛ばす
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-update-'));
    const origin = path.join(tmp, 'origin.git');
    const appDir = path.join(tmp, 'work');
    const other = path.join(tmp, 'other');
    const at = (cwd: string, args: string[]) => run(git, args, { cwd });
    const opts = { appDir, branch: 'main', gitBin: 'git', log: silent };

    expect((await run(git, ['init', '--quiet', '--bare', '-b', 'main', origin])).code).toBe(0);
    expect((await run(git, ['clone', '--quiet', origin, appDir])).code).toBe(0);
    await writeFile(path.join(appDir, 'a.txt'), '1\n');
    expect((await at(appDir, [...G, 'add', 'a.txt'])).code).toBe(0);
    expect((await at(appDir, [...G, 'commit', '--quiet', '-m', 'first'])).code).toBe(0);
    expect((await at(appDir, ['push', '--quiet', '-u', 'origin', 'HEAD:main'])).code).toBe(0);
    expect((await at(appDir, ['checkout', '--quiet', '-B', 'main', 'origin/main'])).code).toBe(0);

    expect(await selfUpdate(opts)).toEqual({ updated: false, reason: '最新です' });

    // 別の clone から 1 コミット進める
    expect((await run(git, ['clone', '--quiet', origin, other])).code).toBe(0);
    await writeFile(path.join(other, 'a.txt'), '2\n');
    expect((await at(other, [...G, 'commit', '--quiet', '-am', 'second'])).code).toBe(0);
    expect((await at(other, ['push', '--quiet', 'origin', 'HEAD:main'])).code).toBe(0);

    expect(await selfUpdate(opts)).toEqual({ updated: true, behind: 1 });
    expect(await selfUpdate(opts)).toEqual({ updated: false, reason: '最新です' });

    // 手元に変更があれば触らない
    await writeFile(path.join(appDir, 'a.txt'), 'local\n');
    expect((await selfUpdate(opts)).updated).toBe(false);
    expect(((await selfUpdate(opts)) as { reason: string }).reason).toMatch(/変更/);
    expect((await at(appDir, ['checkout', '--quiet', '--', 'a.txt'])).code).toBe(0);
    // 追いかけるブランチ以外にいても触らない
    expect((await at(appDir, ['checkout', '--quiet', '-b', 'feature'])).code).toBe(0);
    expect(((await selfUpdate(opts)) as { reason: string }).reason).toMatch(/ブランチ/);
    // git リポジトリでなければ触らない
    expect(((await selfUpdate({ ...opts, appDir: tmp })) as { reason: string }).reason).toMatch(/作業ツリー/);
  }, 60_000);

  it('git が無い・フォルダが無いときも投げずに見送る（投げるとサーバーが起動のたびに落ちる）', async () => {
    const missing = await selfUpdate({ appDir: '/no/such/dir', branch: 'main', gitBin: 'git', log: silent });
    expect(missing.updated).toBe(false);
    const noGit = await selfUpdate({ appDir: os.tmpdir(), branch: 'main', gitBin: 'lec-scribe-no-such-git', log: silent });
    expect(noGit).toEqual({ updated: false, reason: 'lec-scribe-no-such-git が見つかりません' });
  }, 30_000);
});
