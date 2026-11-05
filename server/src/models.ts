import { run } from './exec.ts';

/**
 * Codex で使えるモデルの一覧と「最新の〜」の解決（§13.5、2026-11-05）。
 *
 * モデル名を固定すると、ChatGPT に新しいモデル（GPT-6.1 Terra など）が出ても古いモデルのまま使い続けることになる。
 * そこで設定には `latest:terra` のように系統だけを書けるようにし、ノートを作るたびに Codex CLI の一覧
 * （`codex debug models`）から、その系統でいちばん新しい版の名前に置き換える。
 * 一覧は Codex CLI の版ごとに違う（新しいモデルは新しい CLI にしか出ない）ので、CLI を上げると新しいモデルに切り替わる。
 */

export type CodexModel = { slug: string; name: string; priority: number };

/** 系統で指定するときの頭。`latest:terra` は Terra の系統でいちばん新しい版 */
export const LATEST_PREFIX = 'latest:';

/** gpt-6.1-terra → 版 [6, 1]・系統 terra */
const SLUG = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/;

export function tierOf(slug: string): { version: number[]; tier: string } | null {
  const m = SLUG.exec(slug);
  return m ? { version: m[1]!.split('.').map(Number), tier: m[2]! } : null;
}

function compareVersion(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** `codex debug models` の JSON から、選べるモデル（visibility が list）を表示順に取り出す */
export function parseCatalog(raw: string): CodexModel[] {
  const parsed = JSON.parse(raw) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? ((parsed as Record<string, unknown>)['models'] ?? Object.values(parsed as Record<string, unknown>).find(Array.isArray))
      : undefined;
  if (!Array.isArray(list)) return [];
  const out: CodexModel[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    const slug = item['slug'];
    if (typeof slug !== 'string' || item['visibility'] !== 'list') continue;
    const name = typeof item['display_name'] === 'string' ? item['display_name'] : slug;
    const priority = typeof item['priority'] === 'number' ? item['priority'] : Number.MAX_SAFE_INTEGER;
    out.push({ slug, name, priority });
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/** 系統でいちばん新しい版（版が同じなら表示順が先のもの）。無ければ undefined */
export function latestOfTier(models: readonly CodexModel[], tier: string): string | undefined {
  let best: { slug: string; version: number[]; priority: number } | undefined;
  for (const m of models) {
    const t = tierOf(m.slug);
    if (!t || t.tier !== tier) continue;
    if (!best || compareVersion(t.version, best.version) > 0 || (compareVersion(t.version, best.version) === 0 && m.priority < best.priority)) {
      best = { slug: m.slug, version: t.version, priority: m.priority };
    }
  }
  return best?.slug;
}

/**
 * 設定の値を、呼び出しに渡すモデル名にする。`latest:<系統>` は一覧でいちばん新しい版に、それ以外はそのまま。
 * 一覧が取れない・その系統が無いときは空（呼び出し先の既定のモデル）にして、理由を返す
 */
export function resolveModel(value: string, models: readonly CodexModel[] | null): { model: string; note?: string } {
  if (!value.startsWith(LATEST_PREFIX)) return { model: value };
  const tier = value.slice(LATEST_PREFIX.length);
  if (!models) return { model: '', note: `モデルの一覧が取れないので、${value} の代わりに既定のモデルを使います` };
  const slug = latestOfTier(models, tier);
  return slug ? { model: slug } : { model: '', note: `一覧に ${tier} の系統のモデルが無いので、${value} の代わりに既定のモデルを使います` };
}

/** 一覧を取り直す間隔。新しいモデルは CLI を上げたときに出るので、頻繁に取る必要はない */
const CATALOG_TTL_MS = 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 60_000;

/**
 * Codex CLI のモデルの一覧を取って覚える。`codex debug models`（必要ならネットワークで更新）が失敗したら、
 * CLI に同梱の一覧（`--bundled`）を使う。どちらも駄目なら null（「最新の〜」は既定のモデルになる）
 */
export class ModelCatalog {
  private cached: { at: number; models: CodexModel[]; version: string | null } | null = null;
  private pending: Promise<CodexModel[] | null> | null = null;
  private readonly codexBin: () => string;
  private readonly log: (message: string) => void;

  constructor(codexBin: () => string, log: (message: string) => void = () => undefined) {
    this.codexBin = codexBin;
    this.log = log;
  }

  /** 一覧（表示順）。取れなければ null */
  async list(): Promise<CodexModel[] | null> {
    if (this.cached && Date.now() - this.cached.at < CATALOG_TTL_MS) return this.cached.models;
    this.pending ??= this.fetch().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** 一覧を取った CLI の版（`codex --version`）。取れなければ null */
  async version(): Promise<string | null> {
    await this.list();
    return this.cached?.version ?? null;
  }

  private async fetch(): Promise<CodexModel[] | null> {
    const bin = this.codexBin();
    for (const args of [['debug', 'models'], ['debug', 'models', '--bundled']]) {
      try {
        const r = await run(bin, args, { binary: true, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
        if (r.code !== 0 || !r.stdoutBytes) continue;
        const models = parseCatalog(new TextDecoder().decode(r.stdoutBytes));
        if (models.length === 0) continue;
        const v = await run(bin, ['--version'], { signal: AbortSignal.timeout(10_000) }).catch(() => null);
        const version = v && v.code === 0 ? (/(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] ?? null) : null;
        this.cached = { at: Date.now(), models, version };
        return models;
      } catch {
        // 次の取り方を試す
      }
    }
    this.log('Codex のモデルの一覧を取れませんでした（「最新の〜」の指定は既定のモデルになります）');
    // 古い一覧があればそれを使い続ける
    return this.cached?.models ?? null;
  }
}
