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

/** 一覧と、それを取った CLI の版 */
export type CatalogSnapshot = { models: CodexModel[]; version: string | null };

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
  for (const raw of list as unknown[]) {
    // 形の崩れた要素（null など）は飛ばす。1 つのために一覧ごと捨てない
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
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
 * 一覧が取れない・その系統が無いときは空にして、理由（problem）を返す。代わりに何を使うかは呼び出し元が決める
 * （校正や画像の判定は「空 = 行わない」なので、空のまま渡すと黙って止まる）
 */
export function resolveModel(value: string, models: readonly CodexModel[] | null): { model: string; problem?: string } {
  if (!value.startsWith(LATEST_PREFIX)) return { model: value };
  // 画面では「最新のTerra」と出すので、`latest:Terra` と書かれても同じ系統として扱う
  const tier = value.slice(LATEST_PREFIX.length).trim().toLowerCase();
  if (!models) return { model: '', problem: 'モデルの一覧が取れない' };
  const slug = latestOfTier(models, tier);
  return slug ? { model: slug } : { model: '', problem: `一覧に ${tier} の系統のモデルが無い` };
}

/** 一覧を取り直す間隔。新しいモデルは CLI を上げたときに出る（そのときは版の違いで取り直す）ので、頻繁に取る必要はない */
const CATALOG_TTL_MS = 60 * 60 * 1000;
/** 取れなかったあと、取り直すまでの間。CLI の版が変わったらすぐ取り直す */
const FAILURE_TTL_MS = 5 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Codex CLI のモデルの一覧を取って覚える。`codex debug models`（Codex がネットワークで更新し、つながらなければ
 * 自前のキャッシュを返す）が失敗したら、CLI に同梱の一覧（`--bundled`）を使う。どちらも駄目なら null（「最新の〜」は
 * 呼び出し元が代わりのモデルにする）。
 *
 * 使うたびに `codex --version`（0.01 秒ほど）を確かめ、版が変わっていたら覚えを捨てる。`brew upgrade codex` の直後の
 * ノート作成から新しいモデルを使うため（2026-11-05 のレビュー）
 */
export class ModelCatalog {
  private cached: { at: number; snapshot: CatalogSnapshot; bundled: boolean } | null = null;
  private failed: { at: number; version: string | null } | null = null;
  private pending: Promise<CatalogSnapshot | null> | null = null;
  /** close() で取得中のコマンドを止める（サーバーを閉じたあとに子プロセスを残さない） */
  private readonly closed = new AbortController();
  private readonly codexBin: () => string;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(codexBin: () => string, log: (message: string) => void = () => undefined, now: () => number = Date.now) {
    this.codexBin = codexBin;
    this.log = log;
    this.now = now;
  }

  /** 一覧（表示順）と CLI の版。取れなければ null。同時に呼ばれたら 1 回の取得を分け合う */
  snapshot(): Promise<CatalogSnapshot | null> {
    this.pending ??= this.refresh().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** 一覧（表示順）。取れなければ null */
  async list(): Promise<CodexModel[] | null> {
    return (await this.snapshot())?.models ?? null;
  }

  /** 取得中のコマンドを止め、以後は取らない */
  close(): void {
    this.closed.abort();
  }

  private signal(ms: number): AbortSignal {
    return AbortSignal.any([this.closed.signal, AbortSignal.timeout(ms)]);
  }

  private async refresh(): Promise<CatalogSnapshot | null> {
    if (this.closed.signal.aborted) return this.cached?.snapshot ?? null;
    const bin = this.codexBin();
    const version = await this.cliVersion(bin);
    const sameCli = !!this.cached && this.cached.snapshot.version === version;
    if (this.cached && sameCli && this.now() - this.cached.at < CATALOG_TTL_MS) return this.cached.snapshot;
    // 失敗を覚えておき、しばらくは取り直さない（設定画面を開くたび・ノート作成のたびに失敗するコマンドを流さない）
    if (this.failed && this.failed.version === version && this.now() - this.failed.at < FAILURE_TTL_MS) return this.cached?.snapshot ?? null;
    const live = await this.read(bin, ['debug', 'models']);
    if (live) return this.store(live, version, false);
    // 取り直せなくても、同じ CLI で取った一覧が手元にあればそちらを使い続ける（同梱の一覧のほうが古いことがある）
    const keep = sameCli && this.cached?.bundled === false;
    if (!keep) {
      const bundled = await this.read(bin, ['debug', 'models', '--bundled']);
      if (bundled) return this.store(bundled, version, true);
    }
    this.failed = { at: this.now(), version };
    if (!this.closed.signal.aborted) {
      this.log(keep ? 'Codex のモデルの一覧を取り直せませんでした（前に取った一覧を使い続けます）' : 'Codex のモデルの一覧を取れませんでした（「最新の〜」の指定は代わりのモデルになります）');
    }
    return this.cached?.snapshot ?? null;
  }

  private store(models: CodexModel[], version: string | null, bundled: boolean): CatalogSnapshot {
    this.cached = { at: this.now(), snapshot: { models, version }, bundled };
    this.failed = null;
    return this.cached.snapshot;
  }

  private async read(bin: string, args: string[]): Promise<CodexModel[] | null> {
    try {
      const r = await run(bin, args, { binary: true, signal: this.signal(CATALOG_TIMEOUT_MS) });
      if (r.code !== 0 || !r.stdoutBytes) return null;
      const models = parseCatalog(new TextDecoder().decode(r.stdoutBytes));
      return models.length > 0 ? models : null;
    } catch {
      return null;
    }
  }

  private async cliVersion(bin: string): Promise<string | null> {
    try {
      const r = await run(bin, ['--version'], { signal: this.signal(VERSION_TIMEOUT_MS) });
      return r.code === 0 ? (/(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null) : null;
    } catch {
      return null;
    }
  }
}
