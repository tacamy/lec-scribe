import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from './config.ts';
import { applyLlmOverrides, isValidModelName, readLlmOverrides, writeLlmOverrides } from './settings.ts';

describe('設定画面からの上書き（settings.json、2026-10-01）', () => {
  it('isValidModelName はモデル名らしい文字列と空文字だけを通す', () => {
    for (const ok of ['', 'gpt-5.6-terra', 'gpt-6-astra', 'qwen2.5:32b', 'org/model_v1']) expect(isValidModelName(ok), ok).toBe(true);
    for (const ng of ['a b', 'モデル', '-leading', 'x'.repeat(65), 1, null, undefined, 'a;rm']) expect(isValidModelName(ng as unknown), String(ng)).toBe(false);
  });

  it('書いて読める。null で消える。無い・壊れた・形が不正なファイルは {} になる', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-settings-'));
    const file = path.join(dir, 'nested', 'settings.json');
    expect(await readLlmOverrides(file)).toEqual({});
    await writeLlmOverrides(file, { llmModel: 'gpt-5.6-terra', llmCheckModel: 'gpt-6-astra' });
    expect(await readLlmOverrides(file)).toEqual({ llmModel: 'gpt-5.6-terra', llmCheckModel: 'gpt-6-astra' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ llmModel: 'gpt-5.6-terra', llmCheckModel: 'gpt-6-astra' });
    await writeLlmOverrides(file, null);
    expect(await readLlmOverrides(file)).toEqual({});
    await writeFile(file, 'not json');
    expect(await readLlmOverrides(file)).toEqual({});
    await writeFile(file, JSON.stringify({ llmModel: 'a b', llmCheckModel: 'gpt-6-astra', extra: 1 }));
    expect(await readLlmOverrides(file)).toEqual({ llmCheckModel: 'gpt-6-astra' });
  });

  it('applyLlmOverrides はキーのあるものだけ上書きする（空文字も上書き）', () => {
    const config = { llmModel: 'env-model', llmCheckModel: 'env-check' } as ServerConfig;
    applyLlmOverrides(config, { llmCheckModel: '' });
    expect(config.llmModel).toBe('env-model');
    expect(config.llmCheckModel).toBe('');
    applyLlmOverrides(config, { llmModel: 'gpt-5.6-terra' });
    expect(config.llmModel).toBe('gpt-5.6-terra');
  });
});
