import { describe, expect, it } from 'vitest';
import { sessionName } from './session-store';

describe('sessionName（一覧に出す名前、§14）', () => {
  const meta = { sessionId: '20261018-164219-9v7h', startedAt: '2026-10-18T07:42:19.466Z', title: 'airU 京都芸術大学 - 教材提供' };
  it('利用者が付けた名前、なければページの題名', () => {
    expect(sessionName({ meta: { ...meta, name: 'デザインのプロセス' } })).toBe('デザインのプロセス');
    expect(sessionName({ meta })).toBe('airU 京都芸術大学 - 教材提供');
    expect(sessionName({ meta: { ...meta, name: '  ' } })).toBe('airU 京都芸術大学 - 教材提供');
    expect(sessionName({ meta: { ...meta, title: ' ' } })).toBeUndefined();
    expect(sessionName({})).toBeUndefined();
  });
});
