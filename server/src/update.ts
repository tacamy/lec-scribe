import { resolveBin, run } from './exec.ts';

/**
 * サーバー自身の更新（SPEC §12.1b）。
 *
 * 拡張は Chrome ウェブストアが更新するが、Mac 側のサーバーは ~/LecScribe-app/ に置いた git の作業ツリーなので、
 * 何もしなければ古いまま残る。新旧が組むと新しい機能が黙って効かなくなるので、起動時に取りに行く。
 *
 * **listen する前に済ませる**のが要点。まだ誰も繋がっていないので、処理中の待ち合わせも、
 * 「更新中です」を拡張に伝える仕組みも、入れ替え後に古いコードで応答し続ける時間も要らない。
 * 入れ替えたら終了し、launchd（KeepAlive）が新しいコードで起動し直す。利用者から見ると
 * 起動が数秒遅いだけで、サーバーが動き出したときにはもう新しい。
 *
 * 何が起きても投げない。ネットワークが悪い・git が無い・作業ツリーが汚れている、のどれでも
 * 「今回は見送る」と記録して普通に起動する（投げるとプロセスが落ち、launchd が起動し直して
 * 同じところで落ちる無限ループになる）。
 */

export type UpdateResult =
  /** 入れ替えた。呼び出し側は終了して launchd に起動し直させる */
  | { updated: true; behind: number }
  /** 何もしなかった。reason は記録用（最新だった、開発機だった、取りに行けなかった） */
  | { updated: false; reason: string };

/** git fetch の待ち時間。ログイン直後で Wi-Fi がまだ繋がっていないことがあるので短くする */
const FETCH_TIMEOUT_MS = 20_000;

type Options = {
  /** サーバーのコードがある git の作業ツリー */
  appDir: string;
  /** 追いかけるブランチ（install.sh の LEC_SCRIBE_BRANCH と同じ） */
  branch: string;
  gitBin: string;
  log: (message: string) => void;
};

export async function selfUpdate(options: Options): Promise<UpdateResult> {
  try {
    return await update(options);
  } catch (e) {
    // ここに来るのは spawn の失敗や fetch の打ち切り。起動そのものは続ける
    return { updated: false, reason: `確認できませんでした（${e instanceof Error ? e.message : String(e)}）` };
  }
}

async function update({ appDir, branch, gitBin, log }: Options): Promise<UpdateResult> {
  const skip = (reason: string): UpdateResult => ({ updated: false, reason });
  const git = await resolveBin(gitBin);
  if (!git) return skip(`${gitBin} が見つかりません`);
  const at = (args: string[], signal?: AbortSignal) => run(git, args, { cwd: appDir, ...(signal ? { signal } : {}) });

  // 開発機を壊さないための確認。追いかけるブランチにいて、手元に変更が無いときだけ触る
  const inside = await at(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return skip('git の作業ツリーではありません');
  const head = await at(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.code !== 0) return skip('今のブランチを読めませんでした');
  if (head.stdout.trim() !== branch) return skip(`ブランチが ${branch} ではありません（${head.stdout.trim()}）`);
  const status = await at(['status', '--porcelain', '--untracked-files=no']);
  if (status.code !== 0) return skip('git status に失敗しました');
  if (status.stdout.trim() !== '') return skip('手元に変更があります');

  const fetched = await at(['fetch', '--quiet', 'origin', branch], AbortSignal.timeout(FETCH_TIMEOUT_MS));
  if (fetched.code !== 0) return skip(`origin から取れませんでした（${lastLine(fetched)}）`);
  const count = await at(['rev-list', '--count', `HEAD..FETCH_HEAD`]);
  const behind = count.code === 0 ? Number(count.stdout.trim()) : Number.NaN;
  if (!Number.isFinite(behind)) return skip('origin と比べられませんでした');
  if (behind === 0) return skip('最新です');

  log(`自動更新: 新しい版があります（${behind} コミット）。入れ替えます`);
  const merged = await at(['merge', '--ff-only', '--quiet', 'FETCH_HEAD']);
  if (merged.code !== 0) return skip(`入れ替えに失敗しました（${lastLine(merged)}）。今のまま起動します`);
  return { updated: true, behind };
}

/** git の出力から最後の 1 行（失敗の理由が入っていることが多い） */
function lastLine(r: { stdout: string; stderr: string }): string {
  const lines = (r.stderr || r.stdout).trim().split('\n');
  return lines[lines.length - 1] ?? '';
}
