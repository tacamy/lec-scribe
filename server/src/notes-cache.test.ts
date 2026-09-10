import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { workPath } from './layout.ts';
import { cacheKey, deriveFromCache, NOTES_CACHE_FILE, readNotesCache, writeNotesCache } from './notes-cache.ts';

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

describe('deriveFromCache（節の区切りだけ変わったときの組み替え）', () => {
  const cache = {
    key: 'old',
    generatedAt: '2026-09-10T00:00:00.000Z',
    backend: 'codex',
    inputs: [
      { id: 'intro', text: 'はじめに。' },
      { id: 'slide_001', text: '一枚目。' },
      { id: 'slide_002', text: '二枚目。' },
      { id: 'slide_003', text: '' },
      { id: 'slide_004', text: '四枚目。' },
    ],
    polished: [
      { id: 'intro', text: '整えた はじめに。' },
      { id: 'slide_001', text: '整えた 一枚目。' },
      { id: 'slide_002', text: '整えた 二枚目。' },
      { id: 'slide_003', text: '' },
      { id: 'slide_004', text: '整えた 四枚目。' },
    ],
    outline: {
      overview: ['全体'],
      topics: [
        { heading: '導入', summary: ['a'], startId: 'intro' },
        { heading: '本題', summary: ['b'], startId: 'slide_002' },
        { heading: '終わり', summary: ['c'], startId: 'slide_004' },
      ],
    },
  };

  it('画像を外して節がつながったら、整えた本文もつなぎ、話題の区切りを付け替える', () => {
    // slide_002 を載せなくなり、その発話が slide_001 に続いた。slide_003（無音）はそのまま
    const inputs = [
      { id: 'intro', text: 'はじめに。' },
      { id: 'slide_001', text: '一枚目。二枚目。' },
      { id: 'slide_003', text: '' },
      { id: 'slide_004', text: '四枚目。' },
    ];
    const d = deriveFromCache(cache, inputs);
    expect(d.unmatched).toEqual([]);
    expect(d.polished.get('slide_001')?.text).toBe('整えた 一枚目。\n\n整えた 二枚目。');
    expect(d.polished.get('slide_003')?.text).toBe('');
    // slide_002 で始まっていた話題は slide_001 に付け替わるが、導入と同じ節になるので 1 つに減る… ではなく別の節なので残る
    expect(d.outline?.topics.map((t) => t.startId)).toEqual(['intro', 'slide_001', 'slide_004']);
  });

  it('本文が変わった節は組み替えられず、呼び出し側に任せる', () => {
    const inputs = [
      { id: 'intro', text: 'はじめに。' },
      { id: 'slide_001', text: '一枚目（言い直し）。' },
      { id: 'slide_002', text: '二枚目。' },
      { id: 'slide_003', text: '' },
      { id: 'slide_004', text: '四枚目。' },
    ];
    const d = deriveFromCache(cache, inputs);
    expect(d.unmatched).toEqual(['slide_001']);
    expect(d.polished.has('intro')).toBe(true);
    expect(d.polished.has('slide_004')).toBe(true);
    expect(d.outline).toBeUndefined(); // 一部でも作り直すなら話題の区切りも作り直す
  });

  it('前回の入力が残っていない古いキャッシュからは何も組み替えない', () => {
    const d = deriveFromCache({ ...cache, inputs: undefined }, [{ id: 'intro', text: 'はじめに。' }]);
    expect(d.unmatched).toEqual(['intro']);
  });
});
