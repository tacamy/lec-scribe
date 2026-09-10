import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { workPath } from './layout.ts';
import { cacheKey, NOTES_CACHE_FILE, readNotesCache, writeNotesCache } from './notes-cache.ts';

const sections = [
  { id: 'intro', text: '今日は色の話です。' },
  { id: 'slide_001', text: '色の働きから話します。' },
];
const settings = { kind: 'codex', model: '', charsPerCall: 4000 };

describe('cacheKey', () => {
  it('本文も設定も同じなら同じ鍵、どれかが変われば別の鍵', () => {
    const key = cacheKey(sections, settings);
    expect(cacheKey(sections, settings)).toBe(key);
    expect(cacheKey([...sections, { id: 'slide_002', text: '追加' }], settings)).not.toBe(key);
    expect(cacheKey([{ id: 'intro', text: '別の本文' }, sections[1]!], settings)).not.toBe(key);
    expect(cacheKey(sections, { ...settings, kind: 'ollama' })).not.toBe(key);
    expect(cacheKey(sections, { ...settings, model: 'gpt-5-mini' })).not.toBe(key);
    expect(cacheKey(sections, { ...settings, charsPerCall: 2000 })).not.toBe(key);
  });

  it('節の区切り方が違えば別の鍵（本文をつなげただけでは同じにならない）', () => {
    const joined = [{ id: 'intro', text: '今日は色の話です。色の働きから話します。' }];
    expect(cacheKey(joined, settings)).not.toBe(cacheKey(sections, settings));
  });
});

describe('readNotesCache', () => {
  const cache = {
    key: cacheKey(sections, settings),
    generatedAt: '2026-09-10T00:00:00.000Z',
    backend: 'codex',
    polished: [{ id: 'intro', text: '今日は色についてお話しします。' }],
    outline: { overview: ['色の基礎'], topics: [{ heading: '導入', summary: ['色の役割'], startId: 'intro' }] },
  };

  it('鍵が合えば読み、合わなければ null', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-cache-'));
    await mkdir(workPath(dir), { recursive: true });
    await writeNotesCache(dir, cache);
    const read = await readNotesCache(dir, cache.key);
    expect(read?.polished).toEqual(cache.polished);
    expect(read?.outline).toEqual(cache.outline);
    expect(await readNotesCache(dir, 'ちがう鍵')).toBeNull();
  });

  it('ファイルがない・壊れているときは null（呼び直しに倒す）', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-cache-'));
    expect(await readNotesCache(dir, cache.key)).toBeNull();
    await mkdir(workPath(dir), { recursive: true });
    await writeFile(workPath(dir, NOTES_CACHE_FILE), '{ 壊れた JSON');
    expect(await readNotesCache(dir, cache.key)).toBeNull();
  });
});
