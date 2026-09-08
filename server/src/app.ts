import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { ServerConfig } from './config.ts';
import { resolveBin, run } from './exec.ts';
import { slugify } from './format.ts';
import { NOTES_FILE, SLIDES_DIR, ensureLayout, migrateLayout, workPath } from './layout.ts';
import { Pipeline, readPipelineStatus, writeStatus, type PipelineStatus } from './pipeline.ts';
import { isAuthorized } from './token.ts';

export const VERSION = '0.1.0';

/** 拡張が POST /sessions で送る内容（拡張側 session.json 相当） */
type SessionMeta = { sessionId: string; title?: string; url?: string; startedAt?: string; config?: unknown };

const SESSION_ID = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$|^[a-z0-9][a-z0-9-]{3,63}$/;
/** PUT /sessions/:id/files/<name> で受け付けるファイル */
const UPLOAD_NAME = /^(audio\.webm|slides\.json|timeline\.json|capture-status\.json|slides\/slide_[0-9]{3}\.(png|jpg))$/;
const MAX_JSON_BODY = 5 * 1024 * 1024;

export type App = { server: Server; pipeline: Pipeline; findSessionDir(sessionId: string): Promise<string | null> };

export function createApp(config: ServerConfig, token: string, log: (message: string) => void = () => undefined): App {
  const pipeline = new Pipeline(config, log);
  const dirCache = new Map<string, string>();

  async function findSessionDir(sessionId: string): Promise<string | null> {
    const cached = dirCache.get(sessionId);
    if (cached) return cached;
    try {
      const entries = await readdir(config.outDir, { withFileTypes: true });
      const hit = entries.find((e) => e.isDirectory() && (e.name === sessionId || e.name.startsWith(`${sessionId}_`)));
      if (!hit) return null;
      const dir = path.join(config.outDir, hit.name);
      dirCache.set(sessionId, dir);
      return dir;
    } catch {
      return null;
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      log(`error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: String(e) } });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${config.host}`);
    const origin = req.headers.origin;
    // 拡張ページからの fetch は host_permissions があれば CORS 対象外の見込みだが、
    // 念のため preflight にも応える（SPEC §12.3）
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    // Web ページからの呼び出しは拒否する。Origin がない（curl 等）場合はトークンだけで判断する
    if (origin && !origin.startsWith('chrome-extension://')) {
      sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: `origin not allowed: ${origin}` } });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        phase: 7,
        model: config.model,
        language: config.language,
        outDir: config.outDir,
        ffmpeg: (await resolveBin(config.ffmpegBin)) !== null,
        whisperkit: (await resolveBin(config.whisperkitBin)) !== null,
        authorized: isAuthorized(req.headers.authorization, token),
      });
      return;
    }

    if (!isAuthorized(req.headers.authorization, token)) {
      sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'トークンが一致しません。' } });
      return;
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'sessions') {
      sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` } });
      return;
    }

    // POST /sessions
    if (req.method === 'POST' && parts.length === 1) {
      const meta = (await readJsonBody(req)) as SessionMeta | undefined;
      if (!meta || typeof meta.sessionId !== 'string' || !SESSION_ID.test(meta.sessionId)) {
        sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId が不正です。' } });
        return;
      }
      let dir = await findSessionDir(meta.sessionId);
      if (!dir) {
        const slug = slugify(meta.title);
        dir = path.join(config.outDir, slug ? `${meta.sessionId}_${slug}` : meta.sessionId);
        dirCache.set(meta.sessionId, dir);
      }
      await ensureLayout(dir);
      await migrateLayout(dir);
      await writeFile(workPath(dir, 'session.json'), JSON.stringify({ ...meta, receivedAt: new Date().toISOString() }, null, 2));
      log(`session ${meta.sessionId} → ${dir}`);
      sendJson(res, 201, { ok: true, sessionId: meta.sessionId, outputDir: dir });
      return;
    }

    const sessionId = parts[1] ?? '';
    if (!SESSION_ID.test(sessionId)) {
      sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionId が不正です。' } });
      return;
    }
    const dir = await findSessionDir(sessionId);
    if (!dir) {
      sendJson(res, 404, { ok: false, error: { code: 'NO_SESSION', message: `セッション ${sessionId} がありません。POST /sessions が先です。` } });
      return;
    }

    // PUT /sessions/:id/files/<name>
    if (req.method === 'PUT' && parts[2] === 'files') {
      const name = decodeURIComponent(parts.slice(3).join('/'));
      if (!UPLOAD_NAME.test(name)) {
        sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: `受け付けないファイル名です: ${name}` } });
        return;
      }
      // 画像はユーザー向けの slides/ に、それ以外の作業ファイルは .lecscribe/ に置く
      const target = name.startsWith(`${SLIDES_DIR}/`) ? path.join(dir, name) : workPath(dir, name);
      const tmp = `${target}.part`;
      await mkdir(path.dirname(target), { recursive: true });
      await streamPipeline(req, createWriteStream(tmp));
      await rename(tmp, target);
      const { size } = await stat(target);
      sendJson(res, 200, { ok: true, name, bytes: size });
      return;
    }

    // POST /sessions/:id/finalize
    if (req.method === 'POST' && parts[2] === 'finalize' && parts.length === 3) {
      await migrateLayout(dir);
      try {
        await stat(workPath(dir, 'audio.webm'));
      } catch {
        sendJson(res, 409, { ok: false, error: { code: 'NO_AUDIO', message: 'audio.webm がまだありません。' } });
        return;
      }
      if (pipeline.isRunning(dir)) {
        sendJson(res, 202, { ok: true, stage: 'queued', outputDir: dir });
        return;
      }
      const queued: PipelineStatus = { stage: 'queued', outputDir: dir, updatedAt: new Date().toISOString() };
      await writeStatus(dir, queued);
      void pipeline.enqueue(dir);
      sendJson(res, 202, { ok: true, ...queued });
      return;
    }

    // POST /sessions/:id/open { target?: 'folder' | 'lecture' } — 出力を Finder / 既定のアプリで開く
    if (req.method === 'POST' && parts[2] === 'open' && parts.length === 3) {
      const body = ((await readJsonBody(req)) ?? {}) as { target?: string };
      const target = body.target === 'lecture' ? path.join(dir, NOTES_FILE) : dir;
      try {
        await stat(target);
      } catch {
        sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `${path.basename(target)} がまだありません。` } });
        return;
      }
      const r = await run(config.openBin, [target]).catch((e: unknown) => ({ code: -1, stdout: '', stderr: String(e) }));
      if (r.code !== 0) {
        sendJson(res, 500, { ok: false, error: { code: 'OPEN_FAILED', message: `開けませんでした: ${r.stderr.trim() || r.code}` } });
        return;
      }
      sendJson(res, 200, { ok: true, opened: target });
      return;
    }

    // GET /sessions/:id/status
    if (req.method === 'GET' && parts[2] === 'status' && parts.length === 3) {
      const status = (await readPipelineStatus(dir)) ?? { stage: 'uploaded', outputDir: dir, updatedAt: new Date().toISOString() };
      sendJson(res, 200, { ok: true, ...status });
      return;
    }

    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` } });
  }

  return { server, pipeline, findSessionDir };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** セッションごとの成果物一覧（デバッグ・将来の一覧 API 用） */
export async function listOutputs(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).filter((f) => !f.endsWith('.part')).sort();
}

export { readFile };
