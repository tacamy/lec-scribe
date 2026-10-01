import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.ts';

/**
 * ノート作成: 話し言葉を読みやすく整え、要点を付ける（Phase 9、SPEC §13.5）。
 *
 * 呼び出し先は差し替え可能:
 *   codex   … Codex CLI の `codex exec`（ChatGPT アカウントの定額枠。API キー不要）
 *   openai  … OpenAI API（API キー、従量課金）
 *   ollama  … ローカルの Ollama（外に出さない）
 * 2 段階で呼ぶ:
 *   1. polish  … スライドごとの本文をバッチで整える（`{ sections: [{ id, text }] }`）
 *   2. outline … 整えた本文全体から、動画全体の要点と「話題の区切り」（見出し・要点・開始位置）を作る
 *      画面の切り替わり（キャプチャ単位）は話の区切りと一致しないことが多いので、要点や見出しは
 *      スライド単位ではなく LLM が内容から決めた話題単位に付ける（2026-09-09）。
 */
export type LlmKind = 'none' | 'codex' | 'openai' | 'ollama';

export type LlmSettings = {
  kind: LlmKind;
  /** 空なら各バックエンドの既定 */
  model: string;
  codexBin: string;
  openaiApiKey: string;
  ollamaUrl: string;
  /** 1 回の呼び出しに入れる本文の文字数の目安（呼び出し回数を抑える） */
  charsPerCall: number;
  /** 中止用。abort されると実行中の呼び出しを止め、残りのバッチは呼ばない */
  signal?: AbortSignal;
};

export type PolishInput = { id: string; heading: string; text: string };
export type PolishOutput = { id: string; text: string };

/** 話題の区切り。topics は本文の順で、startId はその話題が始まる節の id */
export type Outline = {
  overview: string[];
  topics: Array<{ heading: string; summary: string[]; startId: string }>;
};

export type JsonSchema = Record<string, unknown>;

export const POLISH_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['sections'],
  additionalProperties: false,
};

export const OUTLINE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    overview: { type: 'array', items: { type: 'string' } },
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string' },
          summary: { type: 'array', items: { type: 'string' } },
          startId: { type: 'string' },
        },
        required: ['heading', 'summary', 'startId'],
        additionalProperties: false,
      },
    },
  },
  required: ['overview', 'topics'],
  additionalProperties: false,
};

/** 校正（誤変換の修正）の入出力。original は文字起こしそのまま、polished は整えた本文 */
export type CheckInput = { id: string; original: string; polished: string };
export type Correction = { id: string; wrong: string; right: string };

export const CHECK_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          wrong: { type: 'string' },
          right: { type: 'string' },
        },
        required: ['id', 'wrong', 'right'],
        additionalProperties: false,
      },
    },
  },
  required: ['corrections'],
  additionalProperties: false,
};

export function buildPrompt(sections: readonly PolishInput[]): string {
  const body = sections
    .map((s) => `<<<SECTION id="${s.id}" heading="${s.heading}">>>\n${s.text.trim() || '（発話なし）'}\n<<<END>>>`)
    .join('\n\n');
  return `あなたはスライド動画の解説をノートにまとめる編集者です。以下は動画音声の自動文字起こし（話し言葉）を、画面が切り替わったところで区切ったものです。各セクションについて text を作ってください。

text: 内容と順序を変えずに、フィラー（「えー」「あの」「まあ」「ですね」「〜と思うんですが」「〜かなと思います」など）や言い直しを取り除き、読みやすい書き言葉（です・ます調）に整えた本文。要約や補足はしない。専門用語・固有名詞は文字起こしのまま残す。明らかな誤変換だけ文脈から直す。段落は「\\n\\n」で区切る。

出力は指定された JSON スキーマに従い、sections の id と順序は入力と同じにしてください。本文が「（発話なし）」のセクションは text を空文字にしてください。

${body}`;
}

