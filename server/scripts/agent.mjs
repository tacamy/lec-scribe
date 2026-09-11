// LecScribe サーバーを macOS の launchd（ユーザーエージェント）に登録する。
// ログイン時に自動起動し、落ちても再起動されるので、ターミナルで起動しておく必要がなくなる。
//
//   node server/scripts/agent.mjs install    登録して起動（既に登録済みなら更新して再起動）
//   node server/scripts/agent.mjs uninstall  停止して登録を外す
//   node server/scripts/agent.mjs status     登録状態と /health
//   node server/scripts/agent.mjs restart    再起動（サーバーのコードを更新したあとに。処理中なら拒む。--force で強制）
//   node server/scripts/agent.mjs print      plist の内容を表示するだけ
//   node server/scripts/agent.mjs print-launcher  起動用アプリの中身を表示するだけ
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
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
/** /bin/sh に渡す 1 語。$ や空白を含むパス（LEC_SCRIBE_APP_DIR は利用者が決められる）でも壊れない */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * launcher（アプリバンドルの実行ファイル）の中身。差し込むパスは必ず shq() で囲む。
 * 中身だけ確かめられるよう関数にしてある（agent.mjs print-launcher）
 */
function launcherScript() {
  return `#!/bin/sh
# LecScribe Server: launchd から起動される。起動の中身はリポジトリの start.sh にあり、git の更新で変わる。
# LEC_SCRIBE_NODE は予備の node（登録したときの実体）。PATH に使える node が無いときだけ使われる。
# start.sh が無い版（2026-09-11 より前）に巻き戻っても起動できるよう、直接起動にも落とせるようにしておく。
# これが無いと、start.sh を持たないコミットに戻した瞬間に launchd が 10 秒ごとの起動失敗を繰り返し、
# サーバーが起動しない＝自動更新も走らないので、自力では二度と直らない
LEC_SCRIBE_NODE=${shq(process.execPath)}
export LEC_SCRIBE_NODE
START=${shq(path.join(repoRoot, 'server', 'scripts', 'start.sh'))}
[ -r "$START" ] && exec /bin/sh "$START" "$@"
NODE="$(command -v node 2>/dev/null || true)"
[ -x "$NODE" ] || NODE="$LEC_SCRIBE_NODE"
exec "$NODE" --experimental-strip-types ${shq(path.join(repoRoot, 'server', 'src', 'index.ts'))} "$@"
`;
}

/**
 * ~/Applications/LecScribe Server.app を作る。中身はリポジトリの server/scripts/start.sh を exec するだけ。
 * node の探し方や起動フラグのようにコードに依存するものは start.sh 側（git で届く）に置き、
 * ここで作るものにはリポジトリの場所と予備の node しか書かない（#10）
 */
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
  writeFileSync(appExecutable, launcherScript(), { mode: 0o755 });
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
${Object.entries(settingsEnv())
  .map(([k, v]) => `    <key>${k}</key><string>${escape(v)}</string>`)
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

/**
 * plist に書く設定（LEC_SCRIBE_* と OPENAI_API_KEY）。今の環境変数が優先で、
 * 無ければ既に登録されている plist の値を引き継ぐ。install.sh を後から流し直しても
 * enable-notes.sh で入れた LEC_SCRIBE_LLM が消えないようにするため。
 * 空文字で渡した変数は「消す」指定（引き継ぎをやめる。例: バックエンドを切り替えるときの
 * LEC_SCRIBE_LLM_MODEL=、API キーを外すときの OPENAI_API_KEY=）
 */
function settingsEnv() {
  // launchd で常駐していることの印。サーバーはこれがあるときだけ自動更新する（SPEC §12.1b）。
  // 手で起動したサーバーや smoke テストが開発者の作業ツリーを書き換えないようにするため
  const merged = { LEC_SCRIBE_MANAGED: '1' };
  if (existsSync(plistPath)) {
    const xml = readFileSync(plistPath, 'utf8');
    if (xml.includes('<?xml')) {
      const dict = xml.split('<key>EnvironmentVariables</key>')[1] ?? '';
      // plutil や Xcode で開くと <key> と <string> の間に改行が入るので、空白を挟んでも読めるようにする
      for (const m of dict.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) {
        if (isSetting(m[1])) merged[m[1]] = unescapeXml(m[2]);
      }
    } else {
      // バイナリ plist などで読めないと、黙って設定が消えたように見えるので知らせる
      console.warn(`既存の plist を読めませんでした（XML ではありません）: ${plistPath}。LEC_SCRIBE_* の設定は引き継がれません。`);
    }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (!isSetting(k) || v === undefined) continue;
    if (v === '') delete merged[k];
    else merged[k] = v;
  }
  return merged;
}

const isSetting = (key) => (key.startsWith('LEC_SCRIBE_') && key !== 'LEC_SCRIBE_PORT') || key === 'OPENAI_API_KEY';
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** /health の llm を人が読む 1 行にする（install / restart / status で同じ文言を出す） */
const notesLine = (h) =>
  `ノート作成: ${h?.llm && h.llm !== 'none' ? h.llm : `なし（notes.md は文字起こしそのまま。bash "${repoRoot}/enable-notes.sh" で有効にできます）`}`;

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
  writeFileSync(plistPath, plistXml(), { mode: 0o600 }); // OPENAI_API_KEY などを含むので本人だけ読める
  chmodSync(plistPath, 0o600); // 既存ファイルの mode は writeFileSync では変わらない
  if (isLoaded()) run('launchctl', ['bootout', `${domain}/${LABEL}`]);
  // bootout の直後は launchd 側の後始末が終わっておらず bootstrap が "5: Input/output error" で失敗することがあるので少し待って再試行する
  let boot = run('launchctl', ['bootstrap', domain, plistPath]);
  for (let i = 0; boot.status !== 0 && i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    boot = run('launchctl', ['bootstrap', domain, plistPath]);
  }
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
      console.log(notesLine(h));
      console.log('Chrome の LecScribe アイコンを押して「このMacと接続」→ Mac のダイアログで「許可」してください。');
      if (existsSync(tokenPath)) console.log(`（トークンで繋ぐ場合: ${readFileSync(tokenPath, 'utf8').trim()}）`);
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
  if (h) console.log(notesLine(h));
  if (existsSync(logPath)) console.log(`ログ: ${logPath}`);
}

async function restart() {
  if (!isLoaded()) {
    console.error('登録されていません。先に install してください。');
    process.exit(1);
  }
  // 文字起こし・ノート作成の途中で止めると、そのセッションはやり直しになる
  const h = await health();
  if (h?.processing > 0 && !process.argv.includes('--force')) {
    console.error(`サーバーは ${h.processing} 件を処理中です。終わってから再起動するか、--force を付けてください。`);
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
  case 'print-launcher':
    process.stdout.write(launcherScript());
    break;
  default:
    console.error(`unknown command: ${command} (install | uninstall | status | restart | print | print-launcher)`);
    process.exit(1);
}
