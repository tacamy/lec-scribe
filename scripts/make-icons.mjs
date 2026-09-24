// extension/assets/icon.png（なければ icon.svg）から、拡張に要る大きさの PNG を extension/public/icon/ に、
// ストア用のアイコンを docs/store/ に作る。元は正方形で背景が透明なものを置く（PNG は大きめ、1024px 前後）。
// WXT は public/icon/<size>.png を見つけて manifest の icons に入れる。描画は headless Chromium（Playwright）で行う。
// 使い方: pnpm icons:make
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = (p) => access(p).then(() => true, () => false);
const png = path.join(root, 'extension/assets/icon.png');
const source = (await exists(png)) ? png : path.join(root, 'extension/assets/icon.svg');
const mime = source.endsWith('.png') ? 'image/png' : 'image/svg+xml';
const src = `data:${mime};base64,${(await readFile(source)).toString('base64')}`;
console.log(`source: ${path.relative(root, source)}`);
const iconDir = path.join(root, 'extension/public/icon');
const storeDir = path.join(root, 'docs/store');
await mkdir(iconDir, { recursive: true });
await mkdir(storeDir, { recursive: true });

const SIZES = [16, 32, 48, 96, 128];
/** ストアのアイコンは 128×128 のうち中央の 96×96 に絵を置き、周り 16px を透明にする（ストアの画像ガイドライン） */
const STORE = { canvas: 128, art: 96 };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  /** canvas 四方の中央に art の大きさで描き、透明な背景のまま PNG にする */
  const render = async (canvas, art) => {
    await page.setViewportSize({ width: canvas, height: canvas });
    const pad = (canvas - art) / 2;
    await page.setContent(
      // 正方形でない元画像は、つぶさずに art の枠の中央に収める（object-fit: contain）
      `<!doctype html><html><body style="margin:0;background:transparent"><img src="${src}" width="${art}" height="${art}" style="display:block;margin:${pad}px;object-fit:contain"></body></html>`,
    );
    return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: canvas, height: canvas } });
  };
  for (const size of SIZES) {
    const png = await render(size, size);
    await writeFile(path.join(iconDir, `${size}.png`), png);
    console.log(`icon ${size}px: ${png.length} bytes`);
  }
  const store = await render(STORE.canvas, STORE.art);
  await writeFile(path.join(storeDir, 'icon-128.png'), store);
  console.log(`store icon ${STORE.canvas}px (art ${STORE.art}px): ${store.length} bytes`);
} finally {
  await browser.close();
}
