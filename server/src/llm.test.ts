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
    expect(errors).toEqual(['batch 2: rate limited']);
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
