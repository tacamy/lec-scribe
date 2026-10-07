import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOTES_FILE, SLIDES_DIR, WORK_DIR, migrateLayout, slidesInNotes, slidesSourcePath, syncSlides } from './layout.ts';

describe('slides/ には notes.md に載せた画像だけを写す（§14）', () => {
  let dir: string;
  const slides = () => path.join(dir, SLIDES_DIR);
  const source = () => slidesSourcePath(dir);
  const names = async (folder: string) => (await readdir(folder).catch(() => [] as string[])).sort();
  const put = async (folder: string, name: string, body = name) => {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, name), body);
  };
  const notes = (...images: string[]) => writeFile(path.join(dir, NOTES_FILE), images.map((n) => `![${n}](slides/${n})`).join('\n\n'));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-layout-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ノートが参照する画像の名前を拾う（png / jpg。利用者が書き換えた <img> も）', () => {
    const text = [
      '![slide_001](slides/slide_001.png)',
      'text',
      '![slide_012](slides/slide_012.jpg)',
      '![x](slides/evil.sh)',
      '<img src="slides/slide_033.png" width="400">',
    ].join('\n');
    expect([...slidesInNotes(text)]).toEqual(['slide_001.png', 'slide_012.jpg', 'slide_033.png']);
  });

  it('載せた画像を正本から写し、載せていない画像を slides/ から消す。拡張の名前でないファイルは触らない', async () => {
    for (const n of ['slide_001.png', 'slide_002.png', 'slide_003.png', 'slide_004.jpg']) await put(source(), n);
    await put(slides(), 'slide_002.png'); // 前回載せていた
    await put(slides(), 'slide_005.png.part');
    await put(slides(), 'memo.txt');
    await notes('slide_001.png', 'slide_004.jpg');
    expect(await syncSlides(dir)).toEqual({ copied: 2, kept: 0, removed: 1, missing: 0 });
    expect(await names(slides())).toEqual(['memo.txt', 'slide_001.png', 'slide_004.jpg', 'slide_005.png.part']);
    expect(await readFile(path.join(slides(), 'slide_001.png'), 'utf8')).toBe('slide_001.png');
    // 正本は全部そのまま
    expect(await names(source())).toEqual(['slide_001.png', 'slide_002.png', 'slide_003.png', 'slide_004.jpg']);
    // もう一度呼んでも写し直さない
    expect(await syncSlides(dir)).toEqual({ copied: 0, kept: 2, removed: 0, missing: 0 });
  });

  it('notes.md が無ければ何もしない（処理の前に失敗した初回など）', async () => {
    await put(source(), 'slide_001.png');
    expect(await syncSlides(dir)).toBeNull();
    expect(await names(slides())).toEqual([]);
  });

  it('正本に無い名前は飛ばし、古い写しがあれば残す', async () => {
    await put(source(), 'slide_001.png');
    await put(slides(), 'slide_002.png', 'old copy');
    await notes('slide_001.png', 'slide_002.png');
    expect(await syncSlides(dir)).toEqual({ copied: 1, kept: 0, removed: 0, missing: 1 });
    expect(await names(slides())).toEqual(['slide_001.png', 'slide_002.png']);
    expect(await readFile(path.join(slides(), 'slide_002.png'), 'utf8')).toBe('old copy');
  });

  it('正本が送り直されて変わっていれば写し直す', async () => {
    await put(source(), 'slide_001.png', 'v1');
    await notes('slide_001.png');
    await syncSlides(dir);
    // 送り直しで中身が変わった（大きさが違う）
    await put(source(), 'slide_001.png', 'v2 longer');
    expect(await syncSlides(dir)).toMatchObject({ copied: 1, kept: 0 });
    expect(await readFile(path.join(slides(), 'slide_001.png'), 'utf8')).toBe('v2 longer');
    // 同じ大きさでも正本の方が新しければ写し直す
    await put(source(), 'slide_001.png', 'v3 longer');
    await utimes(path.join(slides(), 'slide_001.png'), new Date(0), new Date(0));
    expect(await syncSlides(dir)).toMatchObject({ copied: 1, kept: 0 });
    expect(await readFile(path.join(slides(), 'slide_001.png'), 'utf8')).toBe('v3 longer');
  });

  it('やり直して載せる画像が変わると、slides/ はいつも notes.md と対応する', async () => {
    for (const n of ['slide_001.png', 'slide_002.png', 'slide_003.png']) await put(source(), n);
    await notes('slide_001.png');
    await syncSlides(dir);
    expect(await names(slides())).toEqual(['slide_001.png']);
    await notes('slide_002.png', 'slide_003.png');
    expect(await syncSlides(dir)).toEqual({ copied: 2, kept: 0, removed: 1, missing: 0 });
    expect(await names(slides())).toEqual(['slide_002.png', 'slide_003.png']);
  });

  it('旧配置（slides/ に全画像）は正本へ移し、notes.md に合わせて写し直せる。新配置では何も動かさない', async () => {
    for (const n of ['slide_001.png', 'slide_002.png', 'slide_003.png']) await put(slides(), n);
    await put(dir, 'session.json', '{}'); // 2026-09-09 より前の作業ファイルも一緒に
    await notes('slide_002.png');
    expect(await migrateLayout(dir)).toEqual(['session.json', 'slides/slide_001.png', 'slides/slide_002.png', 'slides/slide_003.png']);
    expect(await names(source())).toEqual(['slide_001.png', 'slide_002.png', 'slide_003.png']);
    expect(await names(slides())).toEqual([]);
    expect(await names(path.join(dir, WORK_DIR))).toContain('session.json');
    expect(await syncSlides(dir)).toEqual({ copied: 1, kept: 0, removed: 0, missing: 0 });
    expect(await names(slides())).toEqual(['slide_002.png']);
    // 新配置になったあとは、slides/ の写しは正本にもあるので移さない
    expect(await migrateLayout(dir)).toEqual([]);
    expect(await names(slides())).toEqual(['slide_002.png']);
  });

  it('slides/ が読めない（権限）ときは黙って進まず投げる', async () => {
    await put(source(), 'slide_001.png');
    await put(slides(), 'slide_001.png');
    await notes('slide_001.png');
    await chmod(slides(), 0o000);
    try {
      await expect(syncSlides(dir)).rejects.toThrow();
    } finally {
      await chmod(slides(), 0o700);
    }
  });
});
