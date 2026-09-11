/**
 * LecScribe ローカルサーバー（SPEC §12）。
 *
 * 127.0.0.1 だけで待ち受け、拡張から受け取った録音・スライド・タイムラインを
 * ~/LecScribe/<セッション>/ に置き、ffmpeg → whisperkit-cli で文字起こしして
 * transcript.json / .txt / .srt / .vtt を書く。
 *
 *   pnpm --filter @lec-scribe/server start -- --port 47321 --out ~/LecScribe --model large-v3
 */
import { mkdir } from 'node:fs/promises';
import { createApp, VERSION } from './app.ts';
import { recoverInterrupted } from './pipeline.ts';
import { loadConfig } from './config.ts';
import { resolveBin } from './exec.ts';
import { loadOrCreateToken } from './token.ts';
import { loadTrusted } from './pairing.ts';
import { selfUpdate } from './update.ts';

const config = loadConfig();
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

await mkdir(config.outDir, { recursive: true });
const { token, created } = await loadOrCreateToken(config.tokenFile);

const missing: string[] = [];
const [ffmpeg, whisperkit] = await Promise.all([resolveBin(config.ffmpegBin), resolveBin(config.whisperkitBin)]);
if (!ffmpeg) missing.push(`ffmpeg（${config.ffmpegBin}）`);
if (!whisperkit) missing.push(`whisperkit-cli（${config.whisperkitBin}）`);

// 自動更新（§12.1b）。listen する前に済ませる。入れ替えたら終了し、launchd が新しいコードで起動し直す
if (config.autoUpdate) {
  const result = await selfUpdate({ appDir: config.appDir, branch: config.branch, gitBin: config.gitBin, log });
  if (result.updated) {
    log('自動更新: 入れ替えました。新しいコードで起動し直します');
    process.exit(0);
  }
  log(`自動更新: ${result.reason}`);
}

const trusted = await loadTrusted(config.trustedFile);
const { server } = createApp(config, token, log, trusted);
await recoverInterrupted(config.outDir, log);
server.listen(config.port, config.host, () => {
  console.log(`LecScribe server v${VERSION}`);
  console.log(`  listening : http://${config.host}:${config.port}`);
  console.log(`  output    : ${config.outDir}`);
  console.log(`  model     : ${config.model} (${config.language})`);
  console.log(`  llm       : ${config.llm === 'none' ? 'なし（notes.md は文字起こしのまま）' : config.llm + (config.llmModel ? ` (${config.llmModel})` : '')}`);
  console.log(`  trusted   : ${trusted.entries.size} 件の拡張を承認済み（${config.trustedFile}）`);
  console.log(`  token     : ${config.tokenFile}${created ? '（新規作成）' : ''}`);
  console.log('');
  console.log('  拡張機能の設定（オプション）で「このMacと接続」を押し、Mac のダイアログで「許可」してください。');
  console.log(`  トークンで繋ぐ場合は次を貼り付けます: ${token}`);
  console.log('');
  if (missing.length > 0) {
    console.log(`  ⚠ 見つからないコマンド: ${missing.join(', ')}`);
    console.log('    brew install whisperkit-cli ffmpeg  で導入できます。受信はできますが文字起こしは失敗します。');
    console.log('');
  }
});
