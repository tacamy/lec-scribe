import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAME_MAX_CHARS, applyName, autoNameFor, cleanName, displayName, folderNameFor, sameTitleSessions, setHeading } from './naming.ts';

describe('displayName（§14）', () => {
  it('利用者が付けた名前、自動の名前、ページの題名の順', () => {
    expect(displayName({ title: 'ページ', autoName: 'ページ - 動画', name: 'わたしの名前' })).toBe('わたしの名前');
    expect(displayName({ title: 'ページ', autoName: 'ページ - 動画' })).toBe('ページ - 動画');
    expect(displayName({ title: ' ページ ' })).toBe('ページ');
    expect(displayName({ title: 'ページ', name: '  ' })).toBe('ページ');
    expect(displayName({})).toBeUndefined();
    expect(displayName(undefined)).toBeUndefined();
  });
});

describe('cleanName', () => {
  it('空・null は外す（null）、改行・長すぎ・文字列でないものは受け付けない（undefined）', () => {
    expect(cleanName(' 第1回 デザインのプロセス ')).toBe('第1回 デザインのプロセス');
    expect(cleanName('')).toBeNull();
    expect(cleanName('   ')).toBeNull();
    expect(cleanName(null)).toBeNull();
    expect(cleanName('一行目\n二行目')).toBeUndefined();
    expect(cleanName('タブ\tあり')).toBeUndefined();
    expect(cleanName('あ'.repeat(NAME_MAX_CHARS))).toBe('あ'.repeat(NAME_MAX_CHARS));
    expect(cleanName('あ'.repeat(NAME_MAX_CHARS + 1))).toBeUndefined();
    expect(cleanName(42)).toBeUndefined();
  });
});

describe('autoNameFor', () => {
  it('ページの題名のあとに動画の題名を足す。動画の題名がページの題名に含まれていれば足さない', () => {
    expect(autoNameFor('airU 京都芸術大学 - 教材提供', 'デザインのプロセス')).toBe('airU 京都芸術大学 - 教材提供 - デザインのプロセス');
    expect(autoNameFor('airU 京都芸術大学 - 教材提供', '教材提供')).toBeUndefined();
    expect(autoNameFor(undefined, 'デザインのプロセス')).toBe('デザインのプロセス');
    expect(autoNameFor('ページ', undefined)).toBeUndefined();
    expect(autoNameFor('ページ', '  ')).toBeUndefined();
  });
});

describe('folderNameFor', () => {
  it('名前を先に、ID を後ろに付ける。名前が無ければ ID だけ', () => {
    expect(folderNameFor('20261018-164219-9v7h', 'airU 京都芸術大学 - 教材提供 - デザインのプロセス')).toBe('airU_京都芸術大学_教材提供_デザインのプロセス_20261018-164219-9v7h');
    expect(folderNameFor('20261018-164219-9v7h', undefined)).toBe('20261018-164219-9v7h');
  });
});

describe('setHeading / applyName / sameTitleSessions', () => {
  const sessionId = '20261018-164219-9v7h';
  const makeSession = async (root: string, folder: string, info: object) => {
    const dir = path.join(root, folder);
    await mkdir(path.join(dir, '.lecscribe'), { recursive: true });
    await writeFile(path.join(dir, '.lecscribe', 'session.json'), JSON.stringify(info));
    return dir;
  };

  it('setHeading は 1 行目の見出しだけを書き換える', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lec-naming-'));
    const file = path.join(root, 'notes.md');
    await writeFile(file, '# 古い名前\n\n- 収録: 2026-10-18\n\n# 本文の中の見出し\n');
    expect(await setHeading(file, '新しい名前')).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('# 新しい名前\n\n- 収録: 2026-10-18\n\n# 本文の中の見出し\n');
    expect(await setHeading(file, '新しい名前')).toBe(false); // 同じなら書かない
    await writeFile(file, '見出しのないファイル\n');
    expect(await setHeading(file, '新しい名前')).toBe(false);
    expect(await setHeading(path.join(root, 'none.md'), '新しい名前')).toBe(false);
  });

  it('applyName は見出しを書き換えてフォルダ名を付け替え、付け替え先があれば付け替えない', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lec-naming-'));
    const dir = await makeSession(root, `ページ_${sessionId}`, { sessionId, title: 'ページ' });
    await writeFile(path.join(dir, 'notes.md'), '# ページ\n\n本文\n');
    await writeFile(path.join(dir, '.lecscribe', 'lecture.md'), '# ページ\n');
    const moved = await applyName(dir, sessionId, 'ページ - 動画の題名');
    expect(path.basename(moved)).toBe(`ページ_動画の題名_${sessionId}`);
    expect(await readdir(root)).toEqual([`ページ_動画の題名_${sessionId}`]);
    expect(await readFile(path.join(moved, 'notes.md'), 'utf8')).toBe('# ページ - 動画の題名\n\n本文\n');
    expect(await readFile(path.join(moved, '.lecscribe', 'lecture.md'), 'utf8')).toBe('# ページ - 動画の題名\n');
    expect(await applyName(moved, sessionId, 'ページ - 動画の題名')).toBe(moved); // 変わらなければそのまま
    // 付け替え先が手で作られていたら付け替えない（見出しは変える）
    await mkdir(path.join(root, `別の名前_${sessionId}`));
    expect(await applyName(moved, sessionId, '別の名前')).toBe(moved);
    expect(await readFile(path.join(moved, 'notes.md'), 'utf8')).toBe('# 別の名前\n\n本文\n');
  });

  it('sameTitleSessions はページの題名が同じほかの講義のフォルダを返す（自分と題名の無いものは除く）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lec-naming-'));
    const self = await makeSession(root, 'a', { sessionId: 'a', title: '教材提供' });
    const same = await makeSession(root, 'b', { sessionId: 'b', title: ' 教材提供 ' });
    await makeSession(root, 'c', { sessionId: 'c', title: '7章' });
    await makeSession(root, 'd', { sessionId: 'd' });
    await mkdir(path.join(root, 'e')); // session.json の無いフォルダ
    await writeFile(path.join(root, 'f.txt'), 'x');
    expect(await sameTitleSessions(root, self, '教材提供')).toEqual([same]);
    expect(await sameTitleSessions(root, self, '')).toEqual([]);
    expect(await sameTitleSessions(path.join(root, 'missing'), self, '教材提供')).toEqual([]);
  });
});
