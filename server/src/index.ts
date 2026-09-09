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
import { loadConfig } from './config.ts';
import { resolveBin } from './exec.ts';
import { loadOrCreateToken } from './token.ts';

const config = loadConfig();
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

await mkdir(config.outDir, { recursive: true });
const { token, created } = await loadOrCreateToken(config.tokenFile);

const missing: string[] = [];
if (!(await resolveBin(config.ffmpegBin))) missing.push(`ffmpeg（${config.ffmpegBin}）`);
if (!(await resolveBin(config.whisperkitBin))) missing.push(`whisperkit-cli（${config.whisperkitBin}）`);

const { server } = createApp(config, token, log);
server.listen(config.port, config.host, () => {
  console.log(`LecScribe server v${VERSION}`);
  console.log(`  listening : http://${config.host}:${config.port}`);
  console.log(`  output    : ${config.outDir}`);
  console.log(`  model     : ${config.model} (${config.language})`);
  console.log(`  llm       : ${config.llm === 'none' ? 'なし（notes.md は文字起こしのまま）' : config.llm + (config.llmModel ? ` (${config.llmModel})` : '')}`);
  console.log(`  token     : ${config.tokenFile}${created ? '（新規作成）' : ''}`);
  console.log('');
  console.log('  拡張機能の設定（オプション）に次のトークンを貼り付けてください:');
  console.log(`  ${token}`);
  console.log('');
  if (missing.length > 0) {
    console.log(`  ⚠ 見つからないコマンド: ${missing.join(', ')}`);
    console.log('    brew install whisperkit-cli ffmpeg  で導入できます。受信はできますが文字起こしは失敗します。');
    console.log('');
  }
});
