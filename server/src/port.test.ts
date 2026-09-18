import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PORT_IN_USE_MARK, portHolder, portInUseMessage } from './port.ts';

async function stub(body: string): Promise<string> {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-port-')), 'lsof');
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

describe('ポートがほかのアプリに使われているとき（§12.1d）', () => {
  it('相手の名前が分かれば名前を入れ、分からなければ「ほかのアプリ」と書く', () => {
    expect(portInUseMessage(47321, 'Figma')).toBe(
      'ポート 47321 を「Figma」が使っているため、LecScribe のサーバーを起動できません。Figmaを終了するか、Figmaのポートを変えてください。',
    );
    expect(portInUseMessage(47321, null)).toBe(
      'ポート 47321 をほかのアプリが使っているため、LecScribe のサーバーを起動できません。そのアプリを終了するか、そのアプリのポートを変えてください。',
    );
    // agent.mjs はこの一文でログから探す
    expect(portInUseMessage(1, null)).toContain(PORT_IN_USE_MARK);
  });

  it('lsof の「c<名前>」の行から名前を取る。見えない・lsof が無いときは null', async () => {
    expect(await portHolder(47321, await stub("printf 'p4242\\ncVisual Studio Code Helper\\n'"))).toBe('Visual Studio Code Helper');
    expect(await portHolder(47321, await stub('exit 1'))).toBeNull();
    expect(await portHolder(47321, '/nonexistent/lsof')).toBeNull();
  });
});
