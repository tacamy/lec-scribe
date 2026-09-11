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

/** 本文の文字数が charsPerCall を超えないようにまとめる（1 セクションが超える場合はそれ単独） */
export function batchSections(sections: readonly PolishInput[], charsPerCall: number): PolishInput[][] {
  const batches: PolishInput[][] = [];
  let current: PolishInput[] = [];
  let size = 0;
  for (const s of sections) {
    const len = s.text.length;
    if (current.length > 0 && size + len > charsPerCall) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
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
        const args = [
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '--sandbox',
          'read-only',
          '--color',
          'never',
          '-C',
          tmp,
          '--output-schema',
          schemaFile,
          '--output-last-message',
          outFile,
        ];
        if (settings.model) args.push('--model', settings.model);
        args.push(prompt);
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
    if (canSplit && batch.length > 1 && !settings.signal?.aborted) {
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
