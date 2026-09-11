import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { ServerConfig } from './config.ts';
import { resolveBin, run } from './exec.ts';
import { visionStatus } from './vision.ts';
import { slugify } from './format.ts';
import { NOTES_FILE, SLIDES_DIR, ensureLayout, migrateLayout, workPath } from './layout.ts';
import { Pipeline, readPipelineStatus, writeStatus, type PipelineStatus } from './pipeline.ts';
import { isAuthorized } from './token.ts';
import { askPermission, extensionIdFromOrigin, sanitizeName, saveTrusted, trustedByToken, type Trusted } from './pairing.ts';

export const VERSION = '0.1.0';
/**
 * 拡張とサーバーの約束（HTTP の形）の版（§12.1c、#7）。拡張は必要な最低の版を持っていて、
 * /health で受け取って比べ、古ければ「Mac 側のサーバーが古い」と出す。
 * 上げるのは約束が変わったときだけ（新しいフィールドを拡張が送る・受け取る、意味が変わる）。
 * 内部の改善やノートの作り方の変更では上げない。
 *   1: 2026-09-11。cancel の force、status の 404、title 先頭のフォルダ名、までを含む
 *   2: 2026-09-11。/health に vision（見た目の判定の補助コマンドの状態）と visionReason（#17）。
 *      見せるだけの項目なので、拡張が必要とする最低の版は 1 のまま
 */
export const API_VERSION = 2;

/** 拡張が POST /sessions で送る内容（拡張側 session.json 相当） */
type SessionMeta = { sessionId: string; title?: string; url?: string; startedAt?: string; config?: unknown };

const SESSION_ID = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$|^[a-z0-9][a-z0-9-]{3,63}$/;
/** PUT /sessions/:id/files/<name> で受け付けるファイル */
const UPLOAD_NAME = /^(audio\.webm|slides\.json|timeline\.json|capture-status\.json|slides\/slide_[0-9]{3,}\.(png|jpg))$/;
const MAX_JSON_BODY = 5 * 1024 * 1024;

export type App = { server: Server; pipeline: Pipeline; findSessionDir(sessionId: string): Promise<string | null> };

