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
    // ストアにも出る説明（132 文字まで）。特定のサイト向けではない汎用のノート取りの道具で、個人の学習用。
    // 利用するサイトの規約に従うのは使う人の責任（README「使う前に」、SPEC §3.0）
    description:
      'Take notes from a video you watch: records tab audio and saves slides on your Mac. Personal study only; follow the site terms.',
    permissions: [
      'tabCapture', // getMediaStreamId
      'offscreen', // offscreen document that owns the MediaStream
      'activeTab', // temporary access to the tab where Start was pressed
      'storage', // config (local) and live state (session)
      'downloads', // export of recorded sessions (fallback path, SPEC D-07)
      'sidePanel', // the UI lives in the side panel so it stays open while the page is used
      'alarms', // 送信に失敗した行列を時間を置いて送り直す（#8）
      'scripting', // probe と検知用 content script を Start したタブにだけ注入する
    ],
    // ローカルサーバー（Phase 7）向け。fixture ページ（127.0.0.1:8787）への
    // 注入テストにも使う。動画サイトへの常時アクセスは要求しない（activeTab のみ）。
    host_permissions: ['http://127.0.0.1/*'],
    // The same page serves as the action popup and as the side panel. The
    // icon click that opens the popup is what grants activeTab for the tab,
    // which chrome.tabCapture.getMediaStreamId requires; Start in the popup
    // then opens the side panel, which stays open while the page is used.
    // ポップアップは持たない。アイコンのクリック（action.onClicked）でそのタブにサイドパネルを開く（SPEC D-12）
    action: { default_title: 'LecScribe' },
    minimum_chrome_version: '116',
  },
});
