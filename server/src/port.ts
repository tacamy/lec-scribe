import { run } from './exec.ts';

/**
 * ポートがほかのアプリに使われていて待ち受けられないとき（EADDRINUSE）の知らせ（SPEC §12.1d）。
 * 設定画面にポートの欄は置かないので、利用者にできるのは相手のアプリを止めるか、相手のポートを変えること。
 * 相手はたいてい自分で起動した開発用のサーバーで、ポートを選び直せる
 */

/** 文言は agent.mjs（ターミナルに出す）がログから探すので、この一文を変えるときは agent.mjs の PORT_IN_USE_MARK もそろえる */
export const PORT_IN_USE_MARK = 'LecScribe のサーバーを起動できません';

export function portInUseMessage(port: number, holder: string | null): string {
  return holder
    ? `ポート ${port} を「${holder}」が使っているため、${PORT_IN_USE_MARK}。${holder}を終了するか、${holder}のポートを変えてください。`
    : `ポート ${port} をほかのアプリが使っているため、${PORT_IN_USE_MARK}。そのアプリを終了するか、そのアプリのポートを変えてください。`;
}

/**
 * そのポートで待ち受けているプロセスの名前（lsof）。分からなければ null。
 * 別のユーザーのプロセスは見えないので、そのときも null になる
 */
export async function portHolder(port: number, lsofBin = '/usr/sbin/lsof'): Promise<string | null> {
  try {
    // +c 0: 名前を 9 文字で切らない。-F c: 「c<名前>」の行だけを出す
    const r = await run(lsofBin, ['+c', '0', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'c']);
    const name = r.stdout
      .split('\n')
      .find((line) => line.startsWith('c'))
      ?.slice(1)
      .trim();
    return name || null;
  } catch {
    return null;
  }
}
