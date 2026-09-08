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
 * どれも「セクションの配列 → 同じ id で整えた本文と要点」を JSON で返させる。
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
};

export type PolishInput = { id: string; heading: string; text: string };
export type PolishOutput = { id: string; summary: string[]; text: string };

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          summary: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
        },
        required: ['id', 'summary', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['sections'],
  additionalProperties: false,
} as const;

export function buildPrompt(sections: readonly PolishInput[]): string {
  const body = sections
    .map((s) => `<<<SECTION id="${s.id}" heading="${s.heading}">>>\n${s.text.trim() || '（発話なし）'}\n<<<END>>>`)
    .join('\n\n');
  return `あなたは大学講義のノートを作る編集者です。以下は講義音声の自動文字起こし（話し言葉）を、スライドごとに区切ったものです。各セクションについて次の 2 つを作ってください。

1. text: 内容と順序を変えずに、フィラー（「えー」「あの」「まあ」「ですね」「〜と思うんですが」「〜かなと思います」など）や言い直しを取り除き、読みやすい書き言葉（です・ます調）に整えた本文。要約や補足はしない。専門用語・固有名詞は文字起こしのまま残す。明らかな誤変換だけ文脈から直す。段落は「\\n\\n」で区切る。
2. summary: そのセクションの要点を日本語の箇条書きで 2〜6 項目。各項目は 1 文で、記号や番号は付けない。

出力は指定された JSON スキーマに従い、sections の id と順序は入力と同じにしてください。本文が「（発話なし）」のセクションは text を空文字、summary を空配列にしてください。

${body}`;
}

/** LLM の返答（JSON。前後に説明や \`\`\` フェンスが付いていても許容）を読む */
export function parseResponse(raw: string, expectedIds: readonly string[]): PolishOutput[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('LLM の返答に JSON がありません');
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { sections?: unknown };
  if (!Array.isArray(parsed.sections)) throw new Error('LLM の返答に sections がありません');
  const wanted = new Set(expectedIds);
  const out: PolishOutput[] = [];
  for (const item of parsed.sections as Array<Record<string, unknown>>) {
    const id = String(item['id'] ?? '');
    if (!wanted.has(id)) continue;
    const summary = Array.isArray(item['summary']) ? item['summary'].map((s) => String(s).trim()).filter(Boolean) : [];
    out.push({ id, summary, text: String(item['text'] ?? '').trim() });
  }
  return out;
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
  complete(prompt: string): Promise<string>;
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
    async complete(prompt) {
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-codex-'));
      try {
        const schemaFile = path.join(tmp, 'schema.json');
        const outFile = path.join(tmp, 'last-message.txt');
        await writeFile(schemaFile, JSON.stringify(RESPONSE_SCHEMA));
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
        const r = await run(settings.codexBin, args);
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
    async complete(prompt) {
      if (!settings.openaiApiKey) throw new Error('OPENAI_API_KEY が設定されていません');
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${settings.openaiApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_schema', json_schema: { name: 'lecture_sections', schema: RESPONSE_SCHEMA, strict: true } },
        }),
      });
      const json = (await res.json()) as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }> };
      if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${json.error?.message ?? ''}`);
      return json.choices?.[0]?.message?.content ?? '';
    },
  };
}

function ollamaBackend(settings: LlmSettings): LlmBackend {
  const model = settings.model || 'qwen2.5:32b';
  return {
    name: `ollama (${model})`,
    async complete(prompt) {
      const res = await fetch(`${settings.ollamaUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], format: RESPONSE_SCHEMA, stream: false }),
      });
      const json = (await res.json()) as { error?: string; message?: { content?: string } };
      if (!res.ok) throw new Error(`Ollama error ${res.status}: ${json.error ?? ''}`);
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
  for (const [i, batch] of batches.entries()) {
    const ids = batch.map((s) => s.id);
    log(`${backend.name}: batch ${i + 1}/${batches.length} (${ids.length} sections, ${batch.reduce((n, s) => n + s.text.length, 0)} chars)`);
    try {
      const raw = await backend.complete(buildPrompt(batch));
      for (const out of parseResponse(raw, ids)) results.set(out.id, out);
      const missing = ids.filter((id) => !results.has(id));
      if (missing.length > 0) errors.push(`batch ${i + 1}: no result for ${missing.join(', ')}`);
    } catch (e) {
      errors.push(`batch ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { results, errors };
}
