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
const APP_NAME = 'LecScribe Server';
const home = os.homedir();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const plistPath = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
// 「ログイン項目と機能拡張」に表示される名前は実行ファイルの署名者（node なら Node.js Foundation）に
// なってしまうので、小さなアプリバンドル経由で起動し、その名前を出させる
const appDir = path.join(home, 'Applications', `${APP_NAME}.app`);
// 表示名は実行ファイル名から取られることがあるので、実行ファイル自体を表示したい名前にする
const appExecutable = path.join(appDir, 'Contents', 'MacOS', APP_NAME);
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const logDir = path.join(home, 'Library', 'Logs', 'lec-scribe');
const logPath = path.join(logDir, 'server.log');
const tokenPath = path.join(home, '.lec-scribe', 'token');
const port = Number(process.env.LEC_SCRIBE_PORT ?? 47321);
const domain = `gui/${os.userInfo().uid}`;

const command = process.argv[2] ?? 'status';
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ~/Applications/LecScribe Server.app を作る。中身は node でサーバーを exec するだけのスクリプト */
function writeAppBundle() {
  // 古い名前の実行ファイルが残らないように作り直す
  if (existsSync(appDir)) rmSync(appDir, { recursive: true });
  mkdirSync(path.join(appDir, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(
    path.join(appDir, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
`,
  );
  writeFileSync(
    appExecutable,
    `#!/bin/sh
# LecScribe Server: launchd から起動される。サーバー本体は Node で動く
exec "${process.execPath}" "${path.join(repoRoot, 'server', 'src', 'index.ts')}"
`,
    { mode: 0o755 },
  );
  if (existsSync(LSREGISTER)) run(LSREGISTER, ['-f', appDir]);
}

function plistXml() {
  // launchd の PATH には /opt/homebrew/bin が入らないので、今のシェルの PATH をそのまま渡す
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${LABEL}</string>
  </array>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(appExecutable)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escape(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(process.env.PATH ?? '/usr/bin:/bin')}</string>
    <key>HOME</key><string>${escape(home)}</string>
    <key>LEC_SCRIBE_PORT</key><string>${port}</string>
${Object.entries(process.env)
  .filter(([k]) => (k.startsWith('LEC_SCRIBE_') && k !== 'LEC_SCRIBE_PORT') || k === 'OPENAI_API_KEY')
  .map(([k, v]) => `    <key>${k}</key><string>${escape(v ?? '')}</string>`)
  .join('\n')}
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
  writeAppBundle();
  writeFileSync(plistPath, plistXml());
  if (isLoaded()) run('launchctl', ['bootout', `${domain}/${LABEL}`]);
  const boot = run('launchctl', ['bootstrap', domain, plistPath]);
  if (boot.status !== 0) {
    console.error(`launchctl bootstrap に失敗しました: ${boot.stderr || boot.stdout}`);
    process.exit(1);
  }
  console.log(`登録しました: ${plistPath}`);
  console.log(`起動用アプリ: ${appDir}（「ログイン項目と機能拡張」には「${APP_NAME}」として表示されます）`);
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
  if (existsSync(appDir)) {
    if (existsSync(LSREGISTER)) run(LSREGISTER, ['-u', appDir]);
    rmSync(appDir, { recursive: true });
  }
  console.log('登録を外しました。');
}

async function status() {
  console.log(`登録: ${existsSync(plistPath) ? plistPath : 'なし'}`);
  console.log(`起動用アプリ: ${existsSync(appDir) ? appDir : 'なし'}`);
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
