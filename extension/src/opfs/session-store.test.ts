import { describe, expect, it } from 'vitest';
import { NAME_MAX_CHARS, normalizeSessionName, sessionName } from './session-store';

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

describe('normalizeSessionName（サーバーの cleanName が受け付ける形に揃える、§14）', () => {
  it('前後の空白を落とし、空なら null。改行・タブは空白、100 文字（code point）まで', () => {
    expect(normalizeSessionName(' デザインのプロセス ')).toBe('デザインのプロセス');
    expect(normalizeSessionName('   ')).toBeNull();
    expect(normalizeSessionName('タブ\tあり')).toBe('タブ あり');
    expect(normalizeSessionName('一行目\n二行目')).toBe('一行目 二行目');
    expect(normalizeSessionName('あ'.repeat(NAME_MAX_CHARS + 5))).toBe('あ'.repeat(NAME_MAX_CHARS));
    // 絵文字（UTF-16 では 2 単位）も 1 文字と数える
    expect(Array.from(normalizeSessionName('😀'.repeat(NAME_MAX_CHARS + 1))!)).toHaveLength(NAME_MAX_CHARS);
  });
});
