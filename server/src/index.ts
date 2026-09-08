/**
 * LecScribe local server (Phase 0 placeholder).
 *
 * Phase 7 adds session upload, token auth, ffmpeg conversion and WhisperKit
 * transcription (docs/SPEC.md §12). For now it only answers /health so the
 * workspace, typecheck and CI have something real to run. It binds to
 * 127.0.0.1 only, which is a hard requirement (SPEC D-10).
 */
import { createServer } from 'node:http';

const HOST = '127.0.0.1';
const PORT = Number(process.env['LEC_SCRIBE_PORT'] ?? 47321);
const VERSION = '0.1.0';

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: VERSION, phase: 0 }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: `${req.method} ${req.url}` } }));
});

server.listen(PORT, HOST, () => {
  console.log(`LecScribe server listening on http://${HOST}:${PORT} (phase 0: /health only)`);
});
