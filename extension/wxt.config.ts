import { defineConfig } from 'wxt';

// Chrome-only Manifest V3 extension. Permissions are added phase by phase;
// see docs/SPEC.md §6.1 for the final set.
export default defineConfig({
  srcDir: '.',
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
    ],
    minimum_chrome_version: '116',
  },
});
