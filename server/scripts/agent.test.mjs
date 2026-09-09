// agent.mjs print が plist に書く EnvironmentVariables を確かめる。
// print は launchctl を触らないので、HOME を一時ディレクトリに向ければ副作用なく試せる。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const agent = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent.mjs');
let home;

/** HOME 配下に既存の plist を置く */
function writePlist(envDict) {
  const dir = path.join(home, 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'com.lec-scribe.server.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lec-scribe.server</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin</string>
    <key>LEC_SCRIBE_PORT</key><string>47321</string>
${envDict}
  </dict>
  <key>StandardOutPath</key><string>${home}/Library/Logs/lec-scribe/server.log</string>
</dict>
</plist>
`,
  );
}

/** print の出力から EnvironmentVariables の中身だけ取り出す */
function printedEnv(extraEnv = {}) {
  const r = spawnSync(process.execPath, [agent, 'print'], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, ...extraEnv },
  });
  expect(r.status).toBe(0);
  const dict = r.stdout.split('<key>EnvironmentVariables</key>')[1] ?? '';
  const out = {};
  for (const m of dict.matchAll(/<key>([^<]+)<\/key><string>([^<]*)<\/string>/g)) out[m[1]] = m[2];
  return out;
}

describe('agent.mjs の設定引き継ぎ', () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'lec-scribe-agent-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('環境変数が無くても、既に登録されている plist の設定を引き継ぐ', () => {
    writePlist('    <key>LEC_SCRIBE_LLM</key><string>codex</string>\n    <key>OPENAI_API_KEY</key><string>sk-x&amp;y</string>');
    expect(printedEnv()).toMatchObject({ LEC_SCRIBE_LLM: 'codex', OPENAI_API_KEY: 'sk-x&amp;y' });
  });

  it('plutil で開いたあとのように改行が入っていても読める', () => {
    writePlist('    <key>LEC_SCRIBE_LLM</key>\n    <string>ollama</string>');
    expect(printedEnv()).toMatchObject({ LEC_SCRIBE_LLM: 'ollama' });
  });

  it('環境変数のほうが優先され、空文字なら引き継ぎをやめる', () => {
    writePlist('    <key>LEC_SCRIBE_LLM</key><string>openai</string>\n    <key>LEC_SCRIBE_LLM_MODEL</key><string>gpt-5-mini</string>');
    const env = printedEnv({ LEC_SCRIBE_LLM: 'ollama', LEC_SCRIBE_LLM_MODEL: '' });
    expect(env['LEC_SCRIBE_LLM']).toBe('ollama');
    expect(env).not.toHaveProperty('LEC_SCRIBE_LLM_MODEL');
  });

  it('PATH と LEC_SCRIBE_PORT は plist から引き継がず、今の値で書き直す', () => {
    writePlist('');
    const env = printedEnv({ LEC_SCRIBE_PORT: '47399' });
    expect(env['LEC_SCRIBE_PORT']).toBe('47399');
    expect(env['PATH']).toBe(process.env['PATH'] ?? '/usr/bin:/bin');
  });
});
