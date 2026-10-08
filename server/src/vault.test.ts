import { describe, expect, it } from 'vitest';
import { headerOf, imagesMentioned, matchSession, normalizeLinks, notesHash, notesUntouched, parseManifest, stripPoints } from './vault.ts';

const notes = (body: string, recorded = '2026-10-07 15:34') =>
  `# airU 京都芸術大学 - 4章｜グラフィックデザインI-4\n\n- 収録: ${recorded}\n- 元ページ: https://example.test/4\n\n## 全体の要点\n\n- 全体 1\n\n${body}`;

describe('コピー先の notes.md と LecScribe の突き合わせ（§14）', () => {
  it('Obsidian が書き換えた画像リンクを元の形に戻す（vault 内の絶対パス、ファイル名だけ）', () => {
    const md = '![a](京都芸術大学/2026/WS_X/動画/01/slides/slide_001.png)\n![b](slide_070.png)\n![c](slides/slide_002.jpg)\n[x](https://example.test/slide_999.png)';
    expect(normalizeLinks(md)).toBe('![a](slides/slide_001.png)\n![b](slides/slide_070.png)\n![c](slides/slide_002.jpg)\n[x](slides/slide_999.png)');
  });

  it('「要点」の段落を除く（最後の段落に空行が続かなくても）', () => {
    const md = '## 導入\n\n**要点**\n\n- a\n- b\n\n![s](slides/slide_001.png)\n\n本文\n\n## 終わり\n\n**要点**\n\n- c\n';
    expect(stripPoints(md)).toBe('## 導入\n\n![s](slides/slide_001.png)\n\n本文\n\n## 終わり\n\n');
  });

  it('言及している画像は、Markdown のリンク以外（<img>、wiki リンク、ファイル名だけ）も拾う', () => {
    const md = '![a](slides/slide_001.png)\n<img src="slides/slide_002.png" width="400">\n![[slide_003.png]]\n![d](slide_004.jpg)\nslide_005.png は消した';
    expect([...imagesMentioned(md)]).toEqual(['slide_001.png', 'slide_002.png', 'slide_003.png', 'slide_004.jpg', 'slide_005.png']);
  });

  it('印はリンクの形の違いを無視する', () => {
    expect(notesHash('![a](slides/slide_001.png)')).toBe(notesHash('![a](vault/x/slides/slide_001.png)'));
    expect(notesHash('![a](slides/slide_001.png)')).not.toBe(notesHash('![a](slides/slide_002.png)'));
  });

  it('記録は形が合うときだけ読む', () => {
    expect(parseManifest('{"sessionId":"20260908-103005-ab12","syncedAt":"2026-10-08T00:00:00Z"}')).toEqual({ sessionId: '20260908-103005-ab12', syncedAt: '2026-10-08T00:00:00Z' });
    expect(parseManifest('{"sessionId":"x","syncedAt":"t","notesHash":"abcd"}')?.notesHash).toBe('abcd');
    expect(parseManifest('{}')).toBeNull();
    expect(parseManifest('"x"')).toBeNull();
    expect(parseManifest('{"sessionId":"x","syncedAt":"t","notesHash":1}')).toBeNull();
    expect(parseManifest('not json')).toBeNull();
  });

  it('対応は、中身が同じ → 前回の記録 → 見出しと収録日時、の順。撮り直した別の録画は収録日時で区別する', () => {
    const a = { id: 'a', notes: notes('![s](slides/slide_001.png)\n\n本文 A') };
    const b = { id: 'b', notes: notes('![s](slides/slide_001.png)\n\n本文 B', '2026-10-01 18:53') };
    const sessions = [a, b];
    expect(matchSession(a.notes, null, sessions)).toEqual({ session: a, how: '同じ' });
    expect(matchSession(a.notes.replace('](slides/', '](vault/x/slides/'), null, sessions)).toEqual({ session: a, how: 'リンクの形だけ違う' });
    // 手で直した写し（中身が違う）は記録で、記録が無ければ見出しと収録日時で
    const edited = notes('本文 A を直した');
    expect(matchSession(edited, { sessionId: 'b', syncedAt: 't' }, sessions)).toEqual({ session: b, how: '前回の記録' });
    expect(matchSession(edited, null, sessions)).toEqual({ session: a, how: '見出しと収録日時' });
    // 同じ見出しで収録日時も同じ録画が 2 つあれば決めない
    const a2 = { id: 'a2', notes: notes('本文 A2') };
    expect(matchSession(edited, null, [a, a2])).toBeNull();
  });

  it('手で直していないかは、記録の印があれば印で、無ければリンクの形と要点の段落を除いた一致で判定する', () => {
    const session = notes('## 導入\n\n![s](slides/slide_001.png)\n\n本文');
    const old = notes('## 導入\n\n**要点**\n\n- a\n\n![s](vault/slides/slide_001.png)\n\n本文');
    expect(notesUntouched(old, null, session)).toBe(true);
    const handEdited = notes('## 導入\n\n本文'); // 画像の行を消した
    expect(notesUntouched(handEdited, null, session)).toBe(false);
    // 記録があればそれが優先。印が合えば中身が LecScribe と違っていても（やり直しで変わった）直していない
    const manifest = { sessionId: 'a', syncedAt: 't', notesHash: notesHash(old) };
    expect(notesUntouched(old, manifest, 'まったく別の中身')).toBe(true);
    expect(notesUntouched(handEdited, manifest, session)).toBe(false);
  });

  it('先頭の段落（見出し・収録・元ページ）を取り出す', () => {
    expect(headerOf(notes('x'))).toBe('# airU 京都芸術大学 - 4章｜グラフィックデザインI-4\n\n- 収録: 2026-10-07 15:34\n- 元ページ: https://example.test/4');
  });
});
