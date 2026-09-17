import { describe, expect, it } from 'vitest';
import { batchSections, buildOutlinePrompt, buildPrompt, outline, parseOutline, parseResponse, polish, type LlmSettings, type PolishInput } from './llm.ts';

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

describe('1 回の呼び出しの打ち切り（2026-09-17）', () => {
  /** 合図が abort されるまで返らない偽の呼び出し先。スリープで途切れた要求を待ち続ける codex の代わり */
  const hangUntilAborted = (signal?: AbortSignal) =>
    new Promise<string>((_, reject) => {
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    });
  const answer = (prompt: string) => {
    const ids = [...prompt.matchAll(/<<<SECTION id="([^"]+)"/g)].map((m) => m[1]);
    return JSON.stringify({ sections: ids.map((id) => ({ id, text: `${id} の本文` })) });
  };

  it('返ってこない呼び出しは打ち切られ、分けてやり直して完成する', async () => {
    const calls: string[] = [];
    const backend = {
      name: 'fake',
      async complete(prompt: string, _schema: unknown, signal?: AbortSignal) {
        calls.push(prompt);
        // 最初の 1 回（2 節まとめて）だけ返ってこない。分けたあとの呼び出しは普通に返る
        if (calls.length === 1) return hangUntilAborted(signal);
        return answer(prompt);
      },
    };
    const logs: string[] = [];
    const two = sections.slice(0, 2);
    const { results, errors } = await polish(two, backend, { ...settings, charsPerCall: 1000, callTimeoutMs: 30 }, (m) => logs.push(m));
    expect(calls).toHaveLength(3); // 2 節まとめて → 打ち切り → 1 節ずつ
    expect([...results.keys()]).toEqual(['intro', 'slide_001']);
    expect(errors).toEqual([]);
    expect(logs.some((l) => l.includes('秒たっても返ってこない'))).toBe(true);
  });

  it('利用者の中止は打ち切りとは別の理由で記録し、残りは呼ばない', async () => {
    const controller = new AbortController();
    const backend = {
      name: 'fake',
      async complete(_prompt: string, _schema: unknown, signal?: AbortSignal) {
        controller.abort(); // 呼ばれている最中に中止された
        return hangUntilAborted(signal);
      },
    };
    const { results, errors } = await polish(sections.slice(0, 2), backend, { ...settings, charsPerCall: 1000, callTimeoutMs: 10_000, signal: controller.signal });
    expect(results.size).toBe(0);
    expect(errors).toEqual(['batch 1/1: cancelled']);
  });

  it('要点の呼び出しも同じ打ち切りが効く', async () => {
    const backend = { name: 'fake', async complete(_p: string, _s: unknown, signal?: AbortSignal) { return hangUntilAborted(signal); } };
    const r = await outline([{ id: 'intro', text: '本文' }], backend, { ...settings, callTimeoutMs: 30 });
    expect(r.outline).toBeUndefined();
    expect(r.error).toContain('秒たっても返ってこない');
  });
});
