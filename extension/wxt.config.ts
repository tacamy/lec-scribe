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
      'Record lecture audio locally and capture slide changes from the video you are watching. Nothing leaves your Mac.',
    permissions: [
      'tabCapture', // getMediaStreamId
      'offscreen', // offscreen document that owns the MediaStream
      'activeTab', // temporary access to the tab where Start was pressed
      'storage', // config (local) and live state (session)
      'downloads', // export of recorded sessions (fallback path, SPEC D-07)
      'sidePanel', // the UI lives in the side panel so it stays open while the page is used
    ],
    // The same page serves as the action popup and as the side panel. The
    // icon click that opens the popup is what grants activeTab for the tab,
    // which chrome.tabCapture.getMediaStreamId requires; Start in the popup
    // then opens the side panel, which stays open while the page is used.
    action: { default_title: 'LecScribe', default_popup: 'sidepanel.html?mode=popup' },
    minimum_chrome_version: '116',
  },
});
