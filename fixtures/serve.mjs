// Static server for the fixtures directory with HTTP Range support, which
// <video> needs for seeking. Usage: node fixtures/serve.mjs [port]
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? process.env.PORT ?? 8787);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const rel = decodeURIComponent(url.pathname === '/' ? '/player.html' : url.pathname);
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return end(res, 403);
  let info;
  try {
    info = await stat(file);
  } catch {
    return end(res, 404);
  }
  if (!info.isFile()) return end(res, 404);

  const headers = {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const endByte = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start >= info.size || start > endByte) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${endByte}/${info.size}`, 'content-length': endByte - start + 1 });
    return createReadStream(file, { start, end: endByte }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': info.size });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`fixtures: http://127.0.0.1:${port}/player.html`);
});

function end(res, status) {
  res.writeHead(status);
  res.end();
}