export function createApp(
  config: ServerConfig,
  token: string,
  log: (message: string) => void = () => undefined,
  trusted: Trusted = { entries: new Map(), file: config.trustedFile },
  /** 動いているコードのコミット（診断用。/health に載せる）。分からなければ null */
  build: { commit: string | null } = { commit: null },
): App {
  const pipeline = new Pipeline(config, log);
  /** 承認ダイアログは同時に 1 つだけ */
  let pairing = false;

  /** 共有トークンか、承認時に発行した拡張ごとのトークンが合えば通す */
  function authorized(req: IncomingMessage): boolean {
    return isAuthorized(req.headers.authorization, token) || trustedByToken(trusted, req.headers.authorization) !== null;
  }
  const dirCache = new Map<string, string>();

  async function findSessionDir(sessionId: string): Promise<string | null> {
    const cached = dirCache.get(sessionId);
    // Finder で消されていることがあるので、覚えていても実在を確かめる（消えていれば 404 にして拡張に「データなし」を出させる）
    if (cached) {
      if (await stat(cached).then((st) => st.isDirectory()).catch(() => false)) return cached;
      dirCache.delete(sessionId);
    }
    try {
      const entries = await readdir(config.outDir, { withFileTypes: true });
      // 現在は <タイトル>_<ID>。2026-09-11 より前に作った <ID>_<タイトル> も見つける
      const hit = entries.find((e) => e.isDirectory() && (e.name === sessionId || e.name.endsWith(`_${sessionId}`) || e.name.startsWith(`${sessionId}_`)));
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
    // DNS リバインディング対策: Host は 127.0.0.1 / localhost だけ受け付ける（SPEC §12.3）
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
      sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN_HOST', message: `host not allowed: ${req.headers.host ?? ''}` } });
      return;
    }
    // Web ページからの呼び出しは拒否する。Origin がない（curl 等）場合はトークンだけで判断する
    if (origin && !origin.startsWith('chrome-extension://')) {
      sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: `origin not allowed: ${origin}` } });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const [ffmpeg, whisperkit, vision] = await Promise.all([resolveBin(config.ffmpegBin), resolveBin(config.whisperkitBin), visionStatus(config)]);
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        // 拡張が「話が通じるか」を判断する版と、問い合わせのときに使うコミット（§12.1c）
        api: API_VERSION,
        commit: build.commit,
        phase: 7,
        model: config.model,
        language: config.language,
        outDir: config.outDir,
        ffmpeg: ffmpeg !== null,
        whisperkit: whisperkit !== null,
        // 見た目の判定（§13.4b）の補助コマンドの状態。作れなかったことと理由を利用者に見せるため（#17。api 2 から）。
        // ready / building / idle / failed。使わない設定と macOS 以外は null
        vision: vision?.state ?? null,
        ...(vision?.state === 'failed' ? { visionReason: vision.reason } : {}),
        // ノート作成の呼び出し先。拡張の設定画面が「未設定なら有効にする手順」を出すのに使う
        llm: config.llm,
        authorized: authorized(req),
        paired: trustedByToken(trusted, req.headers.authorization) !== null,
        processing: pipeline.activeCount(),
      });
      return;
    }

    // POST /pair { name? } — 拡張からの接続を macOS のダイアログで承認し、その拡張 ID を記憶する
    if (req.method === 'POST' && url.pathname === '/pair') {
      const id = extensionIdFromOrigin(origin);
      if (!id) {
        sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: '拡張機能からの要求ではありません。' } });
        return;
      }
      const known = trusted.entries.get(id);
      if (known) {
        // 承認済み。Origin はブラウザが付けるので、この拡張だけがトークンを受け取れる
        sendJson(res, 200, { ok: true, paired: true, already: true, token: known.token });
        return;
      }
      if (pairing) {
        sendJson(res, 429, { ok: false, error: { code: 'BUSY', message: '承認ダイアログを表示中です。Mac の画面で「許可」を押してください。' } });
        return;
      }
      pairing = true; // body を読む間に別の要求が来ても 2 つ目のダイアログを出さない
      try {
        const body = ((await readJsonBody(req)) ?? {}) as { name?: unknown };
        const name = sanitizeName(body.name) || 'Chrome 拡張';
        log(`pair request from ${id} (${name})`);
        const allowed = await askPermission(
          config.osascriptBin,
          `Chrome 拡張「${name}」（ID: ${id}）が LecScribe サーバーへの接続を求めています。\n\n許可すると、この拡張は録音を送って文字起こしを始めたり、${config.outDir} のフォルダを開いたり消したりできます。`,
        );
        if (!allowed) {
          log(`pair denied: ${id}`);
          sendJson(res, 403, { ok: false, paired: false, error: { code: 'DENIED', message: '接続が許可されませんでした。' } });
          return;
        }
        const entry = await saveTrusted(trusted, id, name);
        log(`paired: ${id} (${name}) → ${trusted.file}`);
        sendJson(res, 200, { ok: true, paired: true, token: entry.token });
      } finally {
        pairing = false;
      }
      return;
    }

    if (!authorized(req)) {
      sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '接続が承認されていません。拡張の設定画面で「このMacと接続」を押してください。' } });
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
        // Finder で並べたときにタイトルで探せるよう、タイトルを先に、ID を後ろに付ける
        dir = path.join(config.outDir, slug ? `${slug}_${meta.sessionId}` : meta.sessionId);
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
      // 前回の文字起こしの条件（transcript）は引き継ぐ。同じ音声なら whisperkit を飛ばせる
      const previous = await readPipelineStatus(dir);
      const queued: PipelineStatus = { stage: 'queued', outputDir: dir, updatedAt: new Date().toISOString(), transcript: previous?.transcript };
      await writeStatus(dir, queued);
      void pipeline.enqueue(dir);
      sendJson(res, 202, { ok: true, ...queued });
      return;
    }

    // POST /sessions/:id/cancel { delete?: boolean; force?: boolean } — 処理を中止する。delete でフォルダごと消す
    if (req.method === 'POST' && parts[2] === 'cancel' && parts.length === 3) {
      const body = ((await readJsonBody(req)) ?? {}) as { delete?: boolean; force?: boolean };
      const cancelled = await pipeline.cancel(dir);
      let deleted = false;
      if (body.delete === true) {
        // 成果物（notes.md）が既にあるフォルダは消さない。「やり直す」中の中止で完成済みのノートを失わないため。
        // 利用者が一覧の「削除」で明示したとき（force）だけ、notes.md があっても消す
        const hasNotes = body.force === true ? false : await stat(path.join(dir, NOTES_FILE)).then(() => true).catch(() => false);
        if (hasNotes) {
          log(`cancel ${sessionId}: notes.md があるので削除しない`);
        } else {
          await rm(dir, { recursive: true, force: true });
          dirCache.delete(sessionId);
          deleted = true;
          log(`deleted ${sessionId} (${dir})`);
        }
      } else if (cancelled) {
        log(`cancelled ${sessionId}`);
      }
      sendJson(res, 200, { ok: true, cancelled, deleted });
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
