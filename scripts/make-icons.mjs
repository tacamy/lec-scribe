// extension/assets/icon.svg から、拡張とストアに要る大きさの PNG を extension/public/icon/ に作る。
// WXT は public/icon/<size>.png を見つけて manifest の icons に入れる。描画は headless Chromium（Playwright）で行う。
// 使い方: node scripts/make-icons.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(path.join(root, 'extension/assets/icon.svg'), 'utf8');
const outDir = path.join(root, 'extension/public/icon');
await mkdir(outDir, { recursive: true });

const SIZES = [16, 32, 48, 96, 128];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    // 背景を透明にして、角丸の外側が白くならないようにする
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`,
    );
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await writeFile(path.join(outDir, `${size}.png`), png);
    console.log(`icon ${size}px: ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
