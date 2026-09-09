// Loads the built extension into headless Chromium and checks that the
// service worker starts, the side panel renders, and the message protocol works.
// tabCapture itself cannot run headless; that is verified manually (docs/CHECKS.md).
// Usage: pnpm --filter @lec-scribe/extension build && node scripts/smoke-extension.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const ext = path.resolve('extension/dist/chrome-mv3');

// Phase 3 以降は fixture ページ（video.js 風 DOM + 合成スライド動画）を使う。
// 動画がなければ短いものを生成し、Range 対応の静的サーバーを立てる。
const FIXTURE_PORT = 8791;
const FIXTURE_VERSION = 2; // fixtures/make-slides.mjs の FIXTURE_VERSION と合わせる
const fixtureVersion = existsSync('fixtures/slides.webm.version') ? readFileSync('fixtures/slides.webm.version', 'utf8').trim() : '';
if (!existsSync('fixtures/slides.webm') || fixtureVersion !== String(FIXTURE_VERSION)) {
  console.log('generating fixtures/slides.webm…');
  const made = spawnSync(process.execPath, ['fixtures/make-slides.mjs', '--slides', '3', '--seconds', '2', '--width', '640', '--height', '360'], { stdio: 'inherit' });
  assert.equal(made.status, 0, 'fixture generation failed');
}
const fixtureServer = spawn(process.execPath, ['fixtures/serve.mjs', String(FIXTURE_PORT)], { stdio: 'ignore' });