/** 整えた本文全体から、動画全体の要点と話題の区切りを頼むプロンプト */
export function buildOutlinePrompt(sections: ReadonlyArray<{ id: string; text: string }>): string {
  const body = sections
    .map((s) => `<<<PART id="${s.id}">>>\n${s.text.trim() || '（発話なし）'}\n<<<END>>>`)
    .join('\n\n');
  return `あなたはスライド動画の解説をノートにまとめる編集者です。以下は動画の文字起こしを読みやすく整えた本文を、画面が切り替わったところ（スライドや操作画面の変化）で区切って順に並べたものです。画面の切り替わりは話の区切りと一致しないことが多い（操作のデモで画面が細かく変わる、同じスライドで別の話題に移る、など）ので、話題の区切りは内容から判断してください。次の 2 つを作ってください。

1. overview: 動画全体の要点。日本語の箇条書きで 5〜12 項目、各項目は 1 文。記号や番号は付けない。
2. topics: 話題のまとまり。本文の順に並べ、各要素は次の 3 つ。
   - heading: その話題の見出し（日本語、20 文字以内、体言止め）
   - summary: その話題の要点を 1〜4 項目（各 1 文）
   - startId: その話題が始まる部分の id（入力の id をそのまま使う）
   最初の topic の startId は最初の部分の id にしてください。話題は細かく割りすぎず、10 分の動画なら 2〜4 個、90 分なら 6〜15 個が目安です。「（発話なし）」の部分は前の話題に含めてください。

出力は指定された JSON スキーマに従ってください。

${body}`;
}

/** 整えた本文を原文（文字起こし）と突き合わせ、誤変換だけを直してもらうプロンプト（§13.5 の校正） */
export function buildCheckPrompt(sections: readonly CheckInput[]): string {
  const body = sections
    .map((s) => `<<<SECTION id="${s.id}">>>\n[原文]\n${s.original.trim()}\n[整え済み]\n${s.polished.trim()}\n<<<END>>>`)
    .join('\n\n');
  return `あなたは文字起こしの校正者です。以下の各セクションには、動画音声の自動文字起こし（原文）と、それを読みやすい書き言葉に整えた本文（整え済み）があります。整え済みの本文に残っている、音声認識の誤変換に由来する誤った語（同音・類似音の別の語になっている、文脈で意味が通らない）だけを直してください。整える途中で原文と違う誤った語に置き換わってしまった箇所も、原文と文脈から正しい語に直してください。

- 出力は corrections の配列。各要素は { id, wrong, right }
- wrong はそのセクションの整え済み本文にそのまま現れる文字列を、置き換える場所が一意に定まる長さで書く
- right は直したあとの文字列
- 誤変換の修正だけを行う。文体や言い回しの変更、要約、語順の入れ替え、句読点だけの変更はしない
- 確信が持てない固有名詞や専門用語は直さない
- 直す箇所がなければ corrections は空配列にする

${body}`;
}

/** LLM の返答（JSON。前後に説明や \`\`\` フェンスが付いていても許容）を読む */
export function parseResponse(raw: string, expectedIds: readonly string[]): PolishOutput[] {
  const parsed = extractJson(raw) as { sections?: unknown };
  if (!Array.isArray(parsed.sections)) throw new Error('LLM の返答に sections がありません');
  const wanted = new Set(expectedIds);
  const out: PolishOutput[] = [];
  for (const item of parsed.sections as Array<Record<string, unknown>>) {
    const id = String(item['id'] ?? '');
    if (!wanted.has(id)) continue;
    out.push({ id, text: String(item['text'] ?? '').trim() });
  }
  return out;
}

/** JSON を取り出す（前後に説明や \`\`\` フェンスが付いていても許容） */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('LLM の返答に JSON がありません');
  return JSON.parse(trimmed.slice(start, end + 1));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);

/**
 * 話題の区切りの返答を読む。知らない id や順序の乱れは捨て、最初の話題は必ず先頭の id から始める。
 * 話題が 1 つも残らなければ overview だけの Outline になる
 */
