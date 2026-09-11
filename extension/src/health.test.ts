import { describe, expect, it } from 'vitest';
import { outdatedMessage, REQUIRED_SERVER_API, serverOutdated } from './health';

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
