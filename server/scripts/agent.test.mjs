// agent.mjs print が plist に書く EnvironmentVariables を確かめる。
// print は launchctl を触らないので、HOME を一時ディレクトリに向ければ副作用なく試せる。
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

describe('agent.mjs print-launcher', () => {
  /**
   * 起動用アプリに差し込むパスがシェルに壊されないこと（#10）。
   * LEC_SCRIBE_APP_DIR は利用者が決められるので、$ を含む場所に置かれうる。
   * 素のまま二重引用符に入れると /bin/sh が $po を空に展開し、launcher が別の場所を exec して
   * 起動に失敗する。サーバーが起動しないと自動更新も走らないので、自力では直らなくなる
   */
  it('$ を含む場所に置いても、パスがそのまま渡る', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'lec-scribe-agent-'));
    try {
      // ESM は読み込むときに symlink を解くので、比べる側も実体のパスにそろえる（macOS の /var → /private/var）
      const repo = path.join(realpathSync(tmp), 're$po');
      const scripts = path.join(repo, 'server', 'scripts');
      mkdirSync(scripts, { recursive: true });
      copyFileSync(agent, path.join(scripts, 'agent.mjs'));
      const printed = spawnSync(process.execPath, [path.join(scripts, 'agent.mjs'), 'print-launcher'], {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: tmp },
      });
      expect(printed.status).toBe(0);
      // 代入の部分だけ /bin/sh に読ませて、変数の中身が元のパスと一致するか見る
      const assigns = printed.stdout.split('\n').filter((l) => /^(LEC_SCRIBE_NODE|START)=/.test(l));
      expect(assigns).toHaveLength(2);
      const shown = spawnSync('/bin/sh', ['-c', `${assigns.join('\n')}\nprintf '%s' "$START"`], { encoding: 'utf8' });
      expect(shown.stdout).toBe(path.join(repo, 'server', 'scripts', 'start.sh'));
      // start.sh が読めないときに直接起動へ落ちる行が残っていること（巻き戻しでの起動不能を防ぐ）
      expect(printed.stdout).toContain('--experimental-strip-types');
      expect(printed.stdout).toContain(`'${path.join(repo, 'server', 'src', 'index.ts')}'`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