export function parseOutline(raw: string, ids: readonly string[]): Outline {
  const parsed = extractJson(raw) as { overview?: unknown; topics?: unknown };
  const order = new Map(ids.map((id, i) => [id, i]));
  const topics: Outline['topics'] = [];
  let last = -1;
  for (const item of Array.isArray(parsed.topics) ? (parsed.topics as Array<Record<string, unknown>>) : []) {
    const startId = String(item['startId'] ?? '');
    const heading = String(item['heading'] ?? '').trim();
    const pos = order.get(startId);
    if (pos === undefined || pos <= last || !heading) continue;
    topics.push({ heading, summary: strings(item['summary']), startId });
    last = pos;
  }
  if (topics.length > 0 && ids.length > 0) topics[0]!.startId = ids[0]!;
  return { overview: strings(parsed.overview), topics };
}

/** 校正の返答を読む。知らない id、空の文字列、直しになっていないもの（wrong と right が同じ）は捨てる */
export function parseCorrections(raw: string, ids: readonly string[]): Correction[] {
  const parsed = extractJson(raw) as { corrections?: unknown };
  const known = new Set(ids);
  const out: Correction[] = [];
  for (const item of Array.isArray(parsed.corrections) ? (parsed.corrections as Array<Record<string, unknown>>) : []) {
    const id = String(item['id'] ?? '');
    const wrong = String(item['wrong'] ?? '');
    const right = String(item['right'] ?? '');
    if (!known.has(id) || wrong.length === 0 || right.length === 0 || wrong === right) continue;
    out.push({ id, wrong, right });
  }
  return out;
}

/**
 * 校正の直しを本文に当てる。置き換える場所は**直す前の本文**の上で決める（先に当てた直しが挿し込んだ文字列に、
 * あとの直しが当たって壊さないため）。節ごとに長い wrong から順に、すでに取られた場所と重ならない最初の出現位置を取り、
 * 見つからない直しは捨てる（同じ箇所を違う長さで指した重複は長い方だけが残る）。場所が全部決まってから一度に置き換える
 */
export function applyCorrections(texts: ReadonlyMap<string, string>, corrections: readonly Correction[]): { texts: Map<string, string>; applied: Correction[] } {
  const out = new Map(texts);
  const applied: Correction[] = [];
  const byId = new Map<string, Correction[]>();
  for (const c of corrections) {
    if (!byId.has(c.id)) byId.set(c.id, []);
    byId.get(c.id)!.push(c);
  }
  for (const [id, list] of byId) {
    const text = out.get(id);
    if (text === undefined) continue;
    const spans: Array<{ start: number; end: number; right: string }> = [];
    for (const c of [...list].sort((a, b) => b.wrong.length - a.wrong.length)) {
      for (let from = 0; ; ) {
        const at = text.indexOf(c.wrong, from);
        if (at < 0) break;
        const end = at + c.wrong.length;
        if (spans.some((sp) => at < sp.end && sp.start < end)) {
          from = at + 1;
          continue;
        }
        spans.push({ start: at, end, right: c.right });
        applied.push(c);
        break;
      }
    }
    if (spans.length === 0) continue;
    spans.sort((a, b) => a.start - b.start);
    let built = '';
    let pos = 0;
    for (const sp of spans) {
      built += text.slice(pos, sp.start) + sp.right;
      pos = sp.end;
    }
    out.set(id, built + text.slice(pos));
  }
  return { texts: out, applied };
}

