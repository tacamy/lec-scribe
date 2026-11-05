import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('loadConfig のノート作成のモデル', () => {
  it('codex で何も指定しなければ、設定画面の「推奨」と同じ（最新の Terra で整え、最新の Astra で校正。2026-11-05）', () => {
    const config = loadConfig(['--llm', 'codex'], {});
    expect(config).toMatchObject({ llm: 'codex', llmModel: 'latest:terra', llmCheckModel: 'latest:astra', llmPickModel: 'latest:terra' });
  });

  it('引数・環境変数の指定が優先し、空を渡せば校正なし・既定のモデルにできる', () => {
    expect(loadConfig([], { LEC_SCRIBE_LLM: 'codex', LEC_SCRIBE_LLM_MODEL: 'gpt-5.6-terra' })).toMatchObject({ llmModel: 'gpt-5.6-terra', llmCheckModel: 'latest:astra' });
    expect(loadConfig(['--llm', 'codex', '--llm-model=', '--llm-check-model='], {})).toMatchObject({ llmModel: '', llmCheckModel: '' });
    expect(loadConfig(['--llm', 'codex'], { LEC_SCRIBE_LLM_CHECK_MODEL: '' })).toMatchObject({ llmCheckModel: '' });
  });

  it('openai・ollama・無効では、今までどおり指定なし（モデル名の体系が違うため）', () => {
    for (const llm of ['openai', 'ollama', 'none']) {
      expect(loadConfig(['--llm', llm], {}), llm).toMatchObject({ llmModel: '', llmCheckModel: '' });
    }
  });
});
