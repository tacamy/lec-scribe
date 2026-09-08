// Loads the built extension into headless Chromium and checks that the
// service worker starts, the popup renders, and the message protocol works.
// tabCapture itself cannot run headless; that is verified manually (docs/CHECKS.md).
// Usage: pnpm --filter @lec-scribe/extension build && node scripts/smoke-extension.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';

const ext = path.resolve('extension/dist/chrome-mv3');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--autoplay-policy=no-user-gesture-required', // AudioContext without a gesture (recording self-test)
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  console.log(`service worker: ${worker.url()}`);

  const popup = await context.newPage();
  const errors = [];
  popup.on('pageerror', (e) => errors.push(String(e)));
  popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForSelector('#startBtn');
  await popup.waitForFunction(() => document.getElementById('stateLabel')?.textContent === 'Ready');
  assert.equal(await popup.getAttribute('#dot', 'data-state'), 'IDLE');

  const state = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }));
  assert.equal(state.ok, true);
  assert.equal(state.state.state, 'IDLE');

  // STOP while idle is a no-op.
  const stopped = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'STOP' }));
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state.state, 'IDLE');

  // START without the extension having been invoked on the tab (no activeTab
  // grant, as here) must fail cleanly: an ERROR state with a coded message and
  // no offscreen document left behind. Real captures are verified manually.
  const rejected = await popup.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return chrome.runtime.sendMessage({ target: 'sw', type: 'START', tabId: tab.id });
  });
  assert.equal(rejected.ok, false);
  assert.ok(['UNSUPPORTED_PAGE', 'CAPTURE_FAILED'].includes(rejected.error.code), rejected.error.code);
  const after = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }));
  assert.equal(after.state.state, 'ERROR');
  assert.equal(after.state.error.code, rejected.error.code);
  const offscreen = await popup.evaluate(() =>
    chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then((c) => c.length),
  );
  assert.equal(offscreen, 0);
  await popup.waitForFunction(() => document.getElementById('dot')?.dataset.state === 'ERROR');
  assert.equal(await popup.isHidden('#message'), false);

  // --- Phase 2: recording pipeline without tabCapture. offscreen.html is
  // loaded as an ordinary tab and fed an oscillator; chunks go through the
  // OPFS writer worker, then the file is read back through the export path.
  const off = await context.newPage();
  off.on('pageerror', (e) => errors.push(String(e)));
  await off.goto(`chrome-extension://${extensionId}/offscreen.html`);
  await off.waitForFunction(() => !!globalThis.__lecscribe);
  const rec = await off.evaluate(async () => {
    const api = globalThis.__lecscribe;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    await ctx.resume();
    const sessionId = `20990101-000000-smok`;
    const config = { audio: { passthrough: false, bitsPerSecond: 32_000, timesliceMs: 400 } };
    const started = await api.startFromStream(dest.stream, config, { sessionId, title: 'smoke', startedAt: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 1800));
    const stats = api.stats();
    const stopped = await api.stop();
    const { files } = await api.export(sessionId);
    const audio = files.find((f) => f.filename.endsWith('audio.webm'));
    const head = Array.from(new Uint8Array(await (await fetch(audio.url)).arrayBuffer()).slice(0, 4));
    api.revoke(files.map((f) => f.url));
    osc.stop();
    await ctx.close();
    return { sessionId, started, stats, stopped, files: files.map((f) => ({ filename: f.filename, bytes: f.bytes })), head };
  });
  await off.close();
  assert.ok(rec.started.recorderStartEpochMs > 0);
  assert.equal(rec.stats.capturing, true);
  assert.ok(rec.stats.audioLevel > 0.01, `audio level ${rec.stats.audioLevel}`);
  assert.equal(rec.stats.silent, false);
  assert.ok(rec.stopped.audioBytes > 1000, `audio bytes ${rec.stopped.audioBytes}`);
  assert.ok(rec.stopped.durationMs >= 1500);
  assert.deepEqual(rec.head, [0x1a, 0x45, 0xdf, 0xa3], 'audio.webm starts with an EBML header');
  assert.deepEqual(
    rec.files.map((f) => f.filename).sort(),
    [`LecScribe/${rec.sessionId}/audio.webm`, `LecScribe/${rec.sessionId}/session.json`, `LecScribe/${rec.sessionId}/status.json`],
  );
  console.log(`recorded ${rec.stopped.audioBytes} bytes in ${rec.stopped.durationMs} ms`);

  // The popup lists the session from OPFS and can export it through the
  // worker + chrome.downloads, then discard it.
  await popup.reload();
  await popup.waitForFunction((id) => [...document.querySelectorAll('#sessionList li')].some((li) => li.title || li.textContent.includes(id)), '2099-01-01 00:00:00');
  const exported = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'EXPORT', sessionId: id }), rec.sessionId);
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(exported.state.exporting.downloadIds.length, 3);
  await popup.waitForFunction(
    async () => !(await chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' })).state.exporting,
    null,
    { timeout: 20_000 },
  );
  // Playwright routes downloads to its own artifacts directory under random
  // names, so match the audio file by size rather than by the requested path.
  const downloads = await popup.evaluate(() => chrome.downloads.search({}));
  const summary = JSON.stringify(downloads.map((d) => [d.filename, d.state, d.fileSize]));
  assert.equal(downloads.length, 3, `downloads: ${summary}`);
  assert.ok(downloads.every((d) => d.state === 'complete'), `downloads: ${summary}`);
  const audioDownload = downloads.find((d) => d.fileSize === rec.stopped.audioBytes);
  assert.ok(audioDownload, `no download of ${rec.stopped.audioBytes} bytes: ${summary}`);
  const afterExport = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }));
  assert.equal(afterExport.state.error, undefined);
  console.log(`exported ${downloads.length} files, audio ${audioDownload.fileSize} bytes`);

  const discarded = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'DISCARD', sessionId: id }), rec.sessionId);
  assert.equal(discarded.ok, true, JSON.stringify(discarded));
  await popup.reload();
  await popup.waitForSelector('#startBtn');
  await popup.waitForTimeout(300);
  const listed = await popup.evaluate(() => [...document.querySelectorAll('#sessionList li')].map((li) => li.textContent));
  assert.ok(!listed.some((t) => t.includes('2099-01-01')), `session still listed: ${listed}`);
  const offscreenLeft = await popup.evaluate(() =>
    chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then((c) => c.length),
  );
  assert.equal(offscreenLeft, 0);

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  console.log('smoke ok');
} finally {
  await context.close();
}
