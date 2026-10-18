import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAME_MAX_CHARS, applyName, cleanName, displayName, folderNameFor, setHeading } from './naming.ts';

describe('displayName（§14）', () => {
  it('利用者が付けた名前、なければページタイトル', () => {
    expect(displayName({ title: 'ページ', name: 'わたしの名前' })).toBe('わたしの名前');
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
    expect(cleanName(undefined)).toBeUndefined();
  });
});

describe('folderNameFor', () => {
  it('名前を先に、ID を後ろに付ける。名前が無ければ ID だけ', () => {
    expect(folderNameFor('20261018-164219-9v7h', 'デザインのプロセス')).toBe('デザインのプロセス_20261018-164219-9v7h');
    expect(folderNameFor('20261018-164219-9v7h', undefined)).toBe('20261018-164219-9v7h');
  });
});

describe('setHeading / applyName', () => {
  const sessionId = '20261018-164219-9v7h';
  const makeSession = async (root: string, folder: string) => {
    const dir = path.join(root, folder);
    await mkdir(path.join(dir, '.lecscribe'), { recursive: true });
    await writeFile(path.join(dir, 'notes.md'), '# ページ\n\n本文\n');
    await writeFile(path.join(dir, '.lecscribe', 'lecture.md'), '# ページ\n');
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
    const dir = await makeSession(root, `ページ_${sessionId}`);
    const moved = await applyName(dir, sessionId, 'デザインのプロセス');
    expect(path.basename(moved)).toBe(`デザインのプロセス_${sessionId}`);
    expect(await readdir(root)).toEqual([`デザインのプロセス_${sessionId}`]);
    expect(await readFile(path.join(moved, 'notes.md'), 'utf8')).toBe('# デザインのプロセス\n\n本文\n');
    expect(await readFile(path.join(moved, '.lecscribe', 'lecture.md'), 'utf8')).toBe('# デザインのプロセス\n');
    expect(await applyName(moved, sessionId, 'デザインのプロセス')).toBe(moved); // 変わらなければそのまま
    // 付け替え先が手で作られていたら付け替えない（見出しは変える）
    await mkdir(path.join(root, `別の名前_${sessionId}`));
    expect(await applyName(moved, sessionId, '別の名前')).toBe(moved);
    expect(await readFile(path.join(moved, 'notes.md'), 'utf8')).toBe('# 別の名前\n\n本文\n');
  });

  it('名前もページタイトルも無ければ、フォルダは ID だけ、見出しは「ノート」（ノートを作ったときと同じ）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lec-naming-'));
    const dir = await makeSession(root, `わたしの名前_${sessionId}`);
    const moved = await applyName(dir, sessionId, undefined);
    expect(path.basename(moved)).toBe(sessionId);
    expect(await readFile(path.join(moved, 'notes.md'), 'utf8')).toBe('# ノート\n\n本文\n');
    expect(await readFile(path.join(moved, '.lecscribe', 'lecture.md'), 'utf8')).toBe('# ノート\n');
  });
});
