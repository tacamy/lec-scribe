import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import type { ServerConfig } from './config.ts';

/**
 * サーバーを実際に起動し、ffmpeg と whisperkit-cli をスタブに差し替えて
 * アップロード → finalize → 成果物まで通す（SPEC §12）。
 */
const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

let tmp: string;
let base: string;
let config: ServerConfig;
let close: () => Promise<void>;

async function writeStub(name: string, body: string): Promise<string> {
  const file = path.join(tmp, 'bin', name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'lec-scribe-'));
  await writeFile(path.join(tmp, '.keep'), '');
  await (await import('node:fs/promises')).mkdir(path.join(tmp, 'bin'));
  // ffmpeg スタブ: 入力をそのまま出力にコピーする
  const ffmpeg = await writeStub('ffmpeg', 'out=""; for a in "$@"; do out="$a"; done; in=""; prev=""; for a in "$@"; do if [ "$prev" = "-i" ]; then in="$a"; fi; prev="$a"; done; cp "$in" "$out"');
  // whisperkit-cli スタブ: --report-path に report JSON を書く
  const whisperkit = await writeStub(
    'whisperkit-cli',
    'dir=""; prev=""; for a in "$@"; do if [ "$prev" = "--report-path" ]; then dir="$a"; fi; prev="$a"; done; mkdir -p "$dir"; printf \'%s\' \'{"segments":[{"start":0,"end":5.5,"text":"<|ja|> 最初の区間 "},{"start":5.5,"end":12,"text":"次の区間"}]}\' > "$dir/audio.json"; echo transcribed',
  );
  config = {
    host: '127.0.0.1',
    port: 0,
    outDir: path.join(tmp, 'out'),
    model: 'stub',
    language: 'ja',
    tokenFile: path.join(tmp, 'token'),
    whisperkitBin: whisperkit,
    ffmpegBin: ffmpeg,
    keepWav: true,
  };
  const { server } = createApp(config, TOKEN);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close();
});

const headers = { authorization: `Bearer ${TOKEN}`, origin: ORIGIN };

describe('local server', () => {
  it('answers /health without a token and reports the tools', async () => {
    const res = await fetch(`${base}/health`, { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ffmpeg: true, whisperkit: true, authorized: false, model: 'stub' });
  });

  it('rejects a wrong token and a web origin', async () => {
    const wrong = await fetch(`${base}/sessions`, { method: 'POST', headers: { authorization: 'Bearer nope', origin: ORIGIN } });
    expect(wrong.status).toBe(401);
    const web = await fetch(`${base}/sessions`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' } });
    expect(web.status).toBe(403);
    const preflight = await fetch(`${base}/sessions`, { method: 'OPTIONS', headers: { origin: ORIGIN } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('runs a session through upload, finalize and the pipeline', async () => {
    const sessionId = '20260908-103005-ab12';
    const created = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, title: 'テスト 講義/1', startedAt: '2026-09-08T01:30:05.000Z' }),
    });
    expect(created.status).toBe(201);
    const { outputDir } = (await created.json()) as { outputDir: string };
    expect(path.basename(outputDir)).toBe('20260908-103005-ab12_テスト_講義_1');

    const put = (name: string, body: string | Uint8Array) =>
      fetch(`${base}/sessions/${sessionId}/files/${name}`, { method: 'PUT', headers, body });
    expect((await put('audio.webm', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]))).status).toBe(200);
    expect((await put('slides/slide_001.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).status).toBe(200);
    expect((await put('slides.json', JSON.stringify([{ filename: 'slide_001.png', videoTime: 0, t: 0 }]))).status).toBe(200);
    // 録音 2 秒目に動画 100 秒へシークしたタイムライン → 文字起こしの時刻が動画時刻に変換される
    const timeline = [
      { t: 0, videoTime: 0, rate: 1, state: 'playing', type: 'start' },
      { t: 2, videoTime: 100, rate: 1, state: 'playing', type: 'seeked' },
    ];
    expect((await put('timeline.json', JSON.stringify(timeline))).status).toBe(200);
    expect((await put('..%2Fescape.txt', 'x')).status).toBe(400);
    expect((await put('slides/evil.sh', 'x')).status).toBe(400);

    const finalized = await fetch(`${base}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
    expect(finalized.status).toBe(202);

    let status: { stage: string; error?: string; result?: { segments: number; hasTimeline: boolean } } = { stage: 'queued' };
    for (let i = 0; i < 50 && status.stage !== 'done' && status.stage !== 'error'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await (await fetch(`${base}/sessions/${sessionId}/status`, { headers })).json()) as typeof status;
    }
    expect(status.error).toBeUndefined();
    expect(status.stage).toBe('done');
    expect(status.result).toMatchObject({ segments: 2, hasTimeline: true });

    const files = (await readdir(outputDir, { recursive: true })).sort();
    for (const f of ['audio.webm', 'audio.wav', 'transcript.json', 'transcript.srt', 'transcript.vtt', 'transcript.txt', 'lecture.md', 'slides/slide_001.png', 'timeline.json', 'session.json', 'pipeline.json']) {
      expect(files).toContain(f);
    }
    const lecture = await readFile(path.join(outputDir, 'lecture.md'), 'utf8');
    expect(lecture).toContain('# テスト 講義/1');
    expect(lecture).toContain('![slide_001](slides/slide_001.png)');
    expect(lecture).toContain('次の区間');
    const transcript = JSON.parse(await readFile(path.join(outputDir, 'transcript.json'), 'utf8')) as {
      segments: Array<{ start: number; videoStart: number; text: string }>;
    };
    expect(transcript.segments[0]).toMatchObject({ start: 0, videoStart: 0, text: '最初の区間' });
    expect(transcript.segments[1]).toMatchObject({ start: 5.5, videoStart: 103.5, text: '次の区間' });
    const srt = await readFile(path.join(outputDir, 'transcript.srt'), 'utf8');
    expect(srt).toContain('00:01:43,500 --> 00:01:50,000\n次の区間');
  });

  it('refuses finalize before the audio arrived', async () => {
    const sessionId = '20260908-110000-zzzz';
    await fetch(`${base}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    const res = await fetch(`${base}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
    expect(res.status).toBe(409);
  });
});
