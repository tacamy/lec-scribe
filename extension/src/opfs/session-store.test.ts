import { describe, expect, it } from 'vitest';
import { sessionName } from './session-store';

describe('sessionName（一覧に出す名前、§14）', () => {
  const meta = { sessionId: '20261018-164219-9v7h', startedAt: '2026-10-18T07:42:19.466Z', title: 'airU 京都芸術大学 - 教材提供' };
  it('利用者が付けた名前、サーバーが決めた名前、ページの題名の順', () => {
    expect(sessionName({ meta: { ...meta, name: 'デザインのプロセス' }, status: { stage: 'done', name: 'airU 京都芸術大学 - 教材提供 - 自動' } })).toBe('デザインのプロセス');
    expect(sessionName({ meta, status: { stage: 'done', name: 'airU 京都芸術大学 - 教材提供 - 自動' } })).toBe('airU 京都芸術大学 - 教材提供 - 自動');
    expect(sessionName({ meta, status: { stage: 'captured' } })).toBe('airU 京都芸術大学 - 教材提供');
    expect(sessionName({ meta: { ...meta, name: '  ', title: ' ' } })).toBeUndefined();
    expect(sessionName({})).toBeUndefined();
  });
});
