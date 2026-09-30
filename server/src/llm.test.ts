import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyCorrections,
  batchSections,
  buildCheckPrompt,
  buildOutlinePrompt,
  buildPrompt,
  check,
  codexArgs,
  createBackend,
  outline,
  parseCodexDefaults,
  parseCorrections,
  parseOutline,
  parseResponse,
  polish,
  type LlmSettings,
  type PolishInput,
} from './llm.ts';

const settings: LlmSettings = { kind: 'codex', model: '', codexBin: 'codex', openaiApiKey: '', ollamaUrl: '', charsPerCall: 20 };
const sections: PolishInput[] = [
  { id: 'intro', heading: '00:00:05 冒頭', text: 'えーと、今日は色の話です。' },
  { id: 'slide_001', heading: '00:00:10 slide_001', text: 'まずですね、色の働きから話していきたいと思うんですが。' },
  { id: 'slide_002', heading: '00:01:00 slide_002', text: '' },
];

describe('buildPrompt', () => {
  it('embeds every section with its id and marks empty ones', () => {
    const p = buildPrompt(sections);
    expect(p).toContain('<<<SECTION id="intro" heading="00:00:05 冒頭">>>');
    expect(p).toContain('<<<SECTION id="slide_002" heading="00:01:00 slide_002">>>\n（発話なし）\n<<<END>>>');
  });
});

describe('parseResponse', () => {
  it('reads plain JSON and fenced JSON, ignoring unknown ids', () => {
    const json = JSON.stringify({ sections: [{ id: 'intro', text: ' 今日は色の話です。 ' }, { id: 'other', text: 'x' }] });
    expect(parseResponse(json, ['intro'])).toEqual([{ id: 'intro', text: '今日は色の話です。' }]);
    expect(parseResponse('説明\n```json\n' + json + '\n```', ['intro'])).toHaveLength(1);
  });

  it('rejects responses without sections', () => {
    expect(() => parseResponse('{"foo":1}', ['intro'])).toThrow();
    expect(() => parseResponse('no json here', ['intro'])).toThrow();
  });
});

describe('batchSections', () => {
  it('groups sections up to the character budget', () => {
    const batches = batchSections(sections, 20);
    expect(batches.map((b) => b.map((s) => s.id))).toEqual([['intro'], ['slide_001'], ['slide_002']]);
    expect(batchSections(sections, 1000)).toHaveLength(1);
  });
});

describe('polish', () => {
  it('collects results per id and records failed batches without aborting', async () => {
    let calls = 0;
    const backend = {
      name: 'fake',
      async complete(prompt: string) {
        calls++;
        if (prompt.includes('id="slide_001"')) throw new Error('rate limited');
        const ids = [...prompt.matchAll(/<<<SECTION id="([^"]+)"/g)].map((m) => m[1]);
        return JSON.stringify({ sections: ids.map((id) => ({ id, text: `${id} の本文` })) });
      },
    };
    const { results, errors } = await polish(sections, backend, settings);
    expect(calls).toBe(3);
    expect([...results.keys()]).toEqual(['intro', 'slide_002']);
    expect(results.get('intro')).toEqual({ id: 'intro', text: 'intro の本文' });
    expect(errors).toEqual(['batch 2/3: rate limited']);
  });
});

describe('outline', () => {
  const parts = [
    { id: 'intro', text: '今日は色の話です。' },
    { id: 'slide_001', text: '色の働きから話します。' },
    { id: 'slide_002', text: '' },
    { id: 'slide_003', text: '次に配色です。' },
  ];

  it('embeds every part in the prompt', () => {
    const p = buildOutlinePrompt(parts);
    expect(p).toContain('<<<PART id="intro">>>\n今日は色の話です。\n<<<END>>>');
    expect(p).toContain('<<<PART id="slide_002">>>\n（発話なし）\n<<<END>>>');
  });

  it('keeps topics in order, drops unknown or out-of-order ids, and starts at the first part', () => {
    const raw = JSON.stringify({
      overview: [' 色の基礎 ', ''],
      topics: [
        { heading: '色の働き', summary: ['働き'], startId: 'slide_001' },
        { heading: '謎', summary: [], startId: 'nope' },
        { heading: '戻る', summary: [], startId: 'intro' },
        { heading: '配色', summary: ['配色の考え方'], startId: 'slide_003' },
      ],
    });
    expect(parseOutline(raw, parts.map((p) => p.id))).toEqual({
      overview: ['色の基礎'],
      topics: [
        { heading: '色の働き', summary: ['働き'], startId: 'intro' },
        { heading: '配色', summary: ['配色の考え方'], startId: 'slide_003' },
      ],
    });
  });

  it('reports a failure instead of throwing', async () => {
    const failing = { name: 'fake', complete: async () => { throw new Error('boom'); } };
    expect(await outline(parts, failing, settings)).toEqual({ error: 'outline: boom' });
    const ok = { name: 'fake', complete: async () => JSON.stringify({ overview: ['要点'], topics: [] }) };
    expect(await outline(parts, ok, settings)).toEqual({ outline: { overview: ['要点'], topics: [] } });
  });
});

