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
    // ストアの「概要」として出る説明（132 文字まで。ダッシュボードに別の欄はない）。何をする拡張かだけを書く。
    // chrome://extensions のカードは 3 行（幅 288px・13px で全角 22 字 × 3、Playwright で測って 73 字前後まで）で切れて
    // 続きが読めないので、その中に収める。個人の学習用・利用するサイトの規約に従うことは、ストアの詳細説明（docs/STORE.md）、
    // README「使う前に」、未接続の画面（§15.1）に書く（SPEC §3.0、2026-09-25）。英数字の前後にスペースは入れない
    description: '動画を再生しながらノートを自動で取ってくれる拡張です。スクリーンショットと文字起こしを並べたMarkdownを、すべてMacの中で作ります',
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
