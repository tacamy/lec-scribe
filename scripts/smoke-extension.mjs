// Loads the built extension into headless Chromium and checks that the
// service worker starts, the side panel renders, and the message protocol works.
// tabCapture itself cannot run headless; that is verified manually (docs/CHECKS.md).
// Usage: pnpm --filter @lec-scribe/extension build && node scripts/smoke-extension.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ext = path.resolve('extension/dist/chrome-mv3');

// Phase 3 以降は fixture ページ（video.js 風 DOM + 合成スライド動画）を使う。
// 動画がなければ短いものを生成し、Range 対応の静的サーバーを立てる。
const FIXTURE_PORT = 8791;
if (!existsSync('fixtures/slides.webm')) {
  console.log('generating fixtures/slides.webm…');
  const made = spawnSync(process.execPath, ['fixtures/make-slides.mjs', '--slides', '3', '--seconds', '2', '--width', '640', '--height', '360'], { stdio: 'inherit' });
  assert.equal(made.status, 0, 'fixture generation failed');
}
const fixtureServer = spawn(process.execPath, ['fixtures/serve.mjs', String(FIXTURE_PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
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
  await popup.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await popup.waitForSelector('#startBtn');
  await popup.waitForFunction(() => document.getElementById('stateLabel')?.textContent === 'Ready');
  assert.equal(await popup.getAttribute('#dot', 'data-state'), 'IDLE');

  const state = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }));
  assert.equal(state.ok, true);
  assert.equal(state.state.state, 'IDLE');

  // 長いタブ名や本文でパネルが横にはみ出さないこと（サイドパネルの最小幅相当で確認）
  await popup.setViewportSize({ width: 320, height: 700 });
  const overflow = await popup.evaluate(() => {
    const long = 'airU 京都芸術大学 - 12章｜グラフィックデザインの歴史と現在 '.repeat(4) + 'https://example.invalid/'.repeat(6);
    document.getElementById('tabValue').textContent = long;
    document.getElementById('videoValue').textContent = long;
    document.getElementById('footer').textContent = long;
    return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth };
  });
  assert.ok(overflow.scroll <= overflow.client, `panel overflows: ${JSON.stringify(overflow)}`);
  await popup.reload();
  await popup.waitForSelector('#startBtn');

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
  // Playwright はダウンロードを横取りして自前の一時ディレクトリにランダム名で
  // 保存する。その過程で chrome.downloads 上の状態が complete → in_progress →
  // complete と揺れることがあるので、全件 complete になるまで待ってから見る。
  // 音声ファイルは要求したパスではなくサイズで突き合わせる。
  await popup.waitForFunction(
    async () => {
      const items = await chrome.downloads.search({});
      return items.length === 3 && items.every((d) => d.state === 'complete');
    },
    null,
    { timeout: 20_000 },
  );
  const downloads = await popup.evaluate(() => chrome.downloads.search({}));
  const stateAfter = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }));
  const summary = `${JSON.stringify(downloads.map((d) => [d.id, d.filename, d.state, d.fileSize]))}\nstate: ${JSON.stringify(stateAfter.state)}`;
  assert.equal(downloads.length, 3, `downloads: ${summary}`);
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

  // --- Phase 3: <video> の probe と検知スクリプト。拡張は 127.0.0.1 への
  // host permission を持つので、activeTab なしでも scripting API が使える。
  const lecture = await context.newPage();
  lecture.on('pageerror', (e) => errors.push(String(e)));
  await lecture.goto(`http://127.0.0.1:${FIXTURE_PORT}/player.html`);
  await lecture.click('#play');
  await lecture.waitForFunction(() => {
    const v = document.querySelector('video');
    return !!v && v.readyState >= 3 && !v.paused;
  });
  const expectedSize = await lecture.evaluate(() => {
    const v = document.querySelector('video');
    return [v.videoWidth, v.videoHeight];
  });
  const lectureTabId = await popup.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0]?.id,
    `http://127.0.0.1:${FIXTURE_PORT}/*`,
  );
  assert.ok(lectureTabId, 'fixture tab id');

  const probed = await popup.evaluate(
    (tabId) => chrome.runtime.sendMessage({ target: 'sw', type: 'PROBE', tabId }),
    lectureTabId,
  );
  assert.equal(probed.ok, true, JSON.stringify(probed));
  const chosen = probed.probe.chosen;
  assert.ok(chosen, `no candidate: ${JSON.stringify(probed.probe)}`);
  assert.equal(chosen.player, 'video.js');
  assert.equal(chosen.selector, '#fixturePlayer_html5_api');
  assert.deepEqual([chosen.videoWidth, chosen.videoHeight], expectedSize);
  assert.equal(chosen.taintFree, true, 'same-origin video must not taint the canvas');
  assert.equal(chosen.drm, false);
  assert.equal(chosen.playing, true);
  assert.equal(chosen.frameId, 0);
  assert.equal(probed.probe.frames, 1);
  assert.deepEqual(probed.probe.crossOriginIframes, []);
  console.log(`probe: ${chosen.player} ${chosen.videoWidth}x${chosen.videoHeight} via ${chosen.selector}`);

  // Phase 4 のフレーム保存には offscreen 側でキャプチャ中のセッションが要る。
  // offscreen.html をタブとして開き、合成ストリームでセッションを始めておく。
  const slideConfig = { imageFormat: 'png', jpegQuality: 0.9, maxSlideWidth: 0 };
  const frameSession = '20990101-000001-smok';
  const off2 = await context.newPage();
  off2.on('pageerror', (e) => errors.push(String(e)));
  await off2.goto(`chrome-extension://${extensionId}/offscreen.html`);
  await off2.waitForFunction(() => !!globalThis.__lecscribe);
  await off2.evaluate(async ({ sessionId, slide }) => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    await ctx.resume();
    globalThis.__smokeAudio = { ctx, osc };
    await globalThis.__lecscribe.startFromStream(
      dest.stream,
      { audio: { passthrough: false, bitsPerSecond: 32_000, timesliceMs: 400 }, slide },
      { sessionId, title: 'smoke frames', startedAt: new Date().toISOString() },
    );
  }, { sessionId: frameSession, slide: slideConfig });

  // 検知スクリプトを注入し、frame 宛のメッセージで直接動かす
  const target = { tabId: lectureTabId, frameId: chosen.frameId, selector: chosen.selector, index: chosen.index };
  const detect = await popup.evaluate(async ({ tabId, frameId, selector, index, sessionId, slide }) => {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['detector.js'] });
    return chrome.tabs.sendMessage(
      tabId,
      { target: 'content', type: 'DETECT_START', sessionId, selector, index, recorderStartEpochMs: Date.now(), slide },
      { frameId },
    );
  }, { ...target, sessionId: frameSession, slide: slideConfig });
  assert.equal(detect.ok, true, JSON.stringify(detect));
  assert.equal(detect.status.playing, true);
  assert.equal(detect.status.visible, true);
  assert.equal(detect.status.playbackRate, 1);
  assert.equal(detect.status.taintFree, true);

  // 最初の 1 枚が自動で保存される
  await off2.waitForFunction(() => globalThis.__lecscribe.stats().slideCount >= 1, null, { timeout: 10_000 });

  await lecture.click('#pause');
  await lecture.waitForTimeout(300);
  // 手動保存（パネルの「スクショを保存」相当）
  const manual = await popup.evaluate(
    ({ tabId, frameId }) => chrome.tabs.sendMessage(tabId, { target: 'content', type: 'CAPTURE_FRAME', reason: 'manual' }, { frameId }),
    target,
  );
  assert.equal(manual.ok, true, JSON.stringify(manual));
  assert.equal(manual.slide.seq, 2);
  assert.equal(manual.slide.filename, 'slide_002.png');
  assert.deepEqual([manual.slide.width, manual.slide.height], expectedSize);
  assert.ok(manual.slide.videoTime > 0, `videoTime ${manual.slide.videoTime}`);
  assert.ok(manual.slide.t >= 0);

  // 二重注入しても壊れないこと: もう一度注入 → DETECT_START → DETECT_STOP
  const again = await popup.evaluate(async ({ tabId, frameId, selector, index, slide }) => {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['detector.js'] });
    const started = await chrome.tabs.sendMessage(
      tabId,
      { target: 'content', type: 'DETECT_START', sessionId: 'smoke2', selector, index, recorderStartEpochMs: Date.now(), slide },
      { frameId },
    );
    const stopped = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'DETECT_STOP' }, { frameId });
    return { started, stopped };
  }, { ...target, slide: slideConfig });
  assert.equal(again.started.ok, true, JSON.stringify(again.started));
  assert.equal(again.started.status.paused, true);
  assert.equal(again.stopped.ok, true);
  console.log(`detector: ${detect.status.player} playing→paused ok`);
  await lecture.close();

  // offscreen 側: 停止 → エクスポート → PNG の中身を確認 → 破棄
  const frames = await off2.evaluate(async (sessionId) => {
    const api = globalThis.__lecscribe;
    const stopped = await api.stop();
    const { files } = await api.export(sessionId);
    const first = files.find((f) => f.filename.endsWith('slides/slide_001.png'));
    const head = first ? Array.from(new Uint8Array(await (await fetch(first.url)).arrayBuffer()).slice(0, 24)) : null;
    const meta = files.find((f) => f.filename.endsWith('slides.json'));
    const slides = meta ? JSON.parse(await (await fetch(meta.url)).text()) : null;
    api.revoke(files.map((f) => f.url));
    await api.discard(sessionId);
    globalThis.__smokeAudio.osc.stop();
    await globalThis.__smokeAudio.ctx.close();
    return { stopped, names: files.map((f) => f.filename), head, slides };
  }, frameSession);
  await off2.close();
  for (const rel of ['slides/slide_001.png', 'slides/slide_002.png', 'slides.json', 'audio.webm']) {
    assert.ok(frames.names.includes(`LecScribe/${frameSession}/${rel}`), `missing ${rel}: ${frames.names}`);
  }
  assert.ok(frames.head, 'slide_001.png readable');
  assert.deepEqual(frames.head.slice(0, 8), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  assert.deepEqual([be32(frames.head, 16), be32(frames.head, 20)], expectedSize, 'PNG IHDR size = video size');
  assert.equal(frames.slides.length, 2);
  assert.deepEqual(frames.slides.map((s) => s.reason), ['initial', 'manual']);
  console.log(`frames: ${frames.slides.length} slides saved, png ${be32(frames.head, 16)}x${be32(frames.head, 20)}`);

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  console.log('smoke ok');
} finally {
  await context.close();
  fixtureServer.kill();
}
