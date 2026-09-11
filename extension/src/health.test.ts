import { describe, expect, it } from 'vitest';
import { outdatedMessage, REQUIRED_SERVER_API, serverOutdated, visionLine } from './health';

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
