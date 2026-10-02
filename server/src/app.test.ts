import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { readPipelineStatus, recoverInterrupted, type PipelineStatus } from './pipeline.ts';
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
  await mkdir(path.join(tmp, 'bin'));
  // ffmpeg スタブ: 入力をそのまま出力にコピーする
  const ffmpeg = await writeStub('ffmpeg', 'out=""; for a in "$@"; do out="$a"; done; in=""; prev=""; for a in "$@"; do if [ "$prev" = "-i" ]; then in="$a"; fi; prev="$a"; done; cp "$in" "$out"');
  // whisperkit-cli スタブ: --report-path に report JSON を書く。report-override.json があればその中身を書く（区間を変えたい試験用）
  const whisperkit = await writeStub(
    'whisperkit-cli',
    `dir=""; prev=""; for a in "$@"; do if [ "$prev" = "--report-path" ]; then dir="$a"; fi; prev="$a"; done; mkdir -p "$dir"; if [ -f "${path.join(tmp, 'report-override.json')}" ]; then cp "${path.join(tmp, 'report-override.json')}" "$dir/audio.json"; else printf '%s' '{"segments":[{"start":0,"end":5.5,"text":"<|ja|> 最初の区間 "},{"start":5.5,"end":12,"text":"次の区間"}]}' > "$dir/audio.json"; fi; echo transcribed`,
  );
  // open スタブ: 開こうとしたパスを記録する
  const open = await writeStub('open', `printf '%s' "$1" > "${path.join(tmp, 'opened.txt')}"`);
  // osascript スタブ: 受け取った引数（AppleScript とダイアログの本文）を pair-args.txt に残し、pair-answer.txt の中身（allowed / denied）を返す
  const osascript = await writeStub('osascript', `printf '%s\\n' "$@" > "${path.join(tmp, 'pair-args.txt')}"; cat "${path.join(tmp, 'pair-answer.txt')}"`);
  // codex スタブ: --output-last-message のファイルに JSON を書く。本文のプロンプト（<<<SECTION）には
  // id をそのまま返し、話題のプロンプト（<<<PART）には全体の要点と先頭から始まる話題を 1 つ返す
  const codex = await writeStub(
    'codex',
    // --model check-fail は一時的な失敗、--model model-gone は「モデルが使えない」失敗のふり（受け皿の試験用）
    'for a in "$@"; do if [ "$a" = "check-fail" ]; then echo "temporarily rate limited" >&2; exit 1; fi; if [ "$a" = "model-gone" ]; then echo "ERROR: The \x27model-gone\x27 model is not supported when using Codex with a ChatGPT account." >&2; exit 1; fi; done; '
      + 'out=""; prev=""; for a in "$@"; do if [ "$prev" = "--output-last-message" ]; then out="$a"; fi; prev="$a"; done; prompt="$a"; '
      + 'if printf \'%s\' "$prompt" | grep -q "原文"; then first=$(printf \'%s\' "$prompt" | grep -o \'id="[^"]*"\' | head -1 | sed \'s/id="//; s/"//\'); printf \'{"corrections":[{"id":"%s","wrong":"整えた","right":"校正済みの"}]}\' "$first" > "$out"; exit 0; fi; '
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
    settingsFile: path.join(tmp, 'settings.json'),
    keepWav: true,
    llm: 'codex',
    llmModel: '',
    llmCheckModel: '',
    // 統合テストの ffmpeg スタブではサムネイルが作れず場面の判定が空になるので、画像の救出も動かない。切っておく
    llmPickModel: '',
    codexBin: codex,
    openaiApiKey: '',
    ollamaUrl: 'http://127.0.0.1:1',
    llmCharsPerCall: 4000,
    sceneColor: 0, // ffmpeg のスタブではサムネイルが作れないので、場面の判定は切る
    sceneVision: 0,
    sceneVisionPhoto: 0,
    sceneKeep: 'last',
    managed: false,
  autoUpdate: false,
    appDir: tmp,
    branch: 'main',
    gitBin: 'git',
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
    // この fixture は Vision を使わない設定（sceneVision も sceneVisionPhoto も 0）なので null
    expect(body).toMatchObject({ ok: true, ffmpeg: true, whisperkit: true, authorized: false, model: 'stub', vision: null });
  });

  it('/health の vision は、Vision を使う設定なら補助コマンドの状態を返す（#17。中身は vision.test.ts）', async () => {
    const { server: app } = createApp({ ...config, sceneVision: 0.2 }, TOKEN);
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const body = (await (await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/health`, { headers: { origin: ORIGIN } })).json()) as {
        vision?: unknown;
        visionReason?: unknown;
      };
      if (process.platform === 'darwin') {
        expect(['ready', 'building', 'idle', 'failed']).toContain(body.vision);
        if (body.vision === 'failed') expect(typeof body.visionReason).toBe('string');
        else expect(body.visionReason).toBeUndefined();
      } else {
        expect(body.vision).toBeNull(); // macOS 以外では使わない
      }
    } finally {
      await new Promise<void>((resolve) => app.close(() => resolve()));
    }
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

  it('画像の境目をまたぐ区間を文の切れ目で分けても、字幕と区間の数はもとの区間のまま（§13.4）', async () => {
    // 区間 1 の途中（「なります」）で前の話題が終わり、14 秒に次の画像が出る
    await writeFile(
      path.join(tmp, 'report-override.json'),
      JSON.stringify({
        segments: [
          { start: 0, end: 30, text: '前の話題をまとめると大事なことはここまでになります次に新しい図の話をしていきますのでよく見てください' },
          { start: 30, end: 35, text: '以上です' },
        ],
      }),
    );
    try {
      const sessionId = '20261002-120000-sp01';
      const created = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, title: '分割の試験', startedAt: '2026-10-02T03:00:00.000Z' }),
      });
      const { outputDir } = (await created.json()) as { outputDir: string };
      const put = (name: string, body: string | Uint8Array) => fetch(`${base}/sessions/${sessionId}/files/${name}`, { method: 'PUT', headers, body });
      await put('audio.webm', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9, 9]));
      await put('slides/slide_001.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      await put('slides/slide_002.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]));
      await put(
        'slides.json',
        JSON.stringify([
          { filename: 'slide_001.png', videoTime: 0, t: 0, reason: 'initial' },
          { filename: 'slide_002.png', videoTime: 14, t: 14, reason: 'manual' },
        ]),
      );
      expect((await fetch(`${base}/sessions/${sessionId}/finalize`, { method: 'POST', headers })).status).toBe(202);
      let status: { stage: string; error?: string; result?: { segments: number } } = { stage: 'queued' };
      for (let i = 0; i < 50 && status.stage !== 'done' && status.stage !== 'error'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        status = (await (await fetch(`${base}/sessions/${sessionId}/status`, { headers })).json()) as typeof status;
      }
      expect(status.stage).toBe('done');
      // 区間の数は Whisper の区間（2）
      expect(status.result).toMatchObject({ segments: 2 });
      const lecture = await readFile(path.join(outputDir, '.lecscribe', 'lecture.md'), 'utf8');
      expect(lecture).toContain('文字起こし: 2 区間');
      // 前の話題の締めは slide_001 の節、「次に」からは slide_002 の節
      const before = lecture.indexOf('ここまでになります');
      const image = lecture.indexOf('![slide_002]');
      const after = lecture.indexOf('次に新しい図の話を');
      expect(before).toBeGreaterThan(-1);
      expect(before).toBeLessThan(image);
      expect(image).toBeLessThan(after);
      // transcript.json だけは分けた区間（3 つ）。字幕はもとの 2 区間
      const transcript = JSON.parse(await readFile(path.join(outputDir, '.lecscribe', 'transcript.json'), 'utf8')) as {
        segments: Array<{ slide?: string; text: string }>;
      };
      expect(transcript.segments.map((s) => s.slide)).toEqual(['slide_001.png', 'slide_002.png', 'slide_002.png']);
      const srt = await readFile(path.join(outputDir, '.lecscribe', 'transcript.srt'), 'utf8');
      expect(srt.match(/-->/g)).toHaveLength(2);
      expect(srt).toContain('前の話題をまとめると大事なことはここまでになります次に新しい図の話を');
    } finally {
      await rm(path.join(tmp, 'report-override.json'), { force: true });
    }
  });

  it('runs a session through upload, finalize and the pipeline', async () => {
    const sessionId = '20260908-103005-ab12';
    const created = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, title: 'テスト 動画/1', startedAt: '2026-09-08T01:30:05.000Z' }),
    });
    expect(created.status).toBe(201);
    const { outputDir } = (await created.json()) as { outputDir: string };
    expect(path.basename(outputDir)).toBe('テスト_動画_1_20260908-103005-ab12');
    // 録音やノートが入るので、本人だけが読める
    expect((await stat(outputDir)).mode & 0o777).toBe(0o700);

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
    expect((await put('slides%2F..%2F..%2Fslide_001.png', 'x')).status).toBe(400);
    // 壊れた %xx は 500 ではなく 400
    expect((await put('%E0%A4%A', 'x')).status).toBe(400);

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
    expect(lecture).toContain('# テスト 動画/1');
    expect(lecture).toContain('![slide_001](../slides/slide_001.png)');
    expect(lecture).toContain('次の区間');
    // ノート（codex スタブ）
    expect(status.result).toMatchObject({ notes: true });
    const notes = await readFile(path.join(outputDir, 'notes.md'), 'utf8');
    expect(notes).toContain('# テスト 動画/1\n');
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
    await mkdir(path.join(dir, '.lecscribe'), { recursive: true });
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
    await mkdir(path.join(dir, 'slides'), { recursive: true });
    await writeFile(path.join(dir, 'audio.webm'), 'x');
    await writeFile(path.join(dir, 'timeline.json'), '[]');
    await writeFile(path.join(dir, 'lecture.md'), '# old');
    await writeFile(path.join(dir, 'slides', 'slide_001.png'), 'png');
    await fetch(`${base}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, title: 'old' }) });
    const top = (await readdir(dir)).sort();
    expect(top).toEqual(['.lecscribe', 'slides']);
    expect((await readdir(path.join(dir, '.lecscribe'))).sort()).toEqual(['audio.webm', 'lecture.md', 'session.json', 'timeline.json']);
  });

  it('ノートを整えられなくても段階は done で、status の result に notes: false と理由が載る（拡張が一覧に注意書きを出す）', async () => {
    // Codex の利用上限に当たったときの形: codex が失敗して終わる
    const failing = await writeStub('codex-limit', 'echo "You have hit your usage limit. Try again later." >&2; exit 1');
    const { server: limited } = createApp({ ...config, codexBin: failing, outDir: path.join(tmp, 'out-limit') }, TOKEN);
    await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
    const limitedBase = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
    try {
      const sessionId = '20260920-120000-lim1';
      await fetch(`${limitedBase}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, title: 'limit' }) });
      await fetch(`${limitedBase}/sessions/${sessionId}/files/audio.webm`, { method: 'PUT', headers, body: 'x' });
      await fetch(`${limitedBase}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
      let status: { stage: string; outputDir?: string; result?: { notes?: boolean; notesError?: string } } = { stage: 'queued' };
      for (let i = 0; i < 100 && status.stage !== 'done' && status.stage !== 'error'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        status = (await (await fetch(`${limitedBase}/sessions/${sessionId}/status`, { headers })).json()) as typeof status;
      }
      expect(status.stage).toBe('done');
      expect(status.result?.notes).toBe(false);
      expect(status.result?.notesError).toContain('usage limit');
      // notes.md には文字起こしがそのまま入る
      expect(await readFile(path.join(status.outputDir!, 'notes.md'), 'utf8')).toContain('最初の区間');
    } finally {
      await new Promise<void>((resolve) => limited.close(() => resolve()));
    }
  });

  it('校正モデルを設定すると誤変換が直って notes.md に入り、直しがキャッシュに残り、2 回目は使い回す', async () => {
    const { server } = createApp({ ...config, llmCheckModel: 'check-model', outDir: path.join(tmp, 'out-check') }, TOKEN);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const checkBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const sessionId = '20260920-150000-chk1';
      const wait = async () => {
        let status: { stage: string; outputDir?: string; result?: { notes?: boolean; notesError?: string; notesReused?: boolean } } = { stage: 'queued' };
        for (let i = 0; i < 100 && status.stage !== 'done' && status.stage !== 'error'; i++) {
          await new Promise((r) => setTimeout(r, 100));
          status = (await (await fetch(`${checkBase}/sessions/${sessionId}/status`, { headers })).json()) as typeof status;
        }
        return status;
      };
      await fetch(`${checkBase}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, title: 'check' }) });
      await fetch(`${checkBase}/sessions/${sessionId}/files/audio.webm`, { method: 'PUT', headers, body: 'x' });
      await fetch(`${checkBase}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
      const status = await wait();
      expect(status.stage).toBe('done');
      expect(status.result).toMatchObject({ notes: true });
      expect(status.result?.notesError).toBeUndefined();
      // スタブの校正は最初の節の「整えた」→「校正済みの」を返す。notes.md に反映され、キャッシュに記録される
      expect(await readFile(path.join(status.outputDir!, 'notes.md'), 'utf8')).toContain('の校正済みの本文。');
      const cache = JSON.parse(await readFile(path.join(status.outputDir!, '.lecscribe', 'notes-cache.json'), 'utf8')) as {
        settings?: { checkModel?: string };
        corrections?: Array<{ wrong: string; right: string }>;
        errors?: string[];
      };
      expect(cache.settings?.checkModel).toBe('check-model');
      expect(cache.corrections).toEqual([expect.objectContaining({ wrong: '整えた', right: '校正済みの' })]);
      // 同じ入力でもう一度 finalize すると、校正込みの鍵のまま使い回す
      await fetch(`${checkBase}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
      const again = await wait();
      expect(again.result).toMatchObject({ notes: true, notesReused: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('校正が一時的に失敗しても notesError にならず（partial 表示が出ない）、キャッシュは使い回せる', async () => {
    const { server } = createApp({ ...config, llmCheckModel: 'check-fail', outDir: path.join(tmp, 'out-check-fail') }, TOKEN);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const checkBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const sessionId = '20260920-151000-chk2';
      const wait = async () => {
        let status: { stage: string; outputDir?: string; result?: { notes?: boolean; notesError?: string; notesReused?: boolean } } = { stage: 'queued' };
        for (let i = 0; i < 100 && status.stage !== 'done' && status.stage !== 'error'; i++) {
          await new Promise((r) => setTimeout(r, 100));
          status = (await (await fetch(`${checkBase}/sessions/${sessionId}/status`, { headers })).json()) as typeof status;
        }
        return status;
      };
      await fetch(`${checkBase}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, title: 'check fail' }) });
      await fetch(`${checkBase}/sessions/${sessionId}/files/audio.webm`, { method: 'PUT', headers, body: 'x' });
      await fetch(`${checkBase}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
      const status = await wait();
      expect(status.stage).toBe('done');
      // 本文は揃っている（未校正なだけ）ので、完成扱いで notesError は付かない
      expect(status.result).toMatchObject({ notes: true });
      expect(status.result?.notesError).toBeUndefined();
      expect(await readFile(path.join(status.outputDir!, 'notes.md'), 'utf8')).toContain('の整えた本文。');
      const cache = JSON.parse(await readFile(path.join(status.outputDir!, '.lecscribe', 'notes-cache.json'), 'utf8')) as { errors?: string[]; checkErrors?: string[] };
      expect(cache.errors).toBeUndefined();
      expect(cache.checkErrors?.join(' ')).toContain('rate limited');
      // 校正だけの失敗はキャッシュの使い回しを妨げない
      await fetch(`${checkBase}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
      const again = await wait();
      expect(again.result).toMatchObject({ notes: true, notesReused: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('設定 API でノート作成のモデルを変えると、再起動なしで次の処理から効き、保存されて overridden になる', async () => {
    const settingsFile = path.join(tmp, 'settings-api.json');
    const { server } = createApp({ ...config, settingsFile, outDir: path.join(tmp, 'out-settings') }, TOKEN);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const b = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const health = (await (await fetch(`${b}/health`, { headers })).json()) as { api: number; llmModel?: string; llmCheckModel?: string };
      expect(health.api).toBeGreaterThanOrEqual(5);
      expect(health.llmModel).toBe('');
      const got = (await (await fetch(`${b}/settings`, { headers })).json()) as { ok: boolean; overridden: boolean };
      expect(got).toMatchObject({ ok: true, overridden: false });
      // 認証なしは 401、不正なモデル名は 400
      expect((await fetch(`${b}/settings`)).status).toBe(401);
      const bad = await fetch(`${b}/settings`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ llmModel: 'a b' }) });
      expect(bad.status).toBe(400);
      // 校正モデルを入れて保存 → 次の finalize から校正が効く（サーバーは再起動していない）
      const set = await fetch(`${b}/settings`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ llmCheckModel: 'check-model' }) });
      expect((await set.json() as { overridden: boolean }).overridden).toBe(true);
      expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({ llmCheckModel: 'check-model' });
      const sessionId = '20260920-160000-set1';
      await fetch(`${b}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, title: 'settings' }) });
      await fetch(`${b}/sessions/${sessionId}/files/audio.webm`, { method: 'PUT', headers, body: 'x' });
      await fetch(`${b}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
      let status: { stage: string; outputDir?: string } = { stage: 'queued' };
      for (let i = 0; i < 100 && status.stage !== 'done' && status.stage !== 'error'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        status = (await (await fetch(`${b}/sessions/${sessionId}/status`, { headers })).json()) as typeof status;
      }
      expect(status.stage).toBe('done');
      expect(await readFile(path.join(status.outputDir!, 'notes.md'), 'utf8')).toContain('の校正済みの本文。');
      // reset で起動時の設定（校正なし）に戻る
      const reset = await fetch(`${b}/settings`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ reset: true }) });
      expect((await reset.json() as { overridden: boolean; llmCheckModel: string }).llmCheckModel).toBe('');
      expect(await readFile(settingsFile, 'utf8').catch(() => 'gone')).toBe('gone');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('整えのモデルが使えないときは、指定なし（既定のモデル）でやり直してノートを作る', async () => {
    const logs: string[] = [];
    const { server } = createApp({ ...config, llmModel: 'model-gone', outDir: path.join(tmp, 'out-polish-gone') }, TOKEN, (m) => logs.push(m));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const b = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const sessionId = '20260920-161000-gone';
      await fetch(`${b}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, title: 'gone' }) });
      await fetch(`${b}/sessions/${sessionId}/files/audio.webm`, { method: 'PUT', headers, body: 'x' });
      await fetch(`${b}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
      let status: { stage: string; outputDir?: string; result?: { notes?: boolean; notesError?: string } } = { stage: 'queued' };
      for (let i = 0; i < 100 && status.stage !== 'done' && status.stage !== 'error'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        status = (await (await fetch(`${b}/sessions/${sessionId}/status`, { headers })).json()) as typeof status;
      }
      expect(status.stage).toBe('done');
      // 文字起こしのままに落ちず、既定のモデルで整っている
      expect(status.result).toMatchObject({ notes: true });
      expect(status.result?.notesError).toBeUndefined();
      expect(await readFile(path.join(status.outputDir!, 'notes.md'), 'utf8')).toContain('の整えた本文。');
      expect(logs.join('\n')).toContain('整えのモデル（codex (model-gone)）が使えないようです');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('整えと校正が同じ使えないモデル（高品質・節約の形）でも、両方とも既定のモデルに切り替わって校正まで動く', async () => {
    const logs: string[] = [];
    const { server } = createApp({ ...config, llmModel: 'model-gone', llmCheckModel: 'model-gone', outDir: path.join(tmp, 'out-both-gone') }, TOKEN, (m) => logs.push(m));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const b = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const sessionId = '20260920-162000-gne2';
      await fetch(`${b}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, title: 'both gone' }) });
      await fetch(`${b}/sessions/${sessionId}/files/audio.webm`, { method: 'PUT', headers, body: 'x' });
      await fetch(`${b}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
      let status: { stage: string; outputDir?: string; result?: { notes?: boolean; notesError?: string } } = { stage: 'queued' };
      for (let i = 0; i < 100 && status.stage !== 'done' && status.stage !== 'error'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        status = (await (await fetch(`${b}/sessions/${sessionId}/status`, { headers })).json()) as typeof status;
      }
      expect(status.stage).toBe('done');
      expect(status.result).toMatchObject({ notes: true });
      // 整えは既定のモデルに切り替わり、校正の受け皿も「切り替わった先」を使うので校正まで入る
      expect(logs.join('\n')).toContain('整えのモデル（codex (model-gone)）が使えないようです');
      expect(await readFile(path.join(status.outputDir!, 'notes.md'), 'utf8')).toContain('の校正済みの本文。');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe('中止（§11.3）', () => {
    /** 設定を変えた別サーバーを立てる。同じ outDir を渡せば「やり直す」を再現できる */
    const startApp = async (overrides: Partial<ServerConfig>) => {
      const { server: s } = createApp({ ...config, ...overrides }, TOKEN);
      await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
      return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => s.close(() => resolve())) };
    };
    const json = { ...headers, 'content-type': 'application/json' };
    /** セッションを作って（あれば同じフォルダに）音声を置き、処理を始める */
    const begin = async (base: string, sessionId: string) => {
      await fetch(`${base}/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ sessionId, title: 'cancel' }) });
      await fetch(`${base}/sessions/${sessionId}/files/audio.webm`, { method: 'PUT', headers, body: 'x' });
      await fetch(`${base}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
    };
    const waitStage = async (base: string, sessionId: string, stage: string) => {
      for (let i = 0; i < 200; i++) {
        const s = (await (await fetch(`${base}/sessions/${sessionId}/status`, { headers })).json()) as PipelineStatus;
        if (s.stage === stage) return s;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`stage ${stage} に入らなかった`);
    };
    const cancel = async (base: string, sessionId: string, body: object = {}) =>
      (await (await fetch(`${base}/sessions/${sessionId}/cancel`, { method: 'POST', headers: json, body: JSON.stringify(body) })).json()) as Record<string, unknown>;
    const exists = (file: string) => stat(file).then(() => true, () => false);

    it('初回の処理をノート作成の途中で中止したら cancelled。この回で作った文字起こしの記録は残る', async () => {
      const slowCodex = await writeStub('codex-slow', 'sleep 30');
      const app = await startApp({ codexBin: slowCodex, outDir: path.join(tmp, 'out-cancel-first') });
      try {
        const sessionId = '20260920-140000-canp';
        await begin(app.base, sessionId);
        const { outputDir } = await waitStage(app.base, sessionId, 'polishing');
        await cancel(app.base, sessionId);
        const after = await readPipelineStatus(outputDir);
        expect(after?.stage).toBe('cancelled');
        // ここが落ちると、次に送り直したとき 90 分の音声を丸ごと文字起こしし直すことになる
        expect(after?.transcript).toMatchObject({ model: 'stub' });
      } finally {
        await app.close();
      }
    });

    it('「やり直す」をノート作成の途中で中止したら、やり直す前の状態（完了・結果・ノート）に丸ごと戻る', async () => {
      const outDir = path.join(tmp, 'out-cancel-redo');
      const sessionId = '20260920-141000-redo';
      const first = await startApp({ outDir });
      let dir = '';
      let before: PipelineStatus | null = null;
      try {
        await begin(first.base, sessionId);
        dir = (await waitStage(first.base, sessionId, 'done')).outputDir;
        before = await readPipelineStatus(dir);
        expect(before?.result).toMatchObject({ notes: true });
      } finally {
        await first.close();
      }
      const notesBefore = await readFile(path.join(dir, 'notes.md'), 'utf8');
      // モデルを変えて、前回のノートを使い回せないようにする（使い回せると codex を呼ばずに終わる）
      const slowCodex = await writeStub('codex-slow-redo', 'sleep 30');
      const redo = await startApp({ outDir, codexBin: slowCodex, llmModel: 'another-model' });
      try {
        await begin(redo.base, sessionId);
        await waitStage(redo.base, sessionId, 'polishing');
        expect(await exists(path.join(dir, '.lecscribe', 'pipeline.previous.json'))).toBe(true);
        await cancel(redo.base, sessionId);
        const after = await readPipelineStatus(dir);
        expect(after).toEqual(before); // 段階は done のまま、結果も文字起こしの記録もそのまま
        expect(await readFile(path.join(dir, 'notes.md'), 'utf8')).toBe(notesBefore);
        expect(await exists(path.join(dir, '.lecscribe', 'pipeline.previous.json'))).toBe(false);
      } finally {
        await redo.close();
      }
    });

    it('「やり直す」を whisperkit の途中で中止したら、状態は戻すが文字起こしの記録は落とす（report を書き換えている途中のため）', async () => {
      const outDir = path.join(tmp, 'out-cancel-whisper');
      const sessionId = '20260920-142000-whsp';
      const first = await startApp({ outDir });
      let dir = '';
      try {
        await begin(first.base, sessionId);
        dir = (await waitStage(first.base, sessionId, 'done')).outputDir;
        expect((await readPipelineStatus(dir))?.transcript).toMatchObject({ model: 'stub' });
      } finally {
        await first.close();
      }
      // モデルを変えると whisperkit からやり直しになる
      const slowWhisper = await writeStub('whisperkit-slow-redo', 'sleep 30');
      const redo = await startApp({ outDir, whisperkitBin: slowWhisper, model: 'another-whisper' });
      try {
        await begin(redo.base, sessionId);
        await waitStage(redo.base, sessionId, 'transcribing');
        await cancel(redo.base, sessionId);
        const after = await readPipelineStatus(dir);
        expect(after?.stage).toBe('done');
        expect(after?.result).toMatchObject({ notes: true });
        expect(after?.transcript).toBeUndefined();
      } finally {
        await redo.close();
      }
    });

    it('初回の処理でノート作成中に finish を送ると、LLM だけ止めて、文字起こしのままのノートで完了にする', async () => {
      const slowCodex = await writeStub('codex-slow-finish', 'sleep 30');
      const app = await startApp({ codexBin: slowCodex, outDir: path.join(tmp, 'out-finish') });
      try {
        const sessionId = '20260920-143000-fini';
        await begin(app.base, sessionId);
        const { outputDir } = await waitStage(app.base, sessionId, 'polishing');
        const started = Date.now();
        expect(await cancel(app.base, sessionId, { finish: true })).toMatchObject({ ok: true, finished: true, cancelled: false, deleted: false });
        expect(Date.now() - started).toBeLessThan(5000); // sleep 30 を待たずに終わる
        const after = await readPipelineStatus(outputDir);
        expect(after?.stage).toBe('done');
        expect(after?.result).toMatchObject({ notes: false, notesCancelled: true, notesError: 'ノート作成を中止しました' });
        expect(after?.transcript).toMatchObject({ model: 'stub' });
        expect(await readFile(path.join(outputDir, 'notes.md'), 'utf8')).toContain('最初の区間');
      } finally {
        await app.close();
      }
    });

    it('ノート作成中でなければ finish は何もしない（処理は続く）', async () => {
      const slowWhisper = await writeStub('whisperkit-slow-finish', 'sleep 30');
      const app = await startApp({ whisperkitBin: slowWhisper, outDir: path.join(tmp, 'out-finish-early') });
      try {
        const sessionId = '20260920-144000-erly';
        await begin(app.base, sessionId);
        await waitStage(app.base, sessionId, 'transcribing');
        expect(await cancel(app.base, sessionId, { finish: true })).toMatchObject({ ok: true, finished: false });
        expect(((await (await fetch(`${app.base}/sessions/${sessionId}/status`, { headers })).json()) as PipelineStatus).stage).toBe('transcribing');
        await cancel(app.base, sessionId, { delete: true }); // 片付け（sleep 30 を待たない）
      } finally {
        await app.close();
      }
    });
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
    // Return で押される既定のボタンは「許可しない」。初めての拡張には「接続済み」の一文を付けない
    const firstArgs = await readFile(path.join(tmp, 'pair-args.txt'), 'utf8');
    expect(firstArgs).toContain('default button "許可しない"');
    expect(firstArgs).not.toContain('接続済みです');
    const status = (auth: Record<string, string>) => fetch(`${base}/sessions/20260908-103005-ab12/status`, { headers: auth }).then((r) => r.status);
    const pairArgs = () => readFile(path.join(tmp, 'pair-args.txt'), 'utf8');
    await writeFile(path.join(tmp, 'pair-args.txt'), '');

    // 押し直し: 自分のトークンを添えてくる拡張には、ダイアログを出さずに同じトークンを返す
    await writeFile(path.join(tmp, 'pair-answer.txt'), 'denied\n');
    expect(await (await fetch(`${base}/pair`, { method: 'POST', headers: { ...noToken, ...withIssued } })).json()).toMatchObject({ paired: true, already: true, token: issued.token });
    expect(await pairArgs()).toBe('');

    // 承認済みの ID を名乗っても（curl なら Origin は偽れる）、トークンを添えなければダイアログを出す。
    // 「許可しない」なら 403 で、何も渡さず、今のトークンはそのまま使える
    const spoofed = await fetch(`${base}/pair`, { method: 'POST', headers: noToken });
    expect(spoofed.status).toBe(403);
    expect(JSON.stringify(await spoofed.json())).not.toContain(issued.token);
    expect(await pairArgs()).toContain('この ID の拡張はすでに接続済みです');
    expect(await status(withIssued)).toBe(200);

    // 「許可」なら、その要求専用のトークンを足す（別の Chrome プロファイルなど）。今のトークンも使え続ける
    await writeFile(path.join(tmp, 'pair-answer.txt'), 'allowed\n');
    const second = (await (await fetch(`${base}/pair`, { method: 'POST', headers: noToken })).json()) as { paired: boolean; token: string };
    expect(second.paired).toBe(true);
    expect(second.token).not.toBe(issued.token);
    const withSecond = { authorization: `Bearer ${second.token}` };
    expect(await status(withIssued)).toBe(200);
    expect(await status(withSecond)).toBe(200);

    // 別の ID が「LecScribe」を名乗ってきたら、すでに接続済みの拡張があることをダイアログに書く
    await writeFile(path.join(tmp, 'pair-answer.txt'), 'denied\n');
    const otherId = `chrome-extension://${'b'.repeat(32)}`;
    expect((await fetch(`${base}/pair`, { method: 'POST', headers: { origin: otherId, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'LecScribe' }) })).status).toBe(403);
    const otherArgs = await pairArgs();
    expect(otherArgs).toContain('この Mac ではすでに別の拡張が接続済みです');
    expect(otherArgs).toContain(ORIGIN.slice('chrome-extension://'.length));

    // 接続を解除: 送ってきたトークンの承認だけを消す。ほかの承認と共有トークンは残る
    expect((await fetch(`${base}/unpair`, { method: 'POST', headers: noToken })).status).toBe(401);
    expect(await (await fetch(`${base}/unpair`, { method: 'POST', headers: { ...noToken, ...withSecond } })).json()).toMatchObject({ ok: true, removed: true });
    expect(await status(withSecond)).toBe(401);
    expect(await status(withIssued)).toBe(200);
    expect(await (await fetch(`${base}/unpair`, { method: 'POST', headers })).json()).toMatchObject({ ok: true, removed: false });
    expect(await status(headers)).toBe(200);
    const left = JSON.parse(await readFile(path.join(tmp, 'trusted.json'), 'utf8')) as { extensions: Array<{ token: string }> };
    expect(left.extensions.map((e) => e.token)).toEqual([issued.token]);
  });

  it('/health が拡張との約束の版（api）とコミットを返す', async () => {
    const body = (await (await fetch(`${base}/health`, { headers })).json()) as { api?: unknown; commit?: unknown };
    expect(typeof body.api).toBe('number');
    expect(body.api as number).toBeGreaterThanOrEqual(1);
    // テストでは createApp に commit を渡していないので null
    expect(body.commit).toBeNull();
  });

  it('keeps a finished session folder when a cancel asks to delete it', async () => {
    // 処理済み（notes.md あり）のセッションに対する cancel+delete は、フォルダを消さない
    const sessionId = '20260908-103005-ab12';
    const dir = path.join(config.outDir, `テスト_動画_1_${sessionId}`);
    expect(await readdir(dir)).toContain('notes.md');
    const res = await fetch(`${base}/sessions/${sessionId}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ delete: true }),
    });
    expect(await res.json()).toMatchObject({ ok: true, cancelled: false, deleted: false });
    expect(await readdir(dir)).toContain('notes.md');
  });

  it('deletes a finished session folder when the cancel says force（一覧の「削除」）', async () => {
    // 他のテストと共有しないよう、このテスト専用のセッションを作る
    const sessionId = '20260908-110000-zz99';
    await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, title: '削除テスト' }),
    });
    const dir = path.join(config.outDir, `削除テスト_${sessionId}`);
    await writeFile(path.join(dir, 'notes.md'), '# 完成したノート\n');
    expect(await readdir(dir)).toContain('notes.md');
    const res = await fetch(`${base}/sessions/${sessionId}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ delete: true, force: true }),
    });
    expect(await res.json()).toMatchObject({ ok: true, cancelled: false, deleted: true });
    await expect(readdir(dir)).rejects.toThrow();
    // 消したあとは status が 404（拡張はこれで「データなし」を出す）
    expect((await fetch(`${base}/sessions/${sessionId}/status`, { headers })).status).toBe(404);
  });

  it('rejects requests whose Host is not loopback', async () => {
    // fetch は Host ヘッダーを上書きできないので http.request で送る
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${base}/health`, { headers: { host: 'attacker.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('refuses finalize before the audio arrived', async () => {
    const sessionId = '20260908-110000-zzzz';
    await fetch(`${base}/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    const res = await fetch(`${base}/sessions/${sessionId}/finalize`, { method: 'POST', headers });
    expect(res.status).toBe(409);
  });
});
