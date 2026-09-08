// LecScribe サーバーを macOS の launchd（ユーザーエージェント）に登録する。
// ログイン時に自動起動し、落ちても再起動されるので、ターミナルで起動しておく必要がなくなる。
//
//   node server/scripts/agent.mjs install    登録して起動（既に登録済みなら更新して再起動）
//   node server/scripts/agent.mjs uninstall  停止して登録を外す
//   node server/scripts/agent.mjs status     登録状態と /health
//   node server/scripts/agent.mjs restart    再起動（サーバーのコードを更新したあとに）
//   node server/scripts/agent.mjs print      plist の内容を表示するだけ
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.lec-scribe.server';
const home = os.homedir();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const plistPath = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logDir = path.join(home, 'Library', 'Logs', 'lec-scribe');
const logPath = path.join(logDir, 'server.log');
const tokenPath = path.join(home, '.lec-scribe', 'token');
const port = Number(process.env.LEC_SCRIBE_PORT ?? 47321);
const domain = `gui/${os.userInfo().uid}`;

const command = process.argv[2] ?? 'status';
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

function plistXml() {
  // launchd の PATH には /opt/homebrew/bin が入らないので、今のシェルの PATH をそのまま渡す
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const args = [process.execPath, path.join(repoRoot, 'server', 'src', 'index.ts')];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escape(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${escape(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(process.env.PATH ?? '/usr/bin:/bin')}</string>
    <key>HOME</key><string>${escape(home)}</string>
    <key>LEC_SCRIBE_PORT</key><string>${port}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(logPath)}</string>
  <key>StandardErrorPath</key><string>${escape(logPath)}</string>
</dict>
</plist>
`;
}

async function health() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return await res.json();
  } catch {
    return null;
  }
}

function isLoaded() {
  return run('launchctl', ['print', `${domain}/${LABEL}`]).status === 0;
}

async function install() {
  if (process.platform !== 'darwin') {
    console.error('launchd は macOS 専用です。');
    process.exit(1);
  }
  const alreadyUp = await health();
  if (alreadyUp && !isLoaded()) {
    console.error(`ポート ${port} で別のサーバーが動いています（ターミナルで起動した分など）。先に止めてください（Ctrl+C）。`);
    process.exit(1);
  }
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(plistPath, plistXml());
  if (isLoaded()) run('launchctl', ['bootout', `${domain}/${LABEL}`]);
  const boot = run('launchctl', ['bootstrap', domain, plistPath]);
  if (boot.status !== 0) {
    console.error(`launchctl bootstrap に失敗しました: ${boot.stderr || boot.stdout}`);
    process.exit(1);
  }
  console.log(`登録しました: ${plistPath}`);
  console.log(`ログ: ${logPath}`);
  await waitAndReport();
}

async function waitAndReport() {
  for (let i = 0; i < 20; i++) {
    const h = await health();
    if (h) {
      console.log(`サーバー v${h.version} が http://127.0.0.1:${port} で動いています（model: ${h.model}, whisperkit: ${h.whisperkit ? 'あり' : 'なし'}, ffmpeg: ${h.ffmpeg ? 'あり' : 'なし'}）`);
      if (existsSync(tokenPath)) console.log(`トークン: ${readFileSync(tokenPath, 'utf8').trim()}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`サーバーが応答しません。ログを確認してください: ${logPath}`);
  process.exit(1);
}

function uninstall() {
  if (isLoaded()) run('launchctl', ['bootout', `${domain}/${LABEL}`]);
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log('登録を外しました。');
}

async function status() {
  console.log(`登録: ${existsSync(plistPath) ? plistPath : 'なし'}`);
  console.log(`launchd: ${isLoaded() ? '読み込み済み' : '未読み込み'}`);
  const h = await health();
  console.log(h ? `サーバー: v${h.version} が http://127.0.0.1:${port} で応答（model: ${h.model}）` : `サーバー: http://127.0.0.1:${port} は応答なし`);
  if (existsSync(logPath)) console.log(`ログ: ${logPath}`);
}

async function restart() {
  if (!isLoaded()) {
    console.error('登録されていません。先に install してください。');
    process.exit(1);
  }
  run('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]);
  await waitAndReport();
}

switch (command) {
  case 'install':
    await install();
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'status':
    await status();
    break;
  case 'restart':
    await restart();
    break;
  case 'print':
    process.stdout.write(plistXml());
    break;
  default:
    console.error(`unknown command: ${command} (install | uninstall | status | restart | print)`);
    process.exit(1);
}
