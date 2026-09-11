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
import { applyUpdate, checkForUpdate } from './update.ts';

const config = loadConfig();
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

await mkdir(config.outDir, { recursive: true });
const { token, created } = await loadOrCreateToken(config.tokenFile);

const missing: string[] = [];
if (!(await resolveBin(config.ffmpegBin))) missing.push(`ffmpeg（${config.ffmpegBin}）`);
if (!(await resolveBin(config.whisperkitBin))) missing.push(`whisperkit-cli（${config.whisperkitBin}）`);

const trusted = await loadTrusted(config.trustedFile);
const { server, pipeline, status } = createApp(config, token, log, trusted);
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

/**
 * 起動時の自動更新（SPEC §12.1b）。origin/main が進んでいれば、処理が空いてから fast-forward して終了する。
 * launchd の KeepAlive が起動し直す。拡張がパネルを開いていれば /health の updating を見て Start を止める
 */
if (config.autoUpdate) void autoUpdate();

async function autoUpdate(): Promise<void> {
  const check = await checkForUpdate(config.appDir);
  if (check.skipped) {
    log(`自動更新: 確認しません（${check.skipped}）`);
    return;
  }
  if (!check.available) {
    log('自動更新: 最新です');
    return;
  }
  log(`自動更新: 新しい版があります（${check.behind} コミット）。処理が空いたら入れ替えます`);
  status.updating = true;
  while (pipeline.activeCount() > 0) await sleep(5_000);
  if (!(await applyUpdate(config.appDir, log))) {
    status.updating = false;
    return;
  }
  // 開いているパネルが「更新中」を拾えるよう、少し待ってから止める（パネルは 5 秒ごとに /health を見る）
  log('自動更新: 入れ替えました。10 秒後に止まります（launchd が新しいコードで起動し直します）');
  await sleep(10_000);
  server.close();
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
