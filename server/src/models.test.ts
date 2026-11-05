import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    // 形の崩れた要素があっても、ほかのモデルは取り出す（2026-11-05 のレビュー）
    expect(parseCatalog('{"models":[null,1,"x",{"slug":"gpt-6-terra","visibility":"list"}]}').map((m) => m.slug)).toEqual(['gpt-6-terra']);
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

  it('latest:<系統> は一覧でいちばん新しい版に、それ以外はそのまま。解決できなければ空にして理由を返す', () => {
    expect(resolveModel('latest:terra', models)).toEqual({ model: 'gpt-6.1-terra' });
    expect(resolveModel('gpt-5.6-terra', models)).toEqual({ model: 'gpt-5.6-terra' });
    expect(resolveModel('', models)).toEqual({ model: '' });
    expect(resolveModel('latest:nova', models).model).toBe('');
    expect(resolveModel('latest:nova', models).problem).toMatch(/nova/);
    expect(resolveModel('latest:terra', null).model).toBe('');
    expect(resolveModel('latest:terra', null).problem).toMatch(/一覧が取れない/);
    // 画面の「最新のTerra」のとおりに大文字で書かれても同じ系統（2026-11-05 のレビュー）
    expect(resolveModel('latest:Terra', models)).toEqual({ model: 'gpt-6.1-terra' });
  });
});

describe('ModelCatalog', () => {
  /**
   * 置いたファイルで振る舞いを変えられる codex。version（版）・mode（ok / fail = 更新だけ失敗 / failall / slow）・catalog.json。
   * 呼ばれた引数を calls に「--version」「debug」「debug:--bundled」の形で残す
   */
  const stub = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'lec-models-'));
    const file = path.join(dir, 'codex');
    await writeFile(
      file,
      [
        '#!/bin/sh',
        'd="$(dirname "$0")"',
        'printf "%s " "$1${3:+:$3}" >> "$d/calls"',
        'mode="$(cat "$d/mode" 2>/dev/null || echo ok)"',
        'if [ "$1" = "--version" ]; then echo "codex-cli $(cat "$d/version")"; exit 0; fi',
        'if [ "$mode" = "slow" ]; then exec sleep 30; fi',
        'if [ "$mode" = "failall" ]; then echo "nope" >&2; exit 1; fi',
        'if [ "$mode" = "fail" ] && [ "$3" != "--bundled" ]; then echo "network error" >&2; exit 1; fi',
        'cat "$d/catalog.json"',
        '',
      ].join('\n'),
    );
    await chmod(file, 0o755);
    await writeFile(path.join(dir, 'version'), '0.166.0');
    await writeFile(path.join(dir, 'catalog.json'), CATALOG);
    const set = (name: 'version' | 'mode' | 'catalog.json', value: string) => writeFile(path.join(dir, name), value);
    const calls = async () => (await readFile(path.join(dir, 'calls'), 'utf8').catch(() => '')).trim();
    return { file, dir, set, calls };
  };
  /** 進められる時計 */
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('一覧と CLI の版を返し、しばらく覚えておく。版は毎回確かめる', async () => {
    const c = await stub();
    const catalog = new ModelCatalog(() => c.file);
    const first = await catalog.snapshot();
    expect(first?.models.map((m) => m.slug)).toContain('gpt-6.1-terra');
    expect(first?.version).toBe('0.166.0');
    await catalog.list();
    expect(await c.calls()).toBe('--version debug --version');
  });

  it('CLI の版が変わったら、覚えていた一覧を捨てて取り直す（brew upgrade codex の直後から新しいモデル）', async () => {
    const c = await stub();
    const catalog = new ModelCatalog(() => c.file);
    expect(await catalog.list().then((m) => m && latestOfTier(m, 'terra'))).toBe('gpt-6.1-terra');
    await c.set('version', '0.170.0');
    await c.set('catalog.json', JSON.stringify({ models: [{ slug: 'gpt-7-terra', display_name: 'GPT-7 Terra', visibility: 'list', priority: 1 }] }));
    const after = await catalog.snapshot();
    expect(after?.version).toBe('0.170.0');
    expect(latestOfTier(after!.models, 'terra')).toBe('gpt-7-terra');
  });

  it('更新に失敗したら同梱の一覧（--bundled）を使い、どちらも駄目なら null。失敗はしばらく覚えて取り直さない', async () => {
    const c = await stub();
    await c.set('mode', 'fail');
    expect((await new ModelCatalog(() => c.file).list())?.length).toBe(6);

    const broken = await stub();
    await broken.set('mode', 'failall');
    const t = clock();
    const logs: string[] = [];
    const catalog = new ModelCatalog(() => broken.file, (m) => logs.push(m), t.now);
    expect(await catalog.snapshot()).toBeNull();
    expect(await catalog.snapshot()).toBeNull();
    expect(await broken.calls()).toBe('--version debug debug:--bundled --version');
    expect(logs).toEqual(['Codex のモデルの一覧を取れませんでした（「最新の〜」の指定は代わりのモデルになります）']);
    // しばらくしたら、または CLI を上げたら取り直す
    t.advance(5 * 60 * 1000);
    await catalog.snapshot();
    await broken.set('version', '0.170.0');
    await catalog.snapshot();
    expect((await broken.calls()).split(' ').filter((x) => x === 'debug').length).toBe(3);
    expect(await new ModelCatalog(() => path.join(broken.dir, 'missing')).list()).toBeNull();
  });

  it('取り直しに失敗しても、同じ CLI で前に取った一覧があれば同梱の一覧に替えない', async () => {
    const c = await stub();
    const t = clock();
    const logs: string[] = [];
    const catalog = new ModelCatalog(() => c.file, (m) => logs.push(m), t.now);
    await catalog.snapshot();
    // 覚えが切れたあとの取り直しが失敗する。同梱の一覧（ここでは gpt-6.1-terra が無い）は使わない
    await c.set('catalog.json', JSON.stringify({ models: [{ slug: 'gpt-5.6-terra', visibility: 'list', priority: 1 }] }));
    await c.set('mode', 'fail');
    t.advance(60 * 60 * 1000);
    expect(latestOfTier((await catalog.list())!, 'terra')).toBe('gpt-6.1-terra');
    expect(await c.calls()).not.toContain('--bundled');
    expect(logs).toEqual(['Codex のモデルの一覧を取り直せませんでした（前に取った一覧を使い続けます）']);
  });

  it('close() で取得中のコマンドを止める（サーバーを閉じたあとに子プロセスを残さない）', async () => {
    const c = await stub();
    await c.set('mode', 'slow');
    const logs: string[] = [];
    const catalog = new ModelCatalog(() => c.file, (m) => logs.push(m));
    const pending = catalog.snapshot();
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    catalog.close();
    expect(await pending).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(logs).toEqual([]);
  });
});
