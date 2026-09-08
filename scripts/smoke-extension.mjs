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
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
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

  assert.deepEqual(errors, [], `page errors: ${errors.join('\n')}`);
  console.log('smoke ok');
} finally {
  await context.close();
}