describe('polish の分割リトライ', () => {
  const three: PolishInput[] = [
    { id: 'a', heading: 'a', text: 'あ'.repeat(10) },
    { id: 'b', heading: 'b', text: 'い'.repeat(10) },
    { id: 'c', heading: 'c', text: 'う'.repeat(10) },
  ];
  const big: LlmSettings = { ...settings, charsPerCall: 1000 }; // 3 節を 1 回で送る

  it('まとめて送って失敗したら、半分に分けてやり直す', async () => {
    const seen: number[][] = [];
    const backend = {
      name: 'fake',
      async complete(prompt: string) {
        const ids = [...prompt.matchAll(/<<<SECTION id="([^"]+)"/g)].map((m) => m[1]!);
        seen.push([ids.length]);
        if (ids.length === 3) throw new Error('too long'); // まとめて送ると壊れる
        return JSON.stringify({ sections: ids.map((id) => ({ id, text: `${id} の本文` })) });
      },
    };
    const { results, errors } = await polish(three, backend, big);
    expect(seen.map((s) => s[0])).toEqual([3, 2, 1]); // 3 → 2 + 1
    expect([...results.keys()]).toEqual(['a', 'b', 'c']);
    expect(errors).toEqual([]);
  });

  it('分けても直らなければ、その分だけ諦めて記録する', async () => {
    const backend = { name: 'fake', complete: async () => { throw new Error('rate limited'); } };
    const { results, errors } = await polish(three, backend, big);
    expect(results.size).toBe(0);
    expect(errors).toEqual(['batch 1/1a: rate limited', 'batch 1/1b: rate limited']);
  });

  it('返答に一部の節が入っていなければ、それも失敗として分け直す', async () => {
    const backend = {
      name: 'fake',
      async complete(prompt: string) {
        const ids = [...prompt.matchAll(/<<<SECTION id="([^"]+)"/g)].map((m) => m[1]!);
        // まとめて送ると最後の節を落とす
        const answered = ids.length === 3 ? ids.slice(0, 2) : ids;
        return JSON.stringify({ sections: answered.map((id) => ({ id, text: `${id} の本文` })) });
      },
    };
    const { results, errors } = await polish(three, backend, big);
    expect([...results.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(errors).toEqual([]);
  });
});

describe('codex exec の呼び方（個人設定を読まない、2026-09-29）', () => {
  it('parseCodexDefaults は表の外の model と model_reasoning_effort だけを読む', () => {
    const config = [
      'notify = ["/path/to/client", "turn-ended"]',
      'model = "gpt-6-astra"   # 普段使い',
      "model_reasoning_effort = 'medium'",
      '',
      '[profiles.fast]',
      'model = "gpt-6-luna"',
      'model_reasoning_effort = "low"',
    ].join('\n');
    expect(parseCodexDefaults(config)).toEqual({ model: 'gpt-6-astra', effort: 'medium' });
    expect(parseCodexDefaults('[plugins."x"]\nenabled = true')).toEqual({});
    expect(parseCodexDefaults('')).toEqual({});
    // 推論の強さは -c の値に埋めるので、英字以外を含むものは読まない
    expect(parseCodexDefaults('model_reasoning_effort = "high\\" -c x"')).toEqual({});
  });

  it('codexArgs は設定ファイルを読まず、モデルと推論の強さを明示する。プロンプトは最後', () => {
    const args = codexArgs({ dir: '/tmp/x', schemaFile: '/tmp/x/s.json', outFile: '/tmp/x/o.txt', prompt: '本文', model: 'gpt-6-astra', effort: 'medium' });
    expect(args.slice(0, 4)).toEqual(['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config']);
    expect(args).toContain('read-only');
    expect(args.join(' ')).toContain('--model gpt-6-astra -c model_reasoning_effort="medium" 本文');
    expect(args.at(-1)).toBe('本文');
    // 既定が読めなければ指定しない（Codex の既定になる）
    const bare = codexArgs({ dir: '/tmp/x', schemaFile: '/tmp/x/s.json', outFile: '/tmp/x/o.txt', prompt: '本文' });
    expect(bare).not.toContain('--model');
    expect(bare).not.toContain('-c');
  });

  it('呼び出しでは CODEX_HOME の設定から既定を引き継ぎ、サーバーのモデル指定があればそちらを使う', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-codex-test-'));
    const codexHome = path.join(dir, 'home');
    await mkdir(codexHome);
    await writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\n[plugins."slack@openai-curated"]\nenabled = true\n');
    // 受け取った引数を --output-last-message のファイルに書くだけの codex の代わり
    const fake = path.join(dir, 'codex');
    await writeFile(
      fake,
      `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nrequire('node:fs').writeFileSync(a[a.indexOf('--output-last-message') + 1], JSON.stringify(a));\n`,
    );
    await chmod(fake, 0o755);
    const previous = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = codexHome;
    try {
      const call = async (model: string) => JSON.parse(await createBackend({ ...settings, model, codexBin: fake })!.complete('本文', { type: 'object' })) as string[];
      const inherited = await call('');
      expect(inherited).toContain('--ignore-user-config');
      expect(inherited.join(' ')).toContain('--model gpt-6-astra -c model_reasoning_effort="medium"');
      const chosen = await call('gpt-6-luna');
      expect(chosen.join(' ')).toContain('--model gpt-6-luna -c model_reasoning_effort="medium"');
    } finally {
      if (previous === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = previous;
    }
  });
});

describe('校正（誤変換の修正、2026-09-30）', () => {
  const inputs = [
    { id: 'slide_110', original: 'こっちの張り千本という文字は可愛さ、きっちゅさを出している', polished: 'こちらの「張り千本」という文字は、かわいさ、きっちりさを出しています。' },
    { id: 'slide_156', original: 'ステンシルで作ったものを傾きをして印字をする', polished: 'ステンシルで作ったものを傾けて印字しています。' },
  ];

  it('buildCheckPrompt は各セクションに原文と整え済みを並べる', () => {
    const p = buildCheckPrompt(inputs);
    expect(p).toContain('<<<SECTION id="slide_110">>>\n[原文]\nこっちの張り千本という文字は可愛さ、きっちゅさを出している\n[整え済み]\nこちらの「張り千本」という文字は、かわいさ、きっちりさを出しています。\n<<<END>>>');
    expect(p).toContain('誤変換');
  });

  it('parseCorrections は知らない id・空の文字列・直しになっていないものを捨てる', () => {
    const raw = JSON.stringify({
      corrections: [
        { id: 'slide_110', wrong: 'きっちりさ', right: 'キッチュさ' },
        { id: 'nope', wrong: 'a', right: 'b' },
        { id: 'slide_110', wrong: '', right: 'x' },
        { id: 'slide_110', wrong: 'y', right: '' },
        { id: 'slide_156', wrong: '同じ', right: '同じ' },
      ],
    });
    expect(parseCorrections(raw, ['slide_110', 'slide_156'])).toEqual([{ id: 'slide_110', wrong: 'きっちりさ', right: 'キッチュさ' }]);
    expect(parseCorrections('説明\n```json\n' + raw + '\n```', ['slide_110', 'slide_156'])).toHaveLength(1);
    expect(parseCorrections('{"foo":1}', ['slide_110'])).toEqual([]);
  });

  it('applyCorrections は長い wrong から順に最初の 1 か所だけ置き換え、見つからない直しは捨てる', () => {
    const texts = new Map([
      ['slide_110', 'この「打足」という文字。打足は面白い。'],
      ['slide_156', '傾けて印字しています。'],
    ]);
    const { texts: out, applied } = applyCorrections(texts, [
      // 同じ箇所を違う長さで指した重複: 長い方が先に当たり、短い方は 2 つ目の「打足」に当たる
      { id: 'slide_110', wrong: '打足', right: '蛇足' },
      { id: 'slide_110', wrong: '「打足」', right: '「蛇足」' },
      { id: 'slide_156', wrong: '本文にない', right: 'x' },
      { id: 'slide_156', wrong: '傾けて印字', right: '型抜きして印字' },
    ]);
    expect(out.get('slide_110')).toBe('この「蛇足」という文字。蛇足は面白い。');
    expect(out.get('slide_156')).toBe('型抜きして印字しています。');
    expect(applied).toHaveLength(3);
    // 知らない id は本文に触らない
    expect(applyCorrections(new Map([['a', 'x']]), [{ id: 'b', wrong: 'x', right: 'y' }]).applied).toEqual([]);
  });

  it('check は原文＋整え済みの文字数でまとめて呼び、失敗したバッチだけ諦める', async () => {
    const prompts: string[] = [];
    const backend = {
      name: 'fake',
      async complete(prompt: string) {
        prompts.push(prompt);
        if (prompt.includes('id="slide_156"')) throw new Error('rate limited');
        return JSON.stringify({ corrections: [{ id: 'slide_110', wrong: 'きっちりさ', right: 'キッチュさ' }] });
      },
    };
    // charsPerCall を小さくして 1 節ずつのバッチに分ける
    const { corrections, errors } = await check(inputs, backend, { ...settings, charsPerCall: 10 });
    expect(prompts).toHaveLength(2);
    expect(corrections).toEqual([{ id: 'slide_110', wrong: 'きっちりさ', right: 'キッチュさ' }]);
    expect(errors).toEqual(['check 2/2: rate limited']);
  });
});
