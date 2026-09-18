import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addTrusted, loadTrusted, pairMessage, removeTrusted, type TrustedEntry } from './pairing.ts';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const entry = (id: string, token: string, name = 'LecScribe'): TrustedEntry => ({ id, token, name, at: '' });

describe('trusted.json', () => {
  it('同じ拡張 ID の承認を別々に読み込み、足しても消しても、ほかの承認には触らない', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-pairing-')), 'trusted.json');
    await writeFile(
      file,
      JSON.stringify({ extensions: [entry(A, 't'.repeat(32)), entry(A, 'u'.repeat(32)), entry('bad', 'v'.repeat(32)), entry(B, 'short')] }),
    );
    const trusted = await loadTrusted(file);
    expect(trusted.entries.map((e) => e.token)).toEqual(['t'.repeat(32), 'u'.repeat(32)]);

    const added = await addTrusted(trusted, A, 'LecScribe');
    expect(trusted.entries).toHaveLength(3);
    await removeTrusted(trusted, trusted.entries[0]!);
    const saved = JSON.parse(await readFile(file, 'utf8')) as { extensions: TrustedEntry[] };
    expect(saved.extensions.map((e) => e.token)).toEqual(['u'.repeat(32), added.token]);
    expect((await loadTrusted(file)).entries).toEqual(trusted.entries);
  });
});

describe('pairMessage', () => {
  it('接続済みの拡張がなければ、許可したときにできることだけを書く', () => {
    const text = pairMessage('LecScribe', A, '/Users/me/LecScribe', []);
    expect(text).toContain(`ID: ${A}`);
    expect(text).not.toContain('接続済み');
  });

  it('同じ ID が接続済みなら、入れ直しや別プロファイルでなければ許可しないよう書く', () => {
    expect(pairMessage('LecScribe', A, '/out', [entry(A, 't'.repeat(32))])).toContain('この ID の拡張はすでに接続済みです');
  });

  it('別の ID が接続済みなら、その名前と ID を書く', () => {
    const text = pairMessage('LecScribe', B, '/out', [entry(A, 't'.repeat(32)), entry(A, 'u'.repeat(32))]);
    expect(text).toContain(`この Mac ではすでに別の拡張が接続済みです: LecScribe（ID: ${A}）。`);
    const many = pairMessage('LecScribe', B, '/out', ['c', 'd', 'e', 'f'].map((c) => entry(c.repeat(32), 't'.repeat(32))));
    expect(many).toContain('ほか 2 件');
  });
});
