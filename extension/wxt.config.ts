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
    // ストアの「概要」として出る説明（132 文字まで。ダッシュボードに別の欄はない）。特定のサイト向けではない汎用の
    // ノート取りの道具で、個人の学習用。利用するサイトの規約に従うのは使う人の責任（README「使う前に」、SPEC §3.0）。
    // chrome://extensions のカードは 3 行（全角 22 字 × 3 ＝ 66 字ほど）で切れて続きが読めないので、その中に収める（2026-09-25）
    description: '動画を見ながらノートを取る道具。音声と画面を Mac の中だけで文字起こし。個人の学習用。利用するサイトの規約に従ってください',
    permissions: [
      'tabCapture', // getMediaStreamId
      'offscreen', // offscreen document that owns the MediaStream
      'activeTab', // temporary access to the tab where Start was pressed
      'storage', // config (local) and live state (session)
      'sidePanel', // the UI lives in the side panel so it stays open while the page is used
      'alarms', // 送信に失敗した行列を時間を置いて送り直す（#8）
      'scripting', // probe と検知用 content script を Start したタブにだけ注入する
    ],
    // ローカルサーバー（Phase 7）向け。fixture ページ（127.0.0.1:8787）への
    // 注入テストにも使う。動画サイトへの常時アクセスは要求しない（activeTab のみ）。
    host_permissions: ['http://127.0.0.1/*'],
    // ポップアップは持たない。アイコンのクリック（action.onClicked）でそのタブにサイドパネルを開く（SPEC D-12）。
    // このクリックがそのタブの activeTab を与え、chrome.tabCapture.getMediaStreamId はその許可を必要とする
    action: { default_title: 'LecScribe' },
    minimum_chrome_version: '116',
  },
});
