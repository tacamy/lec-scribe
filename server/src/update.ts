import { resolveBin, run } from './exec.ts';

/**
 * サーバー自身の更新（SPEC §12.1b）。
 *
 * 拡張は Chrome ウェブストアが更新するが、Mac 側のサーバーは ~/LecScribe-app/ に置いた git の作業ツリーなので、
 * 何もしなければ古いまま残る。新旧が組むと新しい機能が黙って効かなくなるので、起動時に origin/main を見に行き、
 * 進んでいれば fast-forward して終了する。launchd（KeepAlive）が 10 秒後に新しいコードで起動し直すので、
 * 利用者は初回の導入以外でターミナルを触らずに済む。
 *
 * 開発機を壊さないため、main 以外のブランチにいる・手元に変更がある・git リポジトリでない、のどれかなら何もしない。
 */

export type UpdateCheck = {
  /** origin/main が進んでいる */
  available: boolean;
  /** 何コミット遅れているか */
  behind: number;
  /** 確認しなかった理由（開発機、ネットワークなし、など） */
  skipped?: string;
};

const FETCH_TIMEOUT_MS = 60_000;

/** origin/main を取りに行き、進んでいるかを返す。確認できないときは skipped に理由を入れて available: false */
export async function checkForUpdate(appDir: string): Promise<UpdateCheck> {
  const none = (skipped: string): UpdateCheck => ({ available: false, behind: 0, skipped });
  const git = await resolveBin('git');
  if (!git) return none('git が見つかりません');
  const inside = await run(git, ['rev-parse', '--is-inside-work-tree'], { cwd: appDir });
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return none('git リポジトリではありません');
  const branch = (await run(git, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: appDir })).stdout.trim();
  if (branch !== 'main') return none(`ブランチが main ではありません（${branch}）`);
  const status = await run(git, ['status', '--porcelain', '--untracked-files=no'], { cwd: appDir });
  if (status.code !== 0) return none('git status に失敗しました');
  if (status.stdout.trim() !== '') return none('手元に変更があります');
  const fetched = await run(git, ['fetch', '--quiet', 'origin', 'main'], { cwd: appDir, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (fetched.code !== 0) return none(`origin から取れませんでした（${(fetched.stderr || fetched.stdout).trim().split('\n').slice(-1)[0] ?? ''}）`);
  const count = await run(git, ['rev-list', '--count', 'HEAD..origin/main'], { cwd: appDir });
  if (count.code !== 0) return none('origin/main と比べられませんでした');
  const behind = Number(count.stdout.trim()) || 0;
  return { available: behind > 0, behind };
}

/** origin/main へ fast-forward する。できなければ false（古いコードのまま動き続ける） */
export async function applyUpdate(appDir: string, log: (message: string) => void = () => undefined): Promise<boolean> {
  const git = await resolveBin('git');
  if (!git) return false;
  const r = await run(git, ['merge', '--ff-only', '--quiet', 'origin/main'], { cwd: appDir });
  if (r.code !== 0) {
    log(`自動更新: 入れ替えに失敗しました（${(r.stderr || r.stdout).trim().split('\n').slice(-1)[0] ?? ''}）。今のまま動き続けます`);
    return false;
  }
  return true;
}