/** 大きさの合計が budget を超えないようにまとめる（1 件で超える場合はそれ単独） */
function batchBy<T>(items: readonly T[], size: (item: T) => number, budget: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let total = 0;
  for (const item of items) {
    const n = size(item);
    if (current.length > 0 && total + n > budget) {
      batches.push(current);
      current = [];
      total = 0;
    }
    current.push(item);
    total += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 本文の文字数が charsPerCall を超えないようにまとめる（1 セクションが超える場合はそれ単独） */
export function batchSections(sections: readonly PolishInput[], charsPerCall: number): PolishInput[][] {
  return batchBy(sections, (s) => s.text.length, charsPerCall);
}

export interface LlmBackend {
  readonly name: string;
  /** prompt を送り、schema に従う JSON の文字列を返す */
  complete(prompt: string, schema: JsonSchema): Promise<string>;
}

export function createBackend(settings: LlmSettings): LlmBackend | null {
  switch (settings.kind) {
    case 'codex':
      return codexBackend(settings);
    case 'openai':
      return openaiBackend(settings);
    case 'ollama':
      return ollamaBackend(settings);
    default:
      return null;
  }
}

/** 利用者の Codex の既定（普段使っているモデルと推論の強さ） */
export type CodexDefaults = { model?: string; effort?: string };

/**
 * Codex の設定ファイル（config.toml）の中身から、既定のモデル（`model`）と推論の強さ（`model_reasoning_effort`）だけを読む。
 * 表の外（最初の `[...]` より前）の行だけを見る。プロファイルなどで決まる値は追わない（そのときは Codex の既定になる）
 */
export function parseCodexDefaults(configText: string): CodexDefaults {
  const out: CodexDefaults = {};
  for (const line of configText.split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*(model|model_reasoning_effort)\s*=\s*(["'])([^"']*)\2\s*(?:#.*)?$/);
    if (!m) continue;
    if (m[1] === 'model') out.model = m[3];
    // 推論の強さは -c の値（TOML）にそのまま埋めるので、英字だけのものに限る
    else if (/^[a-z]+$/.test(m[3]!)) out.effort = m[3];
  }
  return out;
}

/** `$CODEX_HOME/config.toml`（既定は ~/.codex/config.toml）から既定を読む。読めなければ空 */
async function readCodexDefaults(): Promise<CodexDefaults> {
  const home = process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
  try {
    return parseCodexDefaults(await readFile(path.join(home, 'config.toml'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * `codex exec` に渡す引数。
 * `--ignore-user-config` で利用者の設定ファイルを読まない（2026-09-29）。読むと、普段使いのプラグイン・MCP サーバー・通知のフックが
 * ノート作成の呼び出しにも読み込まれ、道具の説明の分だけ毎回の入力が増えるうえ（小さな呼び出しで 15,093〜15,483 トークンが
 * 13,571 に）、読み込む中身が呼ぶたびに変わってプロンプトのキャッシュが効かなかった（キャッシュが効いた分が 0 から 6,400〜11,520 に）。
 * ノート作成は道具を使わない。ログインは設定ファイルとは別なので、そのまま使える。
 * その代わり、モデルと推論の強さは明示する: モデルはサーバーの設定（`--llm-model`）を優先し、なければ利用者の既定を引き継ぐ。
 * 推論の強さも利用者の既定を引き継ぐ。どちらも今までと同じ値で呼ぶので、ノートの出来は変わらない
 */
export function codexArgs(opts: { dir: string; schemaFile: string; outFile: string; prompt: string } & CodexDefaults): string[] {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '-C',
    opts.dir,
    '--output-schema',
    opts.schemaFile,
    '--output-last-message',
    opts.outFile,
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`);
  args.push(opts.prompt);
  return args;
}

/** `codex exec` を非対話で呼ぶ。返答は --output-last-message のファイルから読む */
function codexBackend(settings: LlmSettings): LlmBackend {
  return {
    name: `codex${settings.model ? ` (${settings.model})` : ''}`,
    async complete(prompt, schema) {
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-codex-'));
      try {
        const schemaFile = path.join(tmp, 'schema.json');
        const outFile = path.join(tmp, 'last-message.txt');
        await writeFile(schemaFile, JSON.stringify(schema));
        const defaults = await readCodexDefaults();
        const args = codexArgs({ dir: tmp, schemaFile, outFile, prompt, model: settings.model || defaults.model, effort: defaults.effort });
        const r = await run(settings.codexBin, args, { signal: settings.signal });
        if (r.code !== 0) {
          throw new Error(`codex exec failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join(' / ')}`);
        }
        return await readFile(outFile, 'utf8');
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  };
}

function openaiBackend(settings: LlmSettings): LlmBackend {
  const model = settings.model || 'gpt-5-mini';
  return {
    name: `openai (${model})`,
    async complete(prompt, schema) {
      if (!settings.openaiApiKey) throw new Error('OPENAI_API_KEY が設定されていません');
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        signal: settings.signal,
        headers: { authorization: `Bearer ${settings.openaiApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_schema', json_schema: { name: 'lecture_notes', schema, strict: true } },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content ?? '';
    },
  };
}

function ollamaBackend(settings: LlmSettings): LlmBackend {
  const model = settings.model || 'qwen2.5:32b';
  return {
    name: `ollama (${model})`,
    async complete(prompt, schema) {
      const res = await fetch(`${settings.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        signal: settings.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], format: schema, stream: false }),
      });
      if (!res.ok) throw new Error(`Ollama error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { message?: { content?: string } };
      return json.message?.content ?? '';
    },
  };
}

/** セクションをまとめて呼び、id ごとの結果を返す。1 バッチの失敗はそのバッチだけ諦める */
export async function polish(
  sections: readonly PolishInput[],
  backend: LlmBackend,
  settings: LlmSettings,
  log: (message: string) => void = () => undefined,
): Promise<{ results: Map<string, PolishOutput>; errors: string[] }> {
  const results = new Map<string, PolishOutput>();
  const errors: string[] = [];
  const batches = batchSections(sections, settings.charsPerCall);

  /**
   * 1 回分を送る。返答が壊れた・足りないときは半分に分けて 1 度だけやり直す。
   * まとめて送るほど呼び出し回数は減るが、返答が長いほど途中で切れやすいので、その受け皿
   */
  const send = async (batch: PolishInput[], label: string, canSplit: boolean): Promise<void> => {
    if (settings.signal?.aborted) return;
    const ids = batch.map((s) => s.id);
    const chars = batch.reduce((n, s) => n + s.text.length, 0);
    log(`${backend.name}: ${label} (${ids.length} sections, ${chars} chars)`);
    let failure: string | null = null;
    // この呼び出しで答えが返った節だけを数える（前の試行の結果を成功と数えないため）
    const answered = new Set<string>();
    try {
      const raw = await backend.complete(buildPrompt(batch), POLISH_SCHEMA);
      for (const out of parseResponse(raw, ids)) {
        results.set(out.id, out);
        answered.add(out.id);
      }
      const missing = ids.filter((id) => !answered.has(id));
      if (missing.length > 0) failure = `no result for ${missing.join(', ')}`;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    if (!failure) return;
    // 「モデルが使えない」失敗は、分けて送り直してもモデルは現れないので打ち切る（受け皿が拾う。2026-10-01 のレビュー）
    if (canSplit && batch.length > 1 && !settings.signal?.aborted && !isModelUnavailable(failure)) {
      // 答えが返らなかった節だけをやり直す。全部だめなら半分に分けて送り直す（長すぎたとき用）
      const missing = batch.filter((s) => !answered.has(s.id));
      const retry = missing.length > 0 && missing.length < batch.length ? [missing] : [batch.slice(0, Math.ceil(batch.length / 2)), batch.slice(Math.ceil(batch.length / 2))];
      log(`${backend.name}: ${label} が失敗（${failure}）。${retry.length === 1 ? `足りない ${missing.length} 節だけ` : '半分に分けて'}やり直します`);
      for (const [i, part] of retry.entries()) {
        if (part.length > 0) await send(part, `${label}${retry.length === 1 ? 'r' : i === 0 ? 'a' : 'b'}`, retry.length === 1);
      }
      return;
    }
    errors.push(`${label}: ${failure}`);
  };

  for (const [i, batch] of batches.entries()) {
    if (settings.signal?.aborted) {
      errors.push('cancelled');
      break;
    }
    await send(batch, `batch ${i + 1}/${batches.length}`, true);
  }
  return { results, errors };
}

/** 整えた本文全体から、動画全体の要点と話題の区切りを 1 回の呼び出しで作る。失敗しても notes.md は作れる */
export async function outline(
  sections: ReadonlyArray<{ id: string; text: string }>,
  backend: LlmBackend,
  settings: LlmSettings,
  log: (message: string) => void = () => undefined,
): Promise<{ outline?: Outline; error?: string }> {
  if (settings.signal?.aborted) return { error: 'cancelled' };
  const ids = sections.map((s) => s.id);
  log(`${backend.name}: outline (${ids.length} sections, ${sections.reduce((n, s) => n + s.text.length, 0)} chars)`);
  try {
    const raw = await backend.complete(buildOutlinePrompt(sections), OUTLINE_SCHEMA);
    const result = parseOutline(raw, ids);
    if (result.overview.length === 0 && result.topics.length === 0) return { error: 'outline: empty' };
    return { outline: result };
  } catch (e) {
    return { error: `outline: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 校正: 整えた本文を原文と突き合わせ、誤変換だけの直しをもらう（§13.5、2026-09-30）。
 * 1 回に入れる文字数（原文＋整え済み）は charsPerCall を目安にまとめる。1 バッチの失敗はそのバッチだけ諦める
 * （直しが入らないだけで、本文はそのまま使える）
 */
export async function check(
  sections: readonly CheckInput[],
  backend: LlmBackend,
  settings: LlmSettings,
  log: (message: string) => void = () => undefined,
): Promise<{ corrections: Correction[]; errors: string[] }> {
  const corrections: Correction[] = [];
  const errors: string[] = [];
  const batches = batchBy(sections, (s) => s.original.length + s.polished.length, settings.charsPerCall);
  for (const [i, batch] of batches.entries()) {
    if (settings.signal?.aborted) {
      errors.push('cancelled');
      break;
    }
    const label = `check ${i + 1}/${batches.length}`;
    log(`${backend.name}: ${label} (${batch.length} sections, ${batch.reduce((n, s) => n + s.original.length + s.polished.length, 0)} chars)`);
    try {
      const raw = await backend.complete(buildCheckPrompt(batch), CHECK_SCHEMA);
      corrections.push(...parseCorrections(raw, batch.map((s) => s.id)));
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { corrections, errors };
}

/**
 * 失敗の文面が「モデルが使えない」（プランにない、存在しない、アクセス権がない、廃止された）を指しているか。
 * codex (ChatGPT): "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account."
 * OpenAI API: "The model `x` does not exist or you do not have access to it."
 * Ollama: "model 'x' not found, try pulling it first"
 * 文字列の判定なので取り違えはありうる（codex は構造化された失敗を返さないため、ここに倒している）。誤って当たっても
 * 本文のモデルで校正を 1 回やり直すだけ、取りこぼしても未校正で完成してログに残るだけで、どちらも壊れはしない
 */
export function isModelUnavailable(message: string): boolean {
  return /model/i.test(message) && /(not supported|unsupported|not found|does not exist|do not have access|not available|unavailable|deprecated|invalid model|unknown model)/i.test(message);
}

/**
 * 校正を呼び、「指定したモデルが使えない」失敗が 1 つでもあれば、fallback（本文を整えたのと同じモデル。直前の polish で
 * 使えると分かっている）で 1 度だけやり直す（2026-10-01）。校正モデルの指定間違い・プランの違いで未校正のまま完成させない。
 * 1 つでも、としたのは、モデルは途中で使えるようにはならないので、枠切れなどの別の失敗が混ざっていても判断は変わらないため
 * （全部そろったときだけにすると、混在した講義で受け皿が動かない。2026-10-01 のレビュー）。
 * 使えなかったことはログに残すだけで、呼び出し側の記録（checkErrors）には fallback の結果だけが載る。
 * モデル不可の失敗がない（枠切れだけなど）ときはやり直さない（同じ枠を別のモデルで二重に使わない）
 */
export async function checkWithFallback(
  sections: readonly CheckInput[],
  backend: LlmBackend,
  fallback: LlmBackend | null,
  settings: LlmSettings,
  log: (message: string) => void = () => undefined,
): Promise<{ corrections: Correction[]; errors: string[] }> {
  const first = await check(sections, backend, settings, log);
  if (!fallback || first.corrections.length > 0 || !first.errors.some(isModelUnavailable)) return first;
  log(`校正のモデル（${backend.name}）が使えないようです: ${first.errors.find(isModelUnavailable)}。${fallback.name} で校正し直します`);
  return await check(sections, fallback, settings, log);
}
