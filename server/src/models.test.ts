import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelCatalog, latestOfTier, parseCatalog, resolveModel, tierOf } from './models.ts';

/** codex 0.166.0 の `codex debug models` の形（2026-11-05 の一覧。項目は抜粋） */
const CATALOG = JSON.stringify({
  models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', priority: 1 },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 2 },
    { slug: 'gpt-6-chat-thinking', display_name: 'GPT-6 Chat Thinking', visibility: 'hide', priority: 3 },
    { slug: 'gpt-6.1-terra', display_name: 'GPT-6.1 Terra', visibility: 'list', priority: 4 },
    { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', priority: 5 },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 6 },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', priority: 7 },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 9 },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 10 },
  ],
});

describe('parseCatalog / tierOf / latestOfTier（§13.5、2026-11-05）', () => {
  const models = parseCatalog(CATALOG);

  it('選べるモデル（visibility が list）だけを表示順に取り出す', () => {
    expect(models.map((m) => m.slug)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra']);
    expect(models[2]).toEqual({ slug: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', priority: 4 });
    expect(parseCatalog('[]')).toEqual([]);
    expect(parseCatalog('{"other": 1}')).toEqual([]);
  });

  it('名前から版と系統を読む', () => {
    expect(tierOf('gpt-6.1-terra')).toEqual({ version: [6, 1], tier: 'terra' });
    expect(tierOf('gpt-6-astra')).toEqual({ version: [6], tier: 'astra' });
    expect(tierOf('codex-auto-review')).toBeNull();
    expect(tierOf('gpt-5-mini')).toEqual({ version: [5], tier: 'mini' });
  });

  it('系統でいちばん新しい版を選ぶ（6.1 > 6 > 5.6）', () => {
    expect(latestOfTier(models, 'terra')).toBe('gpt-6.1-terra');
    expect(latestOfTier(models, 'astra')).toBe('gpt-6-astra');
    expect(latestOfTier(models, 'sol')).toBe('gpt-6.1-sol');
    expect(latestOfTier(models, 'luna')).toBe('gpt-6-luna');
    expect(latestOfTier(models, 'nova')).toBeUndefined();
    // 版が同じなら表示順が先のもの
    expect(latestOfTier([{ slug: 'gpt-7-terra', name: 'b', priority: 5 }, { slug: 'gpt-7.0-terra', name: 'a', priority: 1 }], 'terra')).toBe('gpt-7.0-terra');
  });

  it('latest:<系統> は一覧でいちばん新しい版に、それ以外はそのまま。解決できなければ既定のモデル（空）にして理由を返す', () => {
    expect(resolveModel('latest:terra', models)).toEqual({ model: 'gpt-6.1-terra' });
    expect(resolveModel('gpt-5.6-terra', models)).toEqual({ model: 'gpt-5.6-terra' });
    expect(resolveModel('', models)).toEqual({ model: '' });
    expect(resolveModel('latest:nova', models).model).toBe('');
    expect(resolveModel('latest:nova', models).note).toMatch(/nova/);
    expect(resolveModel('latest:terra', null).model).toBe('');
    expect(resolveModel('latest:terra', null).note).toMatch(/一覧が取れない/);
  });
});

describe('ModelCatalog', () => {
  const stub = async (body: string) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-models-'));
    const file = path.join(dir, 'codex');
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
    return { file, dir };
  };

  it('codex debug models の一覧と CLI の版を返し、しばらく覚えておく', async () => {
    const { file, dir } = await stub(
      `printf x >> "${'$'}(dirname "$0")/calls"; if [ "$1" = "--version" ]; then echo "codex-cli 0.166.0"; exit 0; fi; cat <<'JSON'\n${CATALOG}\nJSON`,
    );
    const catalog = new ModelCatalog(() => file);
    expect((await catalog.list())?.map((m) => m.slug)).toContain('gpt-6.1-terra');
    expect(await catalog.version()).toBe('0.166.0');
    await catalog.list();
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(path.join(dir, 'calls'), 'utf8')).length).toBe(2); // debug models と --version の 1 回ずつ
  });

  it('更新に失敗したら CLI に同梱の一覧（--bundled）を使い、どちらも駄目なら null', async () => {
    const bundled = await stub(`if [ "$3" = "--bundled" ]; then cat <<'JSON'\n${CATALOG}\nJSON\nexit 0; fi; echo "network error" >&2; exit 1`);
    expect((await new ModelCatalog(() => bundled.file).list())?.length).toBe(6);
    const broken = await stub('echo "nope" >&2; exit 1');
    const logs: string[] = [];
    expect(await new ModelCatalog(() => broken.file, (m) => logs.push(m)).list()).toBeNull();
    expect(logs.join('\n')).toMatch(/モデルの一覧を取れませんでした/);
    expect(await new ModelCatalog(() => path.join(broken.dir, 'missing')).list()).toBeNull();
  });
});
