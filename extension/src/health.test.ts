import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHealth, ForeignServerError, isLecScribeReply, outdatedMessage, REQUIRED_SERVER_API, serverOutdated, visionLine } from './health';

describe('サーバーの版の突き合わせ', () => {
  it('api を返さない古いサーバーは古いと判定する', () => {
    expect(serverOutdated({ version: '0.1.0' })).toBe(true);
    expect(outdatedMessage({ version: '0.1.0' })).toContain('古い版');
  });
  it('必要な版以上なら通じる', () => {
    expect(serverOutdated({ api: REQUIRED_SERVER_API })).toBe(false);
    expect(serverOutdated({ api: REQUIRED_SERVER_API + 1 })).toBe(false);
  });
  it('必要な版より小さければ古い。文に両方の版が入る', () => {
    const h = { api: REQUIRED_SERVER_API - 1 };
    expect(serverOutdated(h)).toBe(true);
    expect(outdatedMessage(h)).toContain(`版 ${REQUIRED_SERVER_API - 1}`);
    expect(outdatedMessage(h)).toContain(`版 ${REQUIRED_SERVER_API} が必要`);
    expect(outdatedMessage(h)).toContain('update.sh');
  });
});

describe('見た目の判定の 1 行（#17）', () => {
  it('状態を返さないサーバーには行を出さない（項目の有無は古さの判定ではなく、表示の有無）', () => {
    expect(visionLine({ api: 1 })).toBeNull();
  });
  it('状態ごとに別の文になり、導入を勧めるのは作れなかったときだけ', () => {
    expect(visionLine({ vision: 'ready' })).toBe('見た目の判定（Vision）: あり');
    expect(visionLine({ vision: 'building' })).toContain('準備中');
    expect(visionLine({ vision: 'idle' })).toContain('次の文字起こしのときに作ります');
    expect(visionLine({ vision: 'idle' })).not.toContain('xcode-select');
    expect(visionLine({ vision: 'building' })).not.toContain('xcode-select');
    const failed = visionLine({ vision: 'failed', visionReason: 'swiftc failed (1): error: invalid active developer path' });
    expect(failed).toContain('invalid active developer path');
    expect(failed).toContain('xcode-select --install');
    expect(failed).toContain('server.log');
    expect(visionLine({ vision: null })).toContain('使わない');
  });
  it('想定外の値は「分かりません」にして、CLT の導入を勧めない', () => {
    const odd = visionLine({ vision: 'false' as unknown as 'ready' });
    expect(odd).toContain('分かりません');
    expect(odd).not.toContain('xcode-select');
  });
});

describe('ポートをほかのアプリが使っているとき（§12.1d）', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (body: string, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
  const server = { port: 47321, token: '' };

  it('LecScribe の応答は JSON の ok（true / false）で見分ける', () => {
    expect(isLecScribeReply({ ok: true, version: '0.1.0' })).toBe(true);
    expect(isLecScribeReply({ ok: false, error: { code: 'UNAUTHORIZED' } })).toBe(true);
    expect(isLecScribeReply({ status: 'up' })).toBe(false);
    expect(isLecScribeReply(undefined)).toBe(false);
  });

  it('HTML や別の形の JSON が返ったら、ほかのアプリを止めるよう案内する', async () => {
    reply('<!doctype html><title>Vite</title>');
    const error = await fetchHealth(server).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForeignServerError);
    expect((error as Error).message).toBe(
      'ポート 47321 をほかのアプリが使っているため、LecScribe のサーバーを起動できません。そのアプリを終了するか、そのアプリのポートを変えてください。',
    );
    reply('{"status":"up"}', 404);
    await expect(fetchHealth(server)).rejects.toBeInstanceOf(ForeignServerError);
  });

  it('LecScribe の失敗の応答は、ほかのアプリとは扱わない', async () => {
    reply('{"ok":false,"error":{"code":"INTERNAL","message":"boom"}}', 500);
    const error = await fetchHealth(server).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ForeignServerError);
    expect((error as Error).message).toBe('HTTP 500: boom');
    reply('{"ok":true,"version":"0.1.0","api":3}');
    expect(await fetchHealth(server)).toMatchObject({ version: '0.1.0', api: 3 });
  });
});
