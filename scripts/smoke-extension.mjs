// Loads the built extension into headless Chromium and checks that the
// service worker starts, the side panel renders, and the message protocol works.
// tabCapture itself cannot run headless; that is verified manually (docs/CHECKS.md).
// Usage: pnpm --filter @lec-scribe/extension build && node scripts/smoke-extension.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const ext = path.resolve('extension/dist/chrome-mv3');

// Phase 3 以降は fixture ページ（video.js 風 DOM + 合成スライド動画）を使う。
// 動画がなければ短いものを生成し、Range 対応の静的サーバーを立てる。
const FIXTURE_PORT = 8791;
const FIXTURE_VERSION = 3; // fixtures/make-slides.mjs の FIXTURE_VERSION と合わせる
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
// 出力先が "-"（標準出力）なら標準出力へ。そうしないとカレントディレクトリに "-" という名前のファイルができる
const ffmpegStub = stub(
  'ffmpeg',
  'out=""; for a in "$@"; do out="$a"; done; in=""; prev=""; for a in "$@"; do if [ "$prev" = "-i" ]; then in="$a"; fi; prev="$a"; done; if [ "$out" = "-" ]; then cat "$in"; else cp "$in" "$out"; fi',
);
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
const localServerArgs = ['server/src/index.ts', '--port', String(SERVER_PORT), '--out', serverOut, '--token-file', path.join(serverTmp, 'token'), '--whisperkit', whisperkitStub, '--ffmpeg', ffmpegStub, '--model', 'stub', '--osascript', osascriptStub, '--trusted-file', path.join(serverTmp, 'trusted.json'), '--auto-update', 'off'];
let localServer = spawn(process.execPath, localServerArgs, { stdio: 'ignore' });
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

  // 未接続画面は既定ポート（47321）にサーバーがいるか見に行く。CI には何もいないので接続拒否が
  // コンソールエラーとして残り、最後の「ページエラーなし」で落ちる。先に smoke 用のポートを設定しておく
  // service worker を見つけた直後は chrome API がまだ生えていないことがある（まれに落ちていた）
  for (let i = 0; ; i++) {
    try {
      await worker.evaluate((port) => chrome.storage.local.set({ config: { server: { port } } }), SERVER_PORT);
      break;
    } catch (e) {
      if (i >= 50) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const popup = await context.newPage();
  const errors = [];
  popup.on('pageerror', (e) => errors.push(String(e)));
  popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await popup.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await popup.waitForSelector('#startBtn', { state: 'attached' });
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
  assert.equal(await popup.evaluate(() => document.getElementById('setup').hidden), false, 'setup view hidden while unpaired');
  // 使い始める前の画面に、位置づけの 1 行が出ている（SPEC §3.0）
  assert.equal(await popup.evaluate(() => document.getElementById('termsNote')?.textContent), '個人の学習用です。利用するサイトの規約に従ってください。');
  // hidden 属性が CSS の display 指定に負けていないこと（計算後のスタイルで見る）
  const setupDisplay = await popup.evaluate(() =>
    Object.fromEntries(['status', 'rows', 'actions', 'footer', 'setup'].map((id) => [id, getComputedStyle(document.getElementById(id)).display])),
  );
  for (const id of ['status', 'rows', 'actions', 'footer']) assert.equal(setupDisplay[id], 'none', `${id} visible while unpaired: ${JSON.stringify(setupDisplay)}`);
  assert.notEqual(setupDisplay.setup, 'none', JSON.stringify(setupDisplay));

  // 長いタブ名や本文でパネルが横にはみ出さないこと（サイドパネルの最小幅相当で確認）
  await popup.setViewportSize({ width: 320, height: 700 });
  const overflow = await popup.evaluate(() => {
    const long = 'サンプル講座 - 12章｜グラフィックデザインの歴史と現在 '.repeat(4) + 'https://example.invalid/'.repeat(6);
    // 待機中は隠れている行も、録音中と同じ見た目で測る
    for (const row of document.querySelectorAll('.rows [hidden]')) row.hidden = false;
    document.getElementById('tabValue').textContent = long;
    document.getElementById('videoValue').textContent = long;
    document.getElementById('footer').textContent = long;
    return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth };
  });
  assert.ok(overflow.scroll <= overflow.client, `panel overflows: ${JSON.stringify(overflow)}`);
  await popup.reload();
  await popup.waitForSelector('#startBtn', { state: 'attached' });

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

  // The popup lists the session from OPFS; discard it.
  // （Downloads への書き出しは UI から外したので smoke でも通さない。chrome.downloads 絡みの揺れで不安定だった）
  await popup.reload();
  await popup.waitForFunction((id) => [...document.querySelectorAll('#sessionList li')].some((li) => li.title || li.textContent.includes(id)), '2099-01-01 00:00:00');

  const stateBeforeDiscard = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
  const discarded = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'DISCARD', sessionId: id }), rec.sessionId);
  assert.equal(discarded.ok, true, `${JSON.stringify(discarded)}\nstate before discard: ${JSON.stringify(stateBeforeDiscard)}`);
  await popup.reload();
  await popup.waitForSelector('#startBtn', { state: 'attached' });
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

  // ポップアップ（?mode=popup）は Start 前に前面のタブの動画を調べて Video 行に出す。
  // 設定や状態が変わって render() が走っても、その表示が消えないこと（前の講義を文字起こししている間に
  // 次の講義のポップアップを開くと、処理の段階が進むたびに render() が走る）。
  // showProbe は「いま前面のタブ」を調べるので、講義のタブを前面にしてからポップアップを読み込む（navigate はタブを前面にしない）
  const popup2 = await context.newPage();
  popup2.on('pageerror', (e) => errors.push(String(e)));
  await lecture.bringToFront();
  await popup2.goto(`chrome-extension://${extensionId}/sidepanel.html?mode=popup`);
  await popup2.waitForFunction(() => /再生中|一時停止|待機中/.test(document.getElementById('videoValue')?.textContent ?? ''), null, { timeout: 10_000 });
  const probeText = await popup2.evaluate(() => document.getElementById('videoValue').textContent);
  // 設定に印を付けて外す（値が変わらないと onChanged は来ない）。どちらも render() を通る
  await popup2.evaluate(async () => {
    const { config } = await chrome.storage.local.get('config');
    await chrome.storage.local.set({ config: { ...config, smokeTouch: Date.now() } });
    await new Promise((r) => setTimeout(r, 300));
    await chrome.storage.local.set({ config });
    await new Promise((r) => setTimeout(r, 300));
  });
  const afterRender = await popup2.evaluate(() => ({
    text: document.getElementById('videoValue').textContent,
    hidden: document.getElementById('videoRow').hidden,
  }));
  assert.equal(afterRender.text, probeText, `popup probe was wiped by a re-render: ${JSON.stringify(afterRender)}`);
  assert.equal(afterRender.hidden, false, 'Video row hidden after re-render');
  console.log(`popup: probe survives re-render (${probeText})`);
  await popup2.close();

  // Phase 4 のフレーム保存には offscreen 側でキャプチャ中のセッションが要る。
  // offscreen.html をタブとして開き、合成ストリームでセッションを始めておく。
  // 既定値のまま通す（動き続ける領域を除いて比べるので、ワイプが動いても 0.4% には届かない）
  const slideConfig = { imageFormat: 'png', jpegQuality: 0.9, maxSlideWidth: 0, finalState: true, updateThreshold: 0.004 };
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
    changeThreshold: 0.025,
    stableThreshold: 0.015,
    stableSamples: 2,
    maxStabilizeMs: 3000,
    dedupeThreshold: 0.015,
    minShotIntervalMs: 1000,
    tickIntervalMs: 1000,
    cutThreshold: 0.3,
    sameSceneColor: 0.65,
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
  if (autoCount !== 3) {
    // CI（Linux の headless）で再現する失敗の診断用: 動画の長さと保存したスライド、タイムラインを出す
    const videoInfo = await lecture.evaluate(() => {
      const v = document.querySelector('video');
      return { duration: v.duration, currentTime: v.currentTime, ended: v.ended, readyState: v.readyState, size: [v.videoWidth, v.videoHeight] };
    });
    const saved = await off2.evaluate(async (sessionId) => {
      await globalThis.__lecscribe.stop(); // キャプチャ中は export できないので止めてから読む（この後 fail する）
      const { files } = await globalThis.__lecscribe.export(sessionId);
      const read = async (suffix) => {
        const f = files.find((x) => x.filename.endsWith(suffix));
        return f ? JSON.parse(await (await fetch(f.url)).text()) : null;
      };
      const out = { slides: await read('slides.json'), timeline: await read('timeline.json') };
      globalThis.__lecscribe.revoke(files.map((f) => f.url));
      return out;
    }, frameSession);
    const stopReply = await popup.evaluate(
      ({ tabId, frameId }) => chrome.tabs.sendMessage(tabId, { target: 'content', type: 'DETECT_STOP' }, { frameId }),
      target,
    );
    assert.fail(
      `expected initial + 2 slide changes, got ${autoCount}\nvideo: ${JSON.stringify(videoInfo)}\nslides: ${JSON.stringify(saved.slides)}\ntimeline: ${JSON.stringify(saved.timeline)}\nverdicts: ${JSON.stringify(stopReply?.verdicts ?? stopReply)}`,
    );
  }

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

  // 最初の検知を明示的に止め、判定履歴（診断用）を受け取る
  const firstStop = await popup.evaluate(
    ({ tabId, frameId }) => chrome.tabs.sendMessage(tabId, { target: 'content', type: 'DETECT_STOP' }, { frameId }),
    target,
  );
  assert.equal(firstStop.ok, true, JSON.stringify(firstStop));

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
  // スライド 2 は表示から 1.8 秒後に 1 行増える → 切り替わる直前の状態で画像が上書きされている
  assert.equal(frames.slides[1].updated, true, `slide 2 was not updated with its final state: ${JSON.stringify(frames.slides[1])}\nverdicts: ${JSON.stringify(firstStop.verdicts)}`);
  assert.ok(frames.slides[1].finalVideoTime > frames.slides[1].videoTime, JSON.stringify(frames.slides[1]));
  assert.notEqual(frames.slides[0].updated, true, `slide 1 should not be updated: ${JSON.stringify(frames.slides[0])}`);
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
  const outDir = outDirs.find((d) => d === frameSession || d.endsWith(`_${frameSession}`));
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
  // 押し直し: 拡張は今のトークンを添えるので、サーバーはダイアログを出さず同じトークンを返す（作り直さない。処理中の監視が切れないように）
  const repaired = await popup.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ target: 'sw', type: 'PAIR' });
    const { config } = await chrome.storage.local.get('config');
    return { reply, token: config.server.token };
  });
  assert.equal(repaired.reply.ok, true, JSON.stringify(repaired));
  assert.equal(repaired.token, paired.server.token, 'pressing pair again replaced the token');
  await popup.reload();
  await popup.waitForSelector('#startBtn', { state: 'attached' });
  assert.equal(await popup.evaluate(() => document.getElementById('setup').hidden), true, 'setup view still visible after pairing');
  assert.equal(await popup.evaluate(() => document.getElementById('actions').hidden), false, 'Start hidden after pairing');
  console.log('pairing: approved via dialog stub through the service worker, issued token authorizes /health, pressing again keeps it');

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
  assert.ok(!readdirSync(serverOut).some((d) => d === cancelSession || d.endsWith(`_${cancelSession}`)), `server dir still exists: ${readdirSync(serverOut)}`);
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
  assert.ok(!readdirSync(serverOut).some((d) => d === queuedSession || d.endsWith(`_${queuedSession}`)), `server dir still exists: ${readdirSync(serverOut)}`);
  // 遅れて届く polling 結果で処理中に戻らないこと
  await popup.waitForTimeout(2500);
  const afterCancel = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
  assert.equal(afterCancel.processing, undefined, JSON.stringify(afterCancel));
  assert.equal(afterCancel.pendingUploads, undefined, JSON.stringify(afterCancel));
  await popup.reload();
  await popup.waitForSelector('#startBtn', { state: 'attached' });
  await popup.waitForTimeout(300);
  const listedAfterCancel = await popup.evaluate(() => [...document.querySelectorAll('#sessionList li')].map((li) => li.textContent));
  assert.ok(!listedAfterCancel.some((t) => t.includes('2099-01-01 00:00:02') || t.includes('2099-01-01 00:00:03')), `cancelled session still listed: ${listedAfterCancel}`);
  rmSync(slowMarker, { force: true });
  console.log(`cancel: discarded while transcribing in ${cancelMs} ms, queued session started and was discarded too (${cancelTrace.join(' → ')})`);

  // #7: サーバーの api が、この拡張の必要とする版を満たしていること。
  // 片方だけ上げ忘れると（新しい項目を送るのに API_VERSION を上げなかった等）ここで落ちる
  const requiredApi = Number(/REQUIRED_SERVER_API\s*=\s*(\d+)/.exec(readFileSync('extension/src/health.ts', 'utf8'))?.[1]);
  assert.ok(Number.isInteger(requiredApi), 'could not read REQUIRED_SERVER_API from extension/src/health.ts');
  const smokeHealth = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)).json();
  const serverApi = smokeHealth.api;
  assert.equal(typeof serverApi, 'number', `server did not report an api version: ${serverApi}`);
  assert.ok(serverApi >= requiredApi, `server api ${serverApi} < the extension's REQUIRED_SERVER_API ${requiredApi}`);
  console.log(`version: server api ${serverApi} satisfies the extension's ${requiredApi}`);
  // api 2 の約束（#17）: vision は ready / building / idle / failed か null。抜けていたら約束違反。
  // 版の確認を先にしておく（古いサーバーでは vision が無いのが正しく、そのときは版の不一致の方を知らせる）
  const VISION_STATES = ['ready', 'building', 'idle', 'failed'];
  assert.ok(smokeHealth.vision === null || VISION_STATES.includes(smokeHealth.vision), `health.vision is ${JSON.stringify(smokeHealth.vision)}`);

  // #17: 設定画面の「接続テスト」に、/health の vision に対応する行が出る。
  // 設定画面は module の先頭で設定を await してから listener を付けるので、接続の状態が出るのを待ってから押す。
  // この smoke サーバーは launchd 管理でないので起動時にビルドせず、状態は idle か ready で安定している（CI は null）
  const optionsPage = await context.newPage();
  optionsPage.on('pageerror', (e) => errors.push(String(e)));
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
  await optionsPage.waitForFunction(() => !!document.getElementById('pairStatus')?.textContent, null, { timeout: 5_000 });
  await optionsPage.click('#test');
  const visionLine = await (
    await optionsPage.waitForFunction(
      () => (document.getElementById('result')?.textContent ?? '').split('\n').find((l) => l.startsWith('見た目の判定（Vision）: ')) ?? null,
      null,
      { timeout: 10_000 },
    )
  ).jsonValue();
  const expectedVision = { ready: 'あり', building: '準備中', idle: 'まだ作っていません', failed: '作れませんでした' }[smokeHealth.vision] ?? '使わない';
  assert.ok(String(visionLine).startsWith(`見た目の判定（Vision）: ${expectedVision}`), `options page said ${JSON.stringify(visionLine)} for health.vision=${JSON.stringify(smokeHealth.vision)}`);
  console.log(`options: ${visionLine}`);
  await optionsPage.close();
  // #8: サーバーに繋がらない送信失敗で、送信待ちの行列を捨てないこと。
  // サーバーを止めて 2 本送ると、どちらも失敗して行列に残る。起動し直して手で送ると順に処理される
  localServer.kill();
  await new Promise((r) => setTimeout(r, 500));
  const off4 = await context.newPage();
  off4.on('pageerror', (e) => errors.push(String(e)));
  await off4.goto(`chrome-extension://${extensionId}/offscreen.html`);
  await off4.waitForFunction(() => !!globalThis.__lecscribe);
  const retryA = '20990101-000004-smok';
  const retryB = '20990101-000005-smok';
  for (const sessionId of [retryA, retryB]) {
    await off4.evaluate(async (sessionId) => {
      const api = globalThis.__lecscribe;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      await ctx.resume();
      const config = { audio: { passthrough: false, bitsPerSecond: 32_000, timesliceMs: 400 } };
      await api.startFromStream(dest.stream, config, { sessionId, title: 'smoke retry', startedAt: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 900));
      await api.stop();
      osc.stop();
      await ctx.close();
    }, sessionId);
  }
  await off4.close();
  const failedA = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'UPLOAD', sessionId: id }), retryA);
  assert.equal(failedA.ok, false, JSON.stringify(failedA));
  assert.equal(failedA.error.code, 'SERVER_UNREACHABLE', JSON.stringify(failedA.error));
  assert.equal(failedA.error.retryable, true, JSON.stringify(failedA.error));
  const failedB = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'UPLOAD', sessionId: id }), retryB);
  assert.equal(failedB.ok, false, JSON.stringify(failedB));
  const kept = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
  // 失敗したものは最後尾に回る（1 本の失敗で後ろが待たされないように）。A → B の順で失敗したので [A, B]
  assert.deepEqual(kept.pendingUploads, [retryA, retryB], `queue was dropped: ${JSON.stringify(kept)}`);
  assert.ok(kept.warnings.includes('SERVER_UNREACHABLE'), JSON.stringify(kept.warnings));
  // サーバーを起動し直し、手で 1 本送ると、残りも順に送られる
  localServer = spawn(process.execPath, localServerArgs, { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`).then((r) => r.ok, () => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  // 恒久的な失敗（存在しないセッション）では、その 1 本だけ落ちて他は行列に残る
  const gone = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'UPLOAD', sessionId: '20990101-000009-smok' }));
  assert.equal(gone.ok, false, JSON.stringify(gone));
  const afterPermanent = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
  assert.deepEqual(afterPermanent.pendingUploads, [retryA, retryB], `permanent failure evicted the queue: ${JSON.stringify(afterPermanent)}`);
  const resent = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'UPLOAD', sessionId: id }), retryB);
  assert.equal(resent.ok, true, JSON.stringify(resent));
  assert.deepEqual(resent.state.pendingUploads, [retryA], JSON.stringify(resent.state));
  let drained = null;
  for (let i = 0; i < 100; i++) {
    drained = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
    if (!drained.processing && !drained.pendingUploads) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(drained.pendingUploads, undefined, `queue did not drain: ${JSON.stringify(drained)}`);
  assert.ok(!drained.warnings.includes('SERVER_UNREACHABLE'), JSON.stringify(drained.warnings));
  for (const id of [retryA, retryB]) {
    assert.ok(readdirSync(serverOut).some((d) => d === id || d.endsWith(`_${id}`)), `no server output for ${id}: ${readdirSync(serverOut)}`);
  }
  console.log('retry: uploads failed against a stopped server, the queue survived and drained after a manual resend');

  // §13.5: ノートを整えられなかったとき（Codex の利用上限など）。サーバーの段階は done のままなので、一覧の行に注意書きを出す。
  // codex が必ず失敗するサーバーに替えて 1 本やり直し、注意書きが出ること、整えられる（ここではノート作成なし）サーバーでやり直すと消えることを見る
  const restartServer = async (extraArgs) => {
    // パネルは一覧を描き直すたびにサーバーへ問い合わせる（フォルダの有無、版）。その最中にサーバーを止めると
    // 接続拒否がコンソールのエラーになり、最後の「ページのエラーなし」に引っかかる。問い合わせが終わるのを待ってから止める
    await popup.waitForLoadState('networkidle');
    localServer.kill();
    await new Promise((r) => setTimeout(r, 500));
    localServer = spawn(process.execPath, [...localServerArgs, ...extraArgs], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://127.0.0.1:${SERVER_PORT}/health`).then((r) => r.ok, () => false)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail('local server did not come back');
  };
  const redo = async (sessionId) => {
    const sent = await popup.evaluate((id) => chrome.runtime.sendMessage({ target: 'sw', type: 'UPLOAD', sessionId: id }), sessionId);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    for (let i = 0; i < 100; i++) {
      const s = (await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'sw', type: 'GET_STATE' }))).state;
      if (!s.processing && !s.pendingUploads) return s;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail(`redo of ${sessionId} did not finish`);
  };
  const noteOf = async (sessionId) => {
    await popup.reload();
    await popup.waitForSelector('#sessionList li', { state: 'attached', timeout: 5_000 });
    return popup.evaluate(
      (id) => ({ id, notes: [...document.querySelectorAll('#sessionList li .sessionNote')].map((n) => ({ text: n.textContent, title: n.title })) }),
      sessionId,
    );
  };
  const codexLimitStub = stub('codex-limit', 'echo "You have hit your usage limit. Try again later." >&2; exit 1');
  await restartServer(['--llm', 'codex', '--codex', codexLimitStub]);
  const afterLimit = await redo(retryA);
  assert.equal(afterLimit.error, undefined, `a notes failure must not be a processing error: ${JSON.stringify(afterLimit.error)}`);
  const limited = await noteOf(retryA);
  assert.equal(limited.notes.length, 1, `expected one notes warning in the list: ${JSON.stringify(limited)}`);
  assert.equal(limited.notes[0].text, 'ノートを整えられませんでした。時間をおいて「やり直す」を押してください');
  assert.ok(limited.notes[0].title.includes('usage limit'), `tooltip should carry the server's reason: ${JSON.stringify(limited.notes[0])}`);
  await restartServer([]);
  await redo(retryA);
  const cleared = await noteOf(retryA);
  assert.equal(cleared.notes.length, 0, `the warning should clear after a successful redo: ${JSON.stringify(cleared)}`);
  console.log('notes: a failed polish keeps the session done, warns on its row with the reason, and clears after a good redo');

  // 接続を解除（設定画面）: 確認ダイアログで OK → サーバーはこの拡張の承認を取り消し、拡張はトークンを消す。
  // サーバーは上で起動し直しているので、承認済みのトークンが trusted.json から読み直されて通っていたことも、ここまでで分かる
  const unpairPage = await context.newPage();
  unpairPage.on('pageerror', (e) => errors.push(String(e)));
  unpairPage.on('dialog', (dialog) => void dialog.accept());
  await unpairPage.goto(`chrome-extension://${extensionId}/options.html`);
  await unpairPage.waitForSelector('#unpair:not([hidden])', { timeout: 5_000 });
  const heldToken = await unpairPage.evaluate(async () => (await chrome.storage.local.get('config')).config.server.token);
  await unpairPage.click('#unpair');
  await unpairPage.waitForFunction(() => document.getElementById('result')?.textContent === '接続を解除しました。', null, { timeout: 5_000 });
  const afterUnpair = await unpairPage.evaluate(async () => (await chrome.storage.local.get('config')).config.server);
  assert.equal(afterUnpair.token, '', JSON.stringify(afterUnpair));
  assert.equal(afterUnpair.paired, false, JSON.stringify(afterUnpair));
  assert.equal(await unpairPage.evaluate(() => document.getElementById('unpair').hidden), true, 'unpair button still shown');
  const revoked = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/health`, { headers: { authorization: `Bearer ${heldToken}` } })).json();
  assert.equal(revoked.authorized, false, `unpaired token still accepted: ${JSON.stringify(revoked)}`);
  await unpairPage.close();
  console.log('unpair: the options page revoked this extension on the server and cleared its token');

  // §12.1d: ポートをほかのアプリが使っているとき。設定画面の「接続テスト」はそのアプリを止めるよう案内し、
  // サーバーは相手の名前をログに書いて試し直し、相手が終われば何もしなくても待ち受けを始める
  localServer.kill();
  await new Promise((r) => setTimeout(r, 500));
  const foreign = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>another dev server</title>');
  });
  await new Promise((resolve) => foreign.listen(SERVER_PORT, '127.0.0.1', resolve));
  const portPage = await context.newPage();
  portPage.on('pageerror', (e) => errors.push(String(e)));
  await portPage.goto(`chrome-extension://${extensionId}/options.html`);
  await portPage.waitForFunction(() => !!document.getElementById('pairStatus')?.textContent, null, { timeout: 5_000 });
  await portPage.click('#test');
  const portText = await (
    await portPage.waitForFunction(
      () => {
        const text = document.getElementById('result')?.textContent ?? '';
        return text.startsWith('ポート ') ? text : null;
      },
      null,
      { timeout: 5_000 },
    )
  ).jsonValue();
  assert.ok(String(portText).includes(`ポート ${SERVER_PORT} をほかのアプリが使っているため`), `options page said ${JSON.stringify(portText)}`);
  await portPage.close();
  let serverLog = '';
  localServer = spawn(process.execPath, localServerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  localServer.stdout.on('data', (chunk) => (serverLog += chunk));
  for (let i = 0; i < 50 && !serverLog.includes('LecScribe のサーバーを起動できません'); i++) await new Promise((r) => setTimeout(r, 200));
  // 相手の名前は macOS の /usr/sbin/lsof で調べる。CI（Linux）には無いので「ほかのアプリ」になる
  const holder = process.platform === 'darwin' ? '「node」が' : 'ほかのアプリが';
  assert.ok(serverLog.includes(`ポート ${SERVER_PORT} を${holder}使っているため`), `no port-in-use message in the server log:\n${serverLog}`);
  await new Promise((resolve) => foreign.close(resolve));
  let upAgain = false;
  for (let i = 0; i < 75 && !upAgain; i++) {
    upAgain = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`).then((r) => r.ok, () => false);
    if (!upAgain) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(upAgain, `server did not start after the port was freed:\n${serverLog}`);
  console.log('port: a foreign app on the port is named in the server log and the options page; the server starts once it is gone');

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  console.log('smoke ok');
} finally {
  await context.close();
  fixtureServer.kill();
  localServer.kill();
}