// Phase 7: ローカルサーバーも起動する。ffmpeg と whisperkit-cli はスタブに差し替え、
// アップロード → finalize → 成果物までを拡張経由で通す。
const SERVER_PORT = 47398;
const SERVER_TOKEN = 'smoke-token-0123456789abcdefghijklmnopqrstuvwxyz';
const serverTmp = mkdtempSync(path.join(os.tmpdir(), 'lec-scribe-smoke-'));
mkdirSync(path.join(serverTmp, 'bin'));
const stub = (name, body) => {
  const file = path.join(serverTmp, 'bin', name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};
const ffmpegStub = stub('ffmpeg', 'out=""; for a in "$@"; do out="$a"; done; in=""; prev=""; for a in "$@"; do if [ "$prev" = "-i" ]; then in="$a"; fi; prev="$a"; done; cp "$in" "$out"');
// slowMarker があるときは 30 秒眠る（処理中の中止を試すため）
const slowMarker = path.join(serverTmp, 'slow');
const whisperkitStub = stub(
  'whisperkit-cli',
  `if [ -f "${slowMarker}" ]; then sleep 30; fi; ` +
    'dir=""; prev=""; for a in "$@"; do if [ "$prev" = "--report-path" ]; then dir="$a"; fi; prev="$a"; done; mkdir -p "$dir"; printf \'%s\' \'{"segments":[{"start":0.5,"end":2.0,"text":"スモークテストの文字起こし"},{"start":2.0,"end":4.0,"text":"二つ目の区間"}]}\' > "$dir/audio.json"',
);
const osascriptStub = stub('osascript', 'echo allowed');
writeFileSync(path.join(serverTmp, 'token'), `${SERVER_TOKEN}\n`);
const serverOut = path.join(serverTmp, 'out');
const localServer = spawn(
  process.execPath,
  ['server/src/index.ts', '--port', String(SERVER_PORT), '--out', serverOut, '--token-file', path.join(serverTmp, 'token'), '--whisperkit', whisperkitStub, '--ffmpeg', ffmpegStub, '--model', 'stub', '--osascript', osascriptStub, '--trusted-file', path.join(serverTmp, 'trusted.json')],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 1200));
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

  // 待機中は Audio / Video / Slides / Tab の行が出ない（hidden 属性が CSS に負けていないこと）
  const idleRows = await popup.evaluate(() =>
    Object.fromEntries(['audioRow', 'meter', 'videoRow', 'slidesRow', 'tabRow', 'serverValue'].map((id) => [id, getComputedStyle(document.getElementById(id)).display])),
  );
  for (const id of ['audioRow', 'meter', 'videoRow', 'slidesRow', 'tabRow']) assert.equal(idleRows[id], 'none', `${id} visible while idle: ${JSON.stringify(idleRows)}`);
  assert.notEqual(idleRows.serverValue, 'none', JSON.stringify(idleRows));
  // サーバー未接続のうちは「このMacと接続」がポップアップに出る
  assert.equal(await popup.evaluate(() => document.getElementById('pairBtn').hidden), false, 'pairBtn hidden while unpaired');

  // 長いタブ名や本文でパネルが横にはみ出さないこと（サイドパネルの最小幅相当で確認）
  await popup.setViewportSize({ width: 320, height: 700 });
  const overflow = await popup.evaluate(() => {
    const long = 'airU 京都芸術大学 - 12章｜グラフィックデザインの歴史と現在 '.repeat(4) + 'https://example.invalid/'.repeat(6);
    // 待機中は隠れている行も、録音中と同じ見た目で測る
    for (const row of document.querySelectorAll('.rows [hidden]')) row.hidden = false;
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

  const stateBeforeDiscard = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
  const discarded = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'DISCARD', sessionId: id }), rec.sessionId);
  assert.equal(discarded.ok, true, `${JSON.stringify(discarded)}\nstate before discard: ${JSON.stringify(stateBeforeDiscard)}`);
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

  // 検知は動画の先頭から見たいので、ページを読み直して再生し直す
  await lecture.reload();
  await lecture.click('#play');
  await lecture.waitForFunction(() => {
    const v = document.querySelector('video');
    return !!v && v.readyState >= 3 && !v.paused && v.currentTime < 1.5;
  });

  // 検知スクリプトを注入し、frame 宛のメッセージで直接動かす
  const detectConfig = {
    sampleIntervalMs: 500,
    detectWidth: 160,
    detectHeight: 90,
    pixelDiffThreshold: 24,
    changeThreshold: 0.02,
    stableThreshold: 0.015,
    stableSamples: 2,
    maxStabilizeMs: 3000,
    dedupeThreshold: 0.015,
    minShotIntervalMs: 1000,
    tickIntervalMs: 1000,
  };
  const target = { tabId: lectureTabId, frameId: chosen.frameId, selector: chosen.selector, index: chosen.index };
  const detect = await popup.evaluate(async ({ tabId, frameId, selector, index, sessionId, slide, detect }) => {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['detector.js'] });
    return chrome.tabs.sendMessage(
      tabId,
      { target: 'content', type: 'DETECT_START', sessionId, selector, index, recorderStartEpochMs: Date.now(), slide, detect },
      { frameId },
    );
  }, { ...target, sessionId: frameSession, slide: slideConfig, detect: detectConfig });
  assert.equal(detect.ok, true, JSON.stringify(detect));
  assert.equal(detect.status.playing, true);
  assert.equal(detect.status.visible, true);
  assert.equal(detect.status.playbackRate, 1);
  assert.equal(detect.status.taintFree, true);

  // 最初の 1 枚が自動で保存され、以降はスライドの切り替わり（2 秒ごと）を検知して保存される。
  // ワイプ（動く円）だけでは保存されないこと = 3 枚ちょうど
  await off2.waitForFunction(() => globalThis.__lecscribe.stats().slideCount >= 1, null, { timeout: 10_000 });
  await lecture.waitForFunction(() => document.querySelector('video').ended, null, { timeout: 30_000 });
  await lecture.waitForTimeout(1000);
  const autoCount = await off2.evaluate(() => globalThis.__lecscribe.stats().slideCount);
  assert.equal(autoCount, 3, `expected initial + 2 slide changes, got ${autoCount}`);

  // 手動保存（パネルの「スクショを保存」相当）。終了後の静止画でも撮れる
  const manual = await popup.evaluate(
    ({ tabId, frameId }) => chrome.tabs.sendMessage(tabId, { target: 'content', type: 'CAPTURE_FRAME', reason: 'manual' }, { frameId }),
    target,
  );
  assert.equal(manual.ok, true, JSON.stringify(manual));
  assert.equal(manual.slide.seq, 4);
  assert.equal(manual.slide.filename, 'slide_004.png');
  assert.deepEqual([manual.slide.width, manual.slide.height], expectedSize);
  assert.ok(manual.slide.videoTime > 0, `videoTime ${manual.slide.videoTime}`);
  assert.ok(manual.slide.t >= 0);

  // 二重注入しても壊れないこと: もう一度注入 → DETECT_START → DETECT_STOP
  const again = await popup.evaluate(async ({ tabId, frameId, selector, index, slide, detect }) => {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['detector.js'] });
    const started = await chrome.tabs.sendMessage(
      tabId,
      { target: 'content', type: 'DETECT_START', sessionId: 'smoke2', selector, index, recorderStartEpochMs: Date.now(), slide, detect },
      { frameId },
    );
    const stopped = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'DETECT_STOP' }, { frameId });
    return { started, stopped };
  }, { ...target, slide: slideConfig, detect: detectConfig });
  assert.equal(again.started.ok, true, JSON.stringify(again.started));
  assert.equal(again.started.status.ended, true);
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
    const tl = files.find((f) => f.filename.endsWith('timeline.json'));
    const timeline = tl ? JSON.parse(await (await fetch(tl.url)).text()) : null;
    api.revoke(files.map((f) => f.url));
    globalThis.__smokeAudio.osc.stop();
    await globalThis.__smokeAudio.ctx.close();
    return { stopped, names: files.map((f) => f.filename), head, slides, timeline };
  }, frameSession);
  await off2.close();
  for (const rel of ['slides/slide_001.png', 'slides/slide_004.png', 'slides.json', 'audio.webm']) {
    assert.ok(frames.names.includes(`LecScribe/${frameSession}/${rel}`), `missing ${rel}: ${frames.names}`);
  }
  assert.ok(frames.head, 'slide_001.png readable');
  assert.deepEqual(frames.head.slice(0, 8), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  assert.deepEqual([be32(frames.head, 16), be32(frames.head, 20)], expectedSize, 'PNG IHDR size = video size');
  assert.equal(frames.slides.length, 4);
  assert.deepEqual(frames.slides.map((s) => s.reason), ['initial', 'change', 'change', 'manual']);
  // 切り替わりの時刻: スライド 2 は 2 秒、3 は 4 秒に出るので、その少し後に保存されている
  assert.ok(frames.slides[1].videoTime > 2 && frames.slides[1].videoTime < 4, `slide 2 at ${frames.slides[1].videoTime}`);
  assert.ok(frames.slides[2].videoTime > 4, `slide 3 at ${frames.slides[2].videoTime}`);

  // Phase 6: タイムライン。start → 再生イベント/tick → ended → stop の順で、
  // 録音時刻 t から動画時刻を復元するとスライドの videoTime と一致する
  assert.ok(Array.isArray(frames.timeline) && frames.timeline.length > 0, 'timeline.json');
  const types = frames.timeline.map((e) => e.type);
  assert.equal(types[0], 'start');
  assert.equal(types[types.length - 1], 'stop');
  assert.ok(types.includes('ended'), `timeline types: ${types}`);
  assert.ok(types.includes('tick'), `timeline types: ${types}`);
  assert.ok(frames.timeline.every((e, i) => i === 0 || e.t >= frames.timeline[i - 1].t), 'timeline is ordered by t');
  const toVideoTime = (events, t) => {
    let base;
    for (const e of events) {
      if (e.t <= t) base = e;
      else break;
    }
    if (!base) return t;
    return base.state === 'playing' ? base.videoTime + (t - base.t) * base.rate : base.videoTime;
  };
  for (const s of frames.slides) {
    const mapped = toVideoTime(frames.timeline, s.t);
    assert.ok(Math.abs(mapped - s.videoTime) < 0.6, `${s.filename}: t=${s.t} → ${mapped.toFixed(2)} vs videoTime ${s.videoTime.toFixed(2)}`);
  }
  console.log(`timeline: ${frames.timeline.length} events (${[...new Set(types)].join(', ')})`);

  // --- Phase 7: サーバーへ送信して文字起こし（スタブ）。設定にトークンを入れ、
  // パネルの「送信」相当の UPLOAD を service worker に投げて完了を待つ。
  await popup.evaluate(
    ({ port, token }) => chrome.storage.local.set({ config: { server: { port, token } } }),
    { port: SERVER_PORT, token: SERVER_TOKEN },
  );
  const uploadReply = await popup.evaluate(
    (id) => chrome.runtime.sendMessage({ target: 'sw', type: 'UPLOAD', sessionId: id }),
    frameSession,
  );
  assert.equal(uploadReply.ok, true, JSON.stringify(uploadReply));
  assert.ok(['UPLOADING', 'PROCESSING'].includes(uploadReply.state.state), uploadReply.state.state);
  // 状態遷移を記録しながら完了を待つ（失敗時の診断用）
  const transitions = [];
  let afterUpload;
  for (let i = 0; i < 200; i++) {
    const s = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
    const key = `${s.state}/${s.processing?.stage ?? '-'}${s.processing?.percent !== undefined ? ` ${s.processing.percent}%` : ''}`;
    if (transitions[transitions.length - 1] !== key) transitions.push(key);
    if (!s.processing && (s.state === 'COMPLETED' || s.state === 'IDLE' || s.state === 'ERROR')) {
      afterUpload = s;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  // 遅れて届く進捗で状態が戻らないことも確認する
  await popup.waitForTimeout(2500);
  const settled = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
  const trace = `transitions: ${transitions.join(' → ')}\nfinal: ${JSON.stringify(settled)}`;
  assert.ok(afterUpload, `upload never settled\n${trace}`);
  assert.equal(afterUpload.error, undefined, `upload error: ${JSON.stringify(afterUpload.error)}\n${trace}`);
  assert.equal(afterUpload.state, 'COMPLETED', trace);
  assert.equal(settled.state, 'COMPLETED', trace);
  assert.equal(settled.processing, undefined, trace);
  const outDirs = readdirSync(serverOut);
  const outDir = outDirs.find((d) => d.startsWith(frameSession));
  assert.ok(outDir, `server output for ${frameSession}: ${outDirs}`);
  // ユーザー向けは notes.md と slides/ だけ。作業ファイルは .lecscribe/ に入る
  assert.deepEqual(readdirSync(path.join(serverOut, outDir)).sort(), ['.lecscribe', 'notes.md', 'slides']);
  const produced = readdirSync(path.join(serverOut, outDir), { recursive: true }).map(String).sort();
  for (const f of ['audio.webm', 'slides.json', 'timeline.json', 'capture-status.json', 'transcript.json', 'transcript.srt', 'transcript.vtt', 'transcript.txt', 'lecture.md', 'pipeline.json']) {
    assert.ok(produced.includes(`.lecscribe/${f}`), `missing .lecscribe/${f} in ${produced}`);
  }
  assert.ok(produced.some((f) => f.endsWith('slide_001.png')), `slides uploaded: ${produced}`);
  const work = path.join(serverOut, outDir, '.lecscribe');
  const srt = readFileSync(path.join(work, 'transcript.srt'), 'utf8');
  assert.ok(srt.includes('スモークテストの文字起こし'), srt);
  const pipelineStatus = JSON.parse(readFileSync(path.join(work, 'pipeline.json'), 'utf8'));
  assert.equal(pipelineStatus.stage, 'done');
  assert.equal(pipelineStatus.result.hasTimeline, true);
  assert.equal(pipelineStatus.result.slides, 4);
  const lectureMd = readFileSync(path.join(work, 'lecture.md'), 'utf8');
  assert.ok(lectureMd.includes('# smoke frames') && lectureMd.includes('![slide_001](../slides/slide_001.png)'), lectureMd.slice(0, 300));
  // LLM なしなので notes.md は文字起こしそのまま（画像は slides/ を相対参照）
  const notesMd = readFileSync(path.join(serverOut, outDir, 'notes.md'), 'utf8');
  assert.ok(notesMd.includes('# smoke frames') && notesMd.includes('![slide_001](slides/slide_001.png)'), notesMd.slice(0, 300));
  // 拡張側の status.json も done になり、一覧に「フォルダを開く」と「やり直す」が出る
  await popup.reload();
  await popup.waitForFunction(
    (id) =>
      [...document.querySelectorAll('#sessionList li')].some(
        (li) => li.textContent.includes(id) && li.textContent.includes('フォルダを開く') && li.textContent.includes('やり直す'),
      ),
    '2099-01-01 00:00:01',
    { timeout: 10_000 },
  );
  const beforeDiscard = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
  const discardedFrames = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'DISCARD', sessionId: id }), frameSession);
  assert.equal(discardedFrames.ok, true, `${JSON.stringify(discardedFrames)}\nstate before discard: ${JSON.stringify(beforeDiscard)}`);
  console.log(`server: transcribed via ${outDir} (${produced.length} files)`);
  console.log(`frames: ${frames.slides.length} slides saved, png ${be32(frames.head, 16)}x${be32(frames.head, 20)}`);

  // 接続承認: 拡張ページから POST /pair →（osascript スタブが「許可」）→ 以後はトークンなしで通る
  const paired = await popup.evaluate(async (port) => {
    const reply = await chrome.runtime.sendMessage({ target: 'sw', type: 'PAIR' });
    const { config } = await chrome.storage.local.get('config');
    // 承認時に発行されたトークンで /health を呼ぶと authorized / paired になる（Origin は GET に付かない）
    const health = await (await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${config.server.token}` } })).json();
    return { reply, server: config.server, health };
  }, SERVER_PORT);
  assert.equal(paired.reply.ok, true, JSON.stringify(paired));
  assert.equal(paired.server.paired, true, JSON.stringify(paired.server));
  assert.notEqual(paired.server.token, SERVER_TOKEN, 'issued token replaces the shared one');
  assert.equal(paired.health.authorized, true, JSON.stringify(paired.health));
  assert.equal(paired.health.paired, true, JSON.stringify(paired.health));
  await popup.reload();
  await popup.waitForSelector('#startBtn');
  assert.equal(await popup.evaluate(() => document.getElementById('pairBtn').hidden), true, 'pairBtn still visible after pairing');
  console.log('pairing: approved via dialog stub through the service worker, issued token authorizes /health');

  // 処理中の破棄: whisperkit を遅くしてもう 1 本送り、transcribing の途中で DISCARD する。
  // サーバー側の処理が止まってフォルダが消え、拡張内のセッションも消えること。
  writeFileSync(slowMarker, '');
  const off3 = await context.newPage();
  off3.on('pageerror', (e) => errors.push(String(e)));
  await off3.goto(`chrome-extension://${extensionId}/offscreen.html`);
  await off3.waitForFunction(() => !!globalThis.__lecscribe);
  const cancelSession = '20990101-000002-smok';
  const queuedSession = '20990101-000003-smok';
  for (const sessionId of [cancelSession, queuedSession]) {
    await off3.evaluate(async (sessionId) => {
      const api = globalThis.__lecscribe;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      await ctx.resume();
      const config = { audio: { passthrough: false, bitsPerSecond: 32_000, timesliceMs: 400 } };
      await api.startFromStream(dest.stream, config, { sessionId, title: 'smoke cancel', startedAt: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 900));
      await api.stop();
      osc.stop();
      await ctx.close();
    }, sessionId);
  }
  await off3.close();
  const cancelUpload = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'UPLOAD', sessionId: id }), cancelSession);
  assert.equal(cancelUpload.ok, true, JSON.stringify(cancelUpload));
  const cancelTrace = [];
  let reachedTranscribing = false;
  for (let i = 0; i < 100; i++) {
    const s = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
    const key = `${s.state}/${s.processing?.stage ?? '-'}`;
    if (cancelTrace[cancelTrace.length - 1] !== key) cancelTrace.push(key);
    if (s.processing?.stage === 'transcribing') {
      reachedTranscribing = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(reachedTranscribing, `never reached transcribing: ${cancelTrace.join(' → ')}`);
  // 処理中にもう 1 本「文字起こしする」→ 送信待ちに並ぶ（処理中の分は変わらない）
  const queuedReply = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'UPLOAD', sessionId: id }), queuedSession);
  assert.equal(queuedReply.ok, true, JSON.stringify(queuedReply));
  assert.deepEqual(queuedReply.state.pendingUploads, [queuedSession], JSON.stringify(queuedReply.state));
  assert.equal(queuedReply.state.processing?.sessionId, cancelSession, JSON.stringify(queuedReply.state));
  const cancelStarted = Date.now();
  const cancelled = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'DISCARD', sessionId: id }), cancelSession);
  const cancelMs = Date.now() - cancelStarted;
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.ok(cancelMs < 5000, `discard during processing took ${cancelMs} ms (whisperkit stub sleeps 30 s)`);
  assert.ok(!readdirSync(serverOut).some((d) => d.startsWith(cancelSession)), `server dir still exists: ${readdirSync(serverOut)}`);
  // 中止で空いたので、送信待ちだった 2 本目が始まる
  assert.equal(cancelled.state.processing?.sessionId, queuedSession, JSON.stringify(cancelled.state));
  assert.equal(cancelled.state.pendingUploads, undefined, JSON.stringify(cancelled.state));
  let queuedTranscribing = false;
  for (let i = 0; i < 100; i++) {
    const s = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
    if (s.processing?.sessionId === queuedSession && s.processing.stage === 'transcribing') {
      queuedTranscribing = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(queuedTranscribing, 'queued session never reached transcribing');
  const cancelled2 = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'DISCARD', sessionId: id }), queuedSession);
  assert.equal(cancelled2.ok, true, JSON.stringify(cancelled2));
  assert.equal(cancelled2.state.processing, undefined, JSON.stringify(cancelled2.state));
  assert.notEqual(cancelled2.state.state, 'PROCESSING', JSON.stringify(cancelled2.state));
  assert.ok(!readdirSync(serverOut).some((d) => d.startsWith(queuedSession)), `server dir still exists: ${readdirSync(serverOut)}`);
  // 遅れて届く polling 結果で処理中に戻らないこと
  await popup.waitForTimeout(2500);
  const afterCancel = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
  assert.equal(afterCancel.processing, undefined, JSON.stringify(afterCancel));
  assert.equal(afterCancel.pendingUploads, undefined, JSON.stringify(afterCancel));
  await popup.reload();
  await popup.waitForSelector('#startBtn');
  await popup.waitForTimeout(300);
  const listedAfterCancel = await popup.evaluate(() => [...document.querySelectorAll('#sessionList li')].map((li) => li.textContent));
  assert.ok(!listedAfterCancel.some((t) => t.includes('2099-01-01 00:00:02') || t.includes('2099-01-01 00:00:03')), `cancelled session still listed: ${listedAfterCancel}`);
  rmSync(slowMarker, { force: true });
  console.log(`cancel: discarded while transcribing in ${cancelMs} ms, queued session started and was discarded too (${cancelTrace.join(' → ')})`);

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  console.log('smoke ok');
} finally {
  await context.close();
  fixtureServer.kill();
  localServer.kill();
}
