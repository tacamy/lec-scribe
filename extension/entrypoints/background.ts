import { defineBackground } from 'wxt/utils/define-background';
import { loadConfig } from '../src/config';
import { LecError, toErrorInfo } from '../src/errors';
import { makeSessionId } from '../src/format';
import { hasTarget, replyWith, sendToOffscreen, type ToBackground } from '../src/messages';
import { INITIAL_STATE, readState, writeState, type SessionState } from '../src/state';

/**
 * Service worker: owns the state machine and wires popup ⇄ offscreen.
 * It may be terminated at any time, so nothing here is kept in memory
 * across events; the live state is in chrome.storage.session and the
 * MediaStream lives in the offscreen document.
 */
export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!hasTarget(msg, 'sw')) return false;
    return replyWith(handleMessage)(msg, sender, sendResponse);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const state = await readState();
      if (state.tabId === tabId && isActive(state)) await stop('tab closed');
    })();
  });

  void reconcile();
});

async function handleMessage(msg: ToBackground): Promise<object> {
  switch (msg.type) {
    case 'START':
      return { state: await start(msg.tabId) };
    case 'STOP':
      return { state: await stop('user') };
    case 'GET_STATE':
      return { state: await readState() };
    case 'CAPTURE_ENDED':
      return { state: await stop(`capture ended: ${msg.reason}`) };
  }
}

function isActive(state: SessionState): boolean {
  return state.state === 'STARTING' || state.state === 'CAPTURING' || state.state === 'STOPPING';
}

const UNSUPPORTED_URL = /^(chrome|chrome-extension|edge|about|devtools):/;

async function start(tabId: number): Promise<SessionState> {
  const current = await readState();
  if (isActive(current)) throw new LecError('BUSY', 'すでにキャプチャ中です。');

  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) throw new LecError('NO_TAB', '対象のタブが見つかりません。');
  if (tab.url && UNSUPPORTED_URL.test(tab.url)) {
    throw new LecError('UNSUPPORTED_PAGE', 'このページはキャプチャできません。講義ページを開いてから Start してください。');
  }

  const sessionId = makeSessionId();
  const starting: SessionState = {
    ...INITIAL_STATE,
    state: 'STARTING',
    sessionId,
    tabId,
    title: tab.title,
  };
  await writeState(starting);

  try {
    await ensureOffscreenDocument();
    // Requires the extension to have been invoked on this tab (activeTab is
    // granted when the popup opens on it). The id is single-use and short-lived.
    let streamId: string;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (e) {
      throw new LecError('CAPTURE_FAILED', `タブのキャプチャを開始できません: ${toErrorInfo(e).message}`);
    }
    const config = await loadConfig();
    const result = await sendToOffscreen.captureStart(sessionId, streamId, config);
    const capturing: SessionState = {
      ...starting,
      state: 'CAPTURING',
      startedAt: new Date(result.recorderStartEpochMs).toISOString(),
    };
    await writeState(capturing);
    return capturing;
  } catch (e) {
    await closeOffscreenDocument();
    const failed: SessionState = { ...starting, state: 'ERROR', error: toErrorInfo(e) };
    await writeState(failed);
    throw e;
  }
}

async function stop(endedBy: string): Promise<SessionState> {
  const current = await readState();
  if (!isActive(current)) return current;

  await writeState({ ...current, state: 'STOPPING' });
  try {
    await sendToOffscreen.captureStop();
  } catch {
    // The offscreen document may already be gone (e.g. capture ended by Chrome).
  }
  await closeOffscreenDocument();

  const durationMs = current.startedAt ? Date.now() - Date.parse(current.startedAt) : 0;
  const idle: SessionState = {
    ...INITIAL_STATE,
    lastSession: current.sessionId ? { sessionId: current.sessionId, durationMs, endedBy } : undefined,
  };
  await writeState(idle);
  return idle;
}

/** If the worker restarted and the offscreen document is gone, the session cannot continue. */
async function reconcile(): Promise<void> {
  const state = await readState();
  if (!isActive(state)) return;
  if (await hasOffscreenDocument()) return;
  await writeState({
    ...INITIAL_STATE,
    lastSession: state.sessionId ? { sessionId: state.sessionId, durationMs: 0, endedBy: 'extension restarted' } : undefined,
  });
}

const OFFSCREEN_URL = 'offscreen.html';

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture the audio of the lecture tab with chrome.tabCapture and play it back to the user.',
    });
  } catch (e) {
    throw new LecError('OFFSCREEN_FAILED', `offscreen document を作成できません: ${toErrorInfo(e).message}`);
  }
}

async function closeOffscreenDocument(): Promise<void> {
  if (!(await hasOffscreenDocument())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Already closed.
  }
}
