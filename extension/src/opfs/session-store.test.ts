import { describe, expect, it } from 'vitest';
import { NAME_MAX_CHARS, checkSessionName, sessionName } from './session-store';

describe('sessionName（一覧に出す名前、§14）', () => {
  const meta = { sessionId: '20261018-164219-9v7h', startedAt: '2026-10-18T07:42:19.466Z', title: 'airU 京都芸術大学 - 教材提供' };
  it('利用者が付けた名前、なければページタイトル', () => {
    expect(sessionName({ meta: { ...meta, name: 'デザインのプロセス' } })).toBe('デザインのプロセス');
    expect(sessionName({ meta })).toBe('airU 京都芸術大学 - 教材提供');
    expect(sessionName({ meta: { ...meta, name: '  ' } })).toBe('airU 京都芸術大学 - 教材提供');
    expect(sessionName({ meta: { ...meta, title: ' ' } })).toBeUndefined();
    expect(sessionName({})).toBeUndefined();
  });
});

describe('checkSessionName（サーバーの cleanName と同じ条件、§14）', () => {
  it('前後の空白を落とし、空なら null、長すぎ・改行・タブは undefined', () => {
    expect(checkSessionName(' デザインのプロセス ')).toBe('デザインのプロセス');
    expect(checkSessionName('   ')).toBeNull();
    expect(checkSessionName('タブ\tあり')).toBeUndefined();
    expect(checkSessionName('一行目\n二行目')).toBeUndefined();
    expect(checkSessionName('あ'.repeat(NAME_MAX_CHARS))).toBe('あ'.repeat(NAME_MAX_CHARS));
    expect(checkSessionName('あ'.repeat(NAME_MAX_CHARS + 1))).toBeUndefined();
  });
});
