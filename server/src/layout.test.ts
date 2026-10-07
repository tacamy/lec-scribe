import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOTES_FILE, SLIDES_DIR, UNUSED_DIR, WORK_DIR, restoreUnusedSlides, slidesInNotes, tidyUnusedSlides } from './layout.ts';

describe('notes.md に載せなかった画像の片付け（§14）', () => {
  let dir: string;
  const slides = () => path.join(dir, SLIDES_DIR);
  const unused = () => path.join(dir, WORK_DIR, UNUSED_DIR);
  const names = async (folder: string) => (await readdir(folder).catch(() => [] as string[])).sort();
  const put = async (folder: string, name: string, body = name) => {
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, name), body);
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-layout-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('notes.md が参照する画像の名前を拾う（png / jpg。lecture.md の ../slides/ も同じ形）', () => {
    const notes = ['![slide_001](slides/slide_001.png)', 'text', '![slide_012](slides/slide_012.jpg)', '![x](slides/evil.sh)'].join('\n');
    expect([...slidesInNotes(notes)]).toEqual(['slide_001.png', 'slide_012.jpg']);
  });

  it('notes.md に無い画像だけを .lecscribe/unused/ へ移し、拡張の名前でないファイルは触らない', async () => {
    for (const n of ['slide_001.png', 'slide_002.png', 'slide_003.png', 'slide_004.jpg']) await put(slides(), n);
    await put(slides(), 'slide_005.png.part');
    await put(slides(), 'memo.txt');
    await writeFile(path.join(dir, NOTES_FILE), '![slide_001](slides/slide_001.png)\n\n![slide_004](slides/slide_004.jpg)\n');
    expect(await tidyUnusedSlides(dir)).toEqual({ moved: 2, kept: 2 });
    expect(await names(slides())).toEqual(['memo.txt', 'slide_001.png', 'slide_004.jpg', 'slide_005.png.part']);
    expect(await names(unused())).toEqual(['slide_002.png', 'slide_003.png']);
    // もう一度呼んでも何も動かない
    expect(await tidyUnusedSlides(dir)).toEqual({ moved: 0, kept: 2 });
  });

  it('notes.md が無ければ何もしない（処理の前に失敗した初回など）', async () => {
    await put(slides(), 'slide_001.png');
    expect(await tidyUnusedSlides(dir)).toBeNull();
    expect(await names(slides())).toEqual(['slide_001.png']);
    expect(await names(unused())).toEqual([]);
  });

  it('片付けた画像を slides/ に戻す。送り直されて同じ名前がある画像は、片付けていた方を捨てる', async () => {
    await put(unused(), 'slide_002.png', 'old');
    await put(unused(), 'slide_003.png');
    await put(slides(), 'slide_001.png');
    await put(slides(), 'slide_002.png', 'new'); // 「文字起こしする」で送り直された方
    expect(await restoreUnusedSlides(dir)).toBe(1);
    expect(await names(slides())).toEqual(['slide_001.png', 'slide_002.png', 'slide_003.png']);
    expect(await readFile(path.join(slides(), 'slide_002.png'), 'utf8')).toBe('new');
    expect(await names(unused())).toEqual([]);
    // 片付けたものが無ければ 0
    expect(await restoreUnusedSlides(dir)).toBe(0);
  });

  it('戻す → notes.md が変わる → 片付ける、で slides/ はいつも notes.md と対応する（やり直す）', async () => {
    for (const n of ['slide_001.png', 'slide_002.png', 'slide_003.png']) await put(slides(), n);
    await writeFile(path.join(dir, NOTES_FILE), '![slide_001](slides/slide_001.png)\n');
    await tidyUnusedSlides(dir);
    expect(await names(slides())).toEqual(['slide_001.png']);
    // やり直すと、処理の前に全部戻り、新しい notes.md（002 が載り 001 が外れた）に合わせて片付く
    expect(await restoreUnusedSlides(dir)).toBe(2);
    expect(await names(slides())).toEqual(['slide_001.png', 'slide_002.png', 'slide_003.png']);
    await writeFile(path.join(dir, NOTES_FILE), '![slide_002](slides/slide_002.png)\n');
    expect(await tidyUnusedSlides(dir)).toEqual({ moved: 2, kept: 1 });
    expect(await names(slides())).toEqual(['slide_002.png']);
    expect(await names(unused())).toEqual(['slide_001.png', 'slide_003.png']);
  });
});
