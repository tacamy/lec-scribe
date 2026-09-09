import { defineConfig } from 'wxt';

// Chrome-only Manifest V3 extension. Permissions are added phase by phase;
// see docs/SPEC.md §6.1 for the final set.
export default defineConfig({
  srcDir: '.',
  // Visible folder instead of WXT's default `.output`, which Finder and
  // Chrome's file picker hide.
  outDir: 'dist',
  imports: false,
  manifest: {
    name: 'LecScribe',
    description:
      'Record the audio of a slide video embedded in the page and capture the slides as they change. Nothing leaves your Mac.',
    permissions: [
      'tabCapture', // getMediaStreamId
      'offscreen', // offscreen document that owns the MediaStream
      'activeTab', // temporary access to the tab where Start was pressed
      'storage', // config (local) and live state (session)
      'downloads', // export of recorded sessions (fallback path, SPEC D-07)
      'sidePanel', // the UI lives in the side panel so it stays open while the page is used
      'scripting', // probe と検知用 content script を Start したタブにだけ注入する
    ],
    // ローカルサーバー（Phase 7）向け。fixture ページ（127.0.0.1:8787）への
    // 注入テストにも使う。動画サイトへの常時アクセスは要求しない（activeTab のみ）。
    host_permissions: ['http://127.0.0.1/*'],
    // The same page serves as the action popup and as the side panel. The
    // icon click that opens the popup is what grants activeTab for the tab,
    // which chrome.tabCapture.getMediaStreamId requires; Start in the popup
    // then opens the side panel, which stays open while the page is used.
    action: { default_title: 'LecScribe', default_popup: 'sidepanel.html?mode=popup' },
    minimum_chrome_version: '116',
  },
});
