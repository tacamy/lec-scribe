import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { recoverInterrupted } from './pipeline.ts';
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
  // open スタブ: 開こうとしたパスを記録する
  const open = await writeStub('open', `printf '%s' "$1" > "${path.join(tmp, 'opened.txt')}"`);
  // osascript スタブ: pair-answer.txt の中身（allowed / denied）を返す
  const osascript = await writeStub('osascript', `cat "${path.join(tmp, 'pair-answer.txt')}"`);
  // codex スタブ: --output-last-message のファイルに JSON を書く。本文のプロンプト（<<<SECTION）には
  // id をそのまま返し、話題のプロンプト（<<<PART）には全体の要点と先頭から始まる話題を 1 つ返す
  const codex = await writeStub(
    'codex',
    'out=""; prev=""; for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then out="$a"; fi; prev="$a"; done; prompt="$a"; '
      + 'if printf \'%s\' "$prompt" | grep -q "<<<PART"; then first=$(printf \'%s\' "$prompt" | grep -o \'id="[^"]*"\' | head -1 | sed \'s/id="//; s/"//\'); '
      + 'printf \'{"overview":["全体の要点 1","全体の要点 2"],"topics":[{"heading":"話題 A","summary":["話題 A の要点"],"startId":"%s"}]}\' "$first" > "$out"; exit 0; fi; '
      + 'ids=$(printf \'%s\' "$prompt" | grep -o \'id="[^"]*"\' | sed \'s/id="//; s/"//\'); body=""; for id in $ids; do body="$body{\\"id\\":\\"$id\\",\\"text\\":\\"$id の整えた本文。\\"},"; done; printf \'{"sections":[%s]}\' "${body%,}" > "$out"',
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
    openBin: open,
    osascriptBin: osascript,
    trustedFile: path.join(tmp, 'trusted.json'),
    keepWav: true,
    llm: 'codex',
    llmModel: '',
    codexBin: codex,
    openaiApiKey: '',
    ollamaUrl: 'http://127.0.0.1:1',
    llmCharsPerCall: 4000,
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

    // ユーザー向けは notes.md と slides/ だけ。作業ファイルは .lecscribe/ に入る
    const top = (await readdir(outputDir)).sort();
    expect(top).toEqual(['.lecscribe', 'notes.md', 'slides']);
    const files = (await readdir(outputDir, { recursive: true })).map(String).sort();
    for (const f of [
      '.lecscribe/audio.webm',
      '.lecscribe/audio.wav',
      '.lecscribe/transcript.json',
      '.lecscribe/transcript.srt',
      '.lecscribe/transcript.vtt',
      '.lecscribe/transcript.txt',
      '.lecscribe/lecture.md',
      '.lecscribe/timeline.json',
      '.lecscribe/session.json',
      '.lecscribe/pipeline.json',
      'slides/slide_001.png',
      'notes.md',
    ]) {
      expect(files).toContain(f);
    }
    const lecture = await readFile(path.join(outputDir, '.lecscribe', 'lecture.md'), 'utf8');
    expect(lecture).toContain('# テスト 講義/1');
    expect(lecture).toContain('![slide_001](../slides/slide_001.png)');
    expect(lecture).toContain('次の区間');
    // ノート（codex スタブ）
    expect(status.result).toMatchObject({ notes: true });
    const notes = await readFile(path.join(outputDir, 'notes.md'), 'utf8');
    expect(notes).toContain('# テスト 講義/1（ノート）');
    expect(notes).toContain('![slide_001](slides/slide_001.png)');
    expect(notes).toContain('## 全体の要点\n\n- 全体の要点 1\n- 全体の要点 2');
    expect(notes).toContain('## 話題 A\n\n**要点**\n\n- 話題 A の要点');
    expect(notes).toContain('slide_001 の整えた本文。');
    expect(notes).not.toContain('slide_001 の要点');
    const transcript = JSON.parse(await readFile(path.join(outputDir, '.lecscribe', 'transcript.json'), 'utf8')) as {
      segments: Array<{ start: number; videoStart: number; text: string }>;
    };
    expect(transcript.segments[0]).toMatchObject({ start: 0, videoStart: 0, text: '最初の区間' });
    expect(transcript.segments[1]).toMatchObject({ start: 5.5, videoStart: 103.5, text: '次の区間' });
    const srt = await readFile(path.join(outputDir, '.lecscribe', 'transcript.srt'), 'utf8');
    expect(srt).toContain('00:01:43,500 --> 00:01:50,000\n次の区間');

    // 出力フォルダと lecture.md を開く
    const openedDir = await fetch(`${base}/sessions/${sessionId}/open`, { method: 'POST', headers, body: '{}' });
    expect(openedDir.status).toBe(200);
    expect(await readFile(path.join(tmp, 'opened.txt'), 'utf8')).toBe(outputDir);
    const openedMd = await fetch(`${base}/sessions/${sessionId}/open`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'lecture' }),
    });
    expect(openedMd.status).toBe(200);
    expect(await readFile(path.join(tmp, 'opened.txt'), 'utf8')).toBe(path.join(outputDir, 'notes.md'));

    // 同じ音声で finalize し直すと whisperkit を飛ばして report を再利用する（ノートだけ作り直す）
    const pipeline1 = JSON.parse(await readFile(path.join(outputDir, '.lecscribe', 'pipeline.json'), 'utf8')) as { transcript?: { reused?: boolean; audioBytes: number } };
    expect(pipeline1.transcript).toEqual({ model: 'stub', audioBytes: 7 });
    await writeFile(path.join(outputDir, '.lecscribe', 'whisperkit', 'marker.txt'), 'kept');
    expect((await fetch(`${base}/sessions/${sessionId}/finalize`, { method: 'POST', headers })).status).toBe(202);
    status = { stage: 'queued' };
    for (let i = 0; i < 50 && status.stage !== 'done' && status.stage !== 'error'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await (await fetch(`${base}/sessions/${sessionId}/status`, { headers })).json()) as typeof status;
    }
    expect(status.stage).toBe('done');
    const pipeline2 = JSON.parse(await readFile(path.join(outputDir, '.lecscribe', 'pipeline.json'), 'utf8')) as { transcript?: { reused?: boolean }; timings?: Record<string, number> };
    expect(pipeline2.transcript).toEqual({ model: 'stub', audioBytes: 7, reused: true });
    expect(pipeline2.timings?.transcribing).toBeUndefined();
    // whisperkit フォルダを消していない（スタブが作り直していれば marker は消えている）
    expect(await readFile(path.join(outputDir, '.lecscribe', 'whisperkit', 'marker.txt'), 'utf8')).toBe('kept');
  });

  it('marks sessions left mid-pipeline as errors on startup', async () => {
    const dir = path.join(config.outDir, '20260908-140000-stuk_stuck');
    await (await import('node:fs/promises')).mkdir(path.join(dir, '.lecscribe'), { recursive: true });
    await writeFile(path.join(dir, '.lecscribe', 'pipeline.json'), JSON.stringify({ stage: 'polishing', outputDir: dir, updatedAt: 'x' }));
    const recovered = await recoverInterrupted(config.outDir);
    expect(recovered).toEqual([dir]);
    const after = JSON.parse(await readFile(path.join(dir, '.lecscribe', 'pipeline.json'), 'utf8')) as { stage: string; error?: string };
    expect(after.stage).toBe('error');
    expect(after.error).toContain('polishing');
    expect(await recoverInterrupted(config.outDir)).toEqual([]); // done / error は触らない
  });

  it('moves files of the old flat layout into .lecscribe when a session is processed again', async () => {
    const sessionId = '20260908-120000-old1';
    const dir = path.join(config.outDir, `${sessionId}_old`);
    await (await import('node:fs/promises')).mkdir(path.join(dir, 'slides'), { recursive: true });
    await writeFile(path.join(dir, 'audio.webm'), 'x');
    await writeFile(path.join(dir, 'timeline.json'), '[]');
    await writeFile(path.join(dir, 'lecture.md'), '# old');
    await writeFile(path.join(dir, 'slides', 'slide_001.png'), 'png');
    await fetch(`${base}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, title: 'old' }) });
    const top = (await readdir(dir)).sort();
    expect(top).toEqual(['.lecscribe', 'slides']);
    expect((await readdir(path.join(dir, '.lecscribe'))).sort()).toEqual(['audio.webm', 'lecture.md', 'session.json', 'timeline.json']);
  });

  it('cancels a running pipeline and deletes the session on request', async () => {
    // 遅い whisperkit スタブで別サーバーを立て、実行中に中止する
    const slow = await writeStub('whisperkit-slow', 'sleep 30');
    const { server: slowServer } = createApp({ ...config, whisperkitBin: slow, outDir: path.join(tmp, 'out-slow') }, TOKEN);
    await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
    const slowBase = `http://127.0.0.1:${(slowServer.address() as AddressInfo).port}`;
    try {
      const sessionId = '20260908-130000-canc';
      await fetch(`${slowBase}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, title: 'cancel' }) });
      await fetch(`${slowBase}/sessions/${sessionId}/files/audio.webm`, { method: 'PUT', headers, body: 'x' });
      await fetch(`${slowBase}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
      // whisperkit（sleep）に入るまで待つ
      for (let i = 0; i < 50; i++) {
        const s = (await (await fetch(`${slowBase}/sessions/${sessionId}/status`, { headers })).json()) as { stage: string };
        if (s.stage === 'transcribing') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const started = Date.now();
      const res = await fetch(`${slowBase}/sessions/${sessionId}/cancel`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ delete: true }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, cancelled: true, deleted: true });
      expect(Date.now() - started).toBeLessThan(5000); // sleep 30 を待たずに止まる
      const gone = await fetch(`${slowBase}/sessions/${sessionId}/status`, { headers });
      expect(gone.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    }
  });

  it('pairs an extension through the confirmation dialog and then accepts it without a token', async () => {
    const other = 'chrome-extension://ppppppppppppppppppppppppppppppp';
    const noToken = { origin: ORIGIN };
    expect((await fetch(`${base}/sessions/20260908-103005-ab12/status`, { headers: noToken })).status).toBe(401);
    // Web ページや ID の形が違う Origin は承認できない
    expect((await fetch(`${base}/pair`, { method: 'POST', headers: { origin: 'https://example.com' } })).status).toBe(403);
    expect((await fetch(`${base}/pair`, { method: 'POST', headers: { origin: other } })).status).toBe(403);
    // 「許可しない」
    await writeFile(path.join(tmp, 'pair-answer.txt'), 'denied\n');
    const denied = await fetch(`${base}/pair`, { method: 'POST', headers: { ...noToken, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'LecScribe' }) });
    expect(denied.status).toBe(403);
    expect((await fetch(`${base}/sessions/20260908-103005-ab12/status`, { headers: noToken })).status).toBe(401);
    // 「許可」→ 拡張専用のトークンが発行され、それで通る。/health も paired を返す
    await writeFile(path.join(tmp, 'pair-answer.txt'), 'allowed\n');
    const allowed = await fetch(`${base}/pair`, { method: 'POST', headers: { ...noToken, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'LecScribe\u0000<x>' }) });
    expect(allowed.status).toBe(200);
    const issued = (await allowed.json()) as { ok: boolean; paired: boolean; token: string };
    expect(issued).toMatchObject({ ok: true, paired: true });
    expect(issued.token.length).toBeGreaterThanOrEqual(32);
    const withIssued = { authorization: `Bearer ${issued.token}` };
    expect((await fetch(`${base}/sessions/20260908-103005-ab12/status`, { headers: withIssued })).status).toBe(200);
    expect((await fetch(`${base}/sessions/20260908-103005-ab12/status`, { headers: noToken })).status).toBe(401);
    expect(await (await fetch(`${base}/health`, { headers: withIssued })).json()).toMatchObject({ authorized: true, paired: true });
    expect(await (await fetch(`${base}/health`, { headers })).json()).toMatchObject({ authorized: true, paired: false });
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ authorized: false, paired: false });
    const saved = JSON.parse(await readFile(path.join(tmp, 'trusted.json'), 'utf8')) as { extensions: Array<{ id: string; name: string; token: string }> };
    expect(saved.extensions).toMatchObject([{ id: ORIGIN.slice('chrome-extension://'.length), name: 'LecScribe<x>', token: issued.token }]);
    // 承認済みなら再度 pair してもダイアログは出ず、同じトークンが返る
    await writeFile(path.join(tmp, 'pair-answer.txt'), 'denied\n');
    expect(await (await fetch(`${base}/pair`, { method: 'POST', headers: noToken })).json()).toMatchObject({ paired: true, already: true, token: issued.token });
  });

  it('refuses finalize before the audio arrived', async () => {
    const sessionId = '20260908-110000-zzzz';
    await fetch(`${base}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    const res = await fetch(`${base}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
    expect(res.status).toBe(409);
  });
});
