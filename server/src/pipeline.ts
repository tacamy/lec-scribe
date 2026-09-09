import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from './config.ts';
import { run } from './exec.ts';
import { toSrt, toTxt, toVtt, type Segment } from './format.ts';
import { NOTES_FILE, migrateLayout, workPath } from './layout.ts';
import { createBackend, outline, polish } from './llm.ts';
import { assignSlides, buildLectureMarkdown, buildNotesMarkdown, groupSections, isSlideList, type MergedSegment } from './merge.ts';
import { isTimeline, toVideoTime } from './timeline.ts';
import { normalizeReport, whisperkitArgs } from './whisperkit.ts';

/** pipeline.json の内容。拡張が GET /sessions/:id/status で読む */
export type PipelineStatus = {
  stage: 'uploaded' | 'queued' | 'converting' | 'transcribing' | 'merging' | 'polishing' | 'done' | 'error' | 'cancelled';
  outputDir: string;
  startedAt?: string;
  updatedAt: string;
  error?: string;
  /** 完了時の要約 */
  result?: {
    segments: number;
    durationSec: number;
    hasTimeline: boolean;
    slides: number;
    /** notes.md を作れたか。ノート作成が無効なら undefined */
    notes?: boolean;
    notesError?: string;
  };
  /** 各段階にかかった秒 */
  timings?: Partial<Record<'converting' | 'transcribing' | 'merging' | 'polishing', number>>;
  /** 文字起こしに使った条件。同じ音声・同じモデルなら次回は whisperkit を飛ばして report を再利用する */
  transcript?: { model: string; audioBytes: number; reused?: boolean };
};

/** 処理の途中で止まったままの段階（サーバーが落ちたときに残る） */
const IN_PROGRESS: ReadonlySet<PipelineStatus['stage']> = new Set(['queued', 'converting', 'transcribing', 'merging', 'polishing']);

/**
 * サーバー起動時に、前回の実行で途中のまま残った pipeline.json を error にする。
 * そのままだと拡張が永遠に「処理中」を見続けるため。文字起こし済みなら「やり直す」で続きから作れる
 */
export async function recoverInterrupted(outDir: string, log: (message: string) => void = () => undefined): Promise<string[]> {
  const recovered: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch {
    return recovered;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(outDir, entry.name);
    const status = await readPipelineStatus(dir);
    if (!status || !IN_PROGRESS.has(status.stage)) continue;
    await writeStatus(dir, {
      ...status,
      stage: 'error',
      updatedAt: new Date().toISOString(),
      error: `サーバーが再起動したため「${status.stage}」の途中で中断されました。一覧の「やり直す」で続きから作れます。`,
    });
    log(`recovered interrupted session (${status.stage}): ${dir}`);
    recovered.push(dir);
  }
  return recovered;
}

export const PIPELINE_FILE = 'pipeline.json';

export async function readPipelineStatus(dir: string): Promise<PipelineStatus | null> {
  for (const file of [workPath(dir, PIPELINE_FILE), path.join(dir, PIPELINE_FILE)]) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as PipelineStatus;
    } catch {
      // 旧配置も見る
    }
  }
  return null;
}

export async function writeStatus(dir: string, status: PipelineStatus): Promise<PipelineStatus> {
  await mkdir(workPath(dir), { recursive: true });
  await writeFile(workPath(dir, PIPELINE_FILE), JSON.stringify(status, null, 2));
  return status;
}

/**
 * audio.webm → audio.wav → whisperkit-cli → transcript.json / .txt / .srt / .vtt（SPEC §12.4）。
 * 同時に 1 件だけ動かす。
 */
export class Pipeline {
  private queue: Promise<unknown> = Promise.resolve();
  /** 待機中・実行中のセッション。cancel() で中断できる */
  private readonly jobs = new Map<string, { controller: AbortController; task: Promise<PipelineStatus>; started: boolean }>();
  private readonly config: ServerConfig;
  private readonly log: (message: string) => void;

  constructor(config: ServerConfig, log: (message: string) => void = () => undefined) {
    this.config = config;
    this.log = log;
  }

  isRunning(dir: string): boolean {
    return this.jobs.has(dir);
  }

  /** 待機中・実行中の件数 */
  activeCount(): number {
    return this.jobs.size;
  }

  /** キューに積んで即座に戻る。結果は pipeline.json に書かれる */
  enqueue(dir: string): Promise<PipelineStatus> {
    const controller = new AbortController();
    const job: { controller: AbortController; task: Promise<PipelineStatus>; started: boolean } = {
      controller,
      task: Promise.resolve({ stage: 'queued', outputDir: dir, updatedAt: '' }),
      started: false,
    };
    job.task = this.queue
      .then(() => {
        if (controller.signal.aborted) return this.writeCancelled(dir);
        job.started = true;
        return this.process(dir, controller.signal);
      })
      .finally(() => this.jobs.delete(dir));
    this.jobs.set(dir, job);
    this.queue = job.task.catch(() => undefined);
    return job.task;
  }

  /**
   * 待機中なら取り下げ、実行中なら子プロセス（ffmpeg / whisperkit / codex）を止める。
   * 待機中の分は前の処理が終わるのを待たずに戻る（順番が来たときに cancelled が書かれる）
   */
  async cancel(dir: string): Promise<boolean> {
    const job = this.jobs.get(dir);
    if (!job) return false;
    job.controller.abort();
    if (job.started) await job.task.catch(() => undefined);
    return true;
  }

  /** audio.webm → wav → whisperkit-cli。report の区間を返す */
  private async transcribe(
    dir: string,
    audioWebm: string,
    audioWav: string,
    reportDir: string,
    step: <T>(stage: PipelineStatus['stage'], work: () => Promise<T>) => Promise<T>,
    signal: AbortSignal,
  ): Promise<ReturnType<typeof normalizeReport>> {
      await step('converting', async () => {
        this.log(`ffmpeg: ${audioWebm} → wav 16kHz mono`);
        const r = await run(this.config.ffmpegBin, [
          '-y',
          '-loglevel',
          'error',
          '-i',
          audioWebm,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          audioWav,
        ], { signal });
        if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.trim().split('\n').slice(-5).join(' / ')}`);
      });

      return step('transcribing', async () => {
        await rm(reportDir, { recursive: true, force: true });
        await mkdir(reportDir, { recursive: true });
        const args = whisperkitArgs({ audioPath: audioWav, model: this.config.model, language: this.config.language, reportDir });
        this.log(`${this.config.whisperkitBin} ${args.join(' ')}`);
        const r = await run(this.config.whisperkitBin, args, { cwd: dir, signal, onLine: (line) => this.log(`  ${line}`) });
        if (r.code !== 0) {
          throw new Error(`whisperkit-cli failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join(' / ')}`);
        }
        const report = await findReport(reportDir);
        if (!report) throw new Error(`whisperkit-cli produced no JSON report in ${reportDir}`);
        const parsed = normalizeReport(JSON.parse(await readFile(report, 'utf8')));
        if (parsed.length === 0) throw new Error(`no segments in ${report}`);
        return parsed;
      });
  }

  private async writeCancelled(dir: string): Promise<PipelineStatus> {
    this.log(`cancelled: ${dir}`);
    const status: PipelineStatus = { stage: 'cancelled', outputDir: dir, updatedAt: new Date().toISOString() };
    // 中止と同時に削除されたフォルダを作り直さない
    const exists = await stat(dir).then(() => true).catch(() => false);
    if (!exists) return status;
    return writeStatus(dir, status).catch(() => status);
  }

  private async process(dir: string, signal: AbortSignal): Promise<PipelineStatus> {
    const now = () => new Date().toISOString();
    // 前回の文字起こしの条件は、最初の書き込みで消す前に読んでおく
    const previous = await readPipelineStatus(dir);
    let status: PipelineStatus = { stage: 'converting', outputDir: dir, startedAt: now(), updatedAt: now(), timings: {}, transcript: previous?.transcript };
    await writeStatus(dir, status);
    const step = async <T>(stage: PipelineStatus['stage'], work: () => Promise<T>): Promise<T> => {
      if (signal.aborted) throw new Error('cancelled');
      status = await writeStatus(dir, { ...status, stage, updatedAt: now() });
      const started = Date.now();
      const result = await work();
      if (signal.aborted) throw new Error('cancelled');
      status.timings = { ...status.timings, [stage]: Math.round((Date.now() - started) / 100) / 10 };
      return result;
    };

    try {
      await migrateLayout(dir);
      const audioWebm = workPath(dir, 'audio.webm');
      const audioWav = workPath(dir, 'audio.wav');
      const reportDir = workPath(dir, 'whisperkit');

      // 同じ音声を同じモデルで文字起こし済みなら whisperkit を飛ばす（「やり直す」でノートだけ作り直すとき）
      // 記録（status.transcript）は文字起こしが成功してから付ける。先に付けると ffmpeg で失敗した回の
      // 記録が残り、次回に存在しない report を再利用しようとして永遠に失敗する
      const audioBytes = (await stat(audioWebm)).size;
      const previousReport =
        previous?.transcript && previous.transcript.model === this.config.model && previous.transcript.audioBytes === audioBytes
          ? await findReport(reportDir)
          : null;
      status.transcript = undefined;

      const segments = previousReport
        ? await (async () => {
            this.log(`transcript を再利用: ${previousReport}`);
            const parsed = normalizeReport(JSON.parse(await readFile(previousReport, 'utf8')));
            if (parsed.length === 0) throw new Error(`no segments in ${previousReport}`);
            return parsed;
          })()
        : await this.transcribe(dir, audioWebm, audioWav, reportDir, step, signal);
      status.transcript = { model: this.config.model, audioBytes, ...(previousReport ? { reused: true } : {}) };

      const result = await step('merging', async () => {
        const timeline = await readJson(workPath(dir, 'timeline.json'));
        const events = isTimeline(timeline) ? timeline : null;
        const slidesJson = await readJson(workPath(dir, 'slides.json'));
        const slides = isSlideList(slidesJson) ? slidesJson : [];
        const session = (await readJson(workPath(dir, 'session.json'))) as
          | { title?: string; url?: string; startedAt?: string }
          | undefined;
        const mapped: MergedSegment[] = assignSlides(
          segments.map((s) => ({
            ...s,
            videoStart: events ? toVideoTime(events, s.start) : s.start,
            videoEnd: events ? toVideoTime(events, s.end) : s.end,
          })),
          slides,
        );
        const forSubtitles: Segment[] = mapped.map((s) => ({ start: s.videoStart, end: s.videoEnd, text: s.text }));
        await writeFile(
          workPath(dir, 'transcript.json'),
          JSON.stringify(
            {
              language: this.config.language,
              model: this.config.model,
              generatedAt: now(),
              timeBase: { start: 'recording seconds', videoStart: events ? 'video seconds (via timeline.json)' : 'same as start' },
              segments: mapped,
            },
            null,
            2,
          ),
        );
        await writeFile(workPath(dir, 'transcript.srt'), toSrt(forSubtitles));
        await writeFile(workPath(dir, 'transcript.vtt'), toVtt(forSubtitles));
        await writeFile(workPath(dir, 'transcript.txt'), toTxt(forSubtitles));
        // ノート（SPEC §13.4）: スライドごとに画像とその間の発話。作業フォルダに置く
        const lectureInput = { title: session?.title, url: session?.url, startedAt: session?.startedAt, segments: mapped, slides };
        await writeFile(workPath(dir, 'lecture.md'), buildLectureMarkdown({ ...lectureInput, imagePrefix: '../slides/' }));
        // ユーザー向けの notes.md はまず文字起こしそのままで置き、LLM が使えれば整えた版で上書きする
        await writeFile(
          path.join(dir, NOTES_FILE),
          buildLectureMarkdown({
            ...lectureInput,
            note: this.config.llm === 'none' ? '文字起こしそのままの本文。サーバーを --llm 付きで動かすと、整えた本文と要点になる' : undefined,
          }),
        );
        if (!this.config.keepWav) await rm(audioWav, { force: true });
        return {
          summary: {
            segments: mapped.length,
            durationSec: Math.round(mapped[mapped.length - 1]!.end),
            hasTimeline: events !== null,
            slides: slides.length,
          },
          sections: groupSections(mapped, slides),
          session,
        };
      });

      // ノート作成（任意）。失敗しても文字起こしまでは done にする
      let notes: { notes?: boolean; notesError?: string } = {};
      const llmSettings = {
        kind: this.config.llm,
        model: this.config.llmModel,
        codexBin: this.config.codexBin,
        openaiApiKey: this.config.openaiApiKey,
        ollamaUrl: this.config.ollamaUrl,
        charsPerCall: this.config.llmCharsPerCall,
        signal,
      };
      const backend = createBackend(llmSettings);
      if (backend) {
        notes = await step('polishing', async () => {
          const inputs = result.sections.map((s) => ({ id: s.id, heading: s.heading, text: s.texts.join('') }));
          const { results: polished, errors } = await polish(inputs, backend, llmSettings, this.log);
          if (signal.aborted) throw new Error('cancelled');
          if (polished.size === 0) return { notes: false, notesError: errors.join(' / ') || 'no output' };
          // 整えた本文全体（整えられなかった節は文字起こしのまま）から全体の要点と話題の区切りを作る
          const outlineInput = inputs.map((s) => ({ id: s.id, text: polished.get(s.id)?.text ?? s.text }));
          const { outline: topics, error: outlineError } = await outline(outlineInput, backend, llmSettings, this.log);
          if (signal.aborted) throw new Error('cancelled');
          if (outlineError) errors.push(outlineError);
          await writeFile(
            path.join(dir, NOTES_FILE),
            buildNotesMarkdown({
              title: result.session?.title,
              url: result.session?.url,
              startedAt: result.session?.startedAt,
              sections: result.sections,
              polished,
              outline: topics,
            }),
          );
          return errors.length > 0 ? { notes: true, notesError: errors.join(' / ') } : { notes: true };
        }).catch((e: unknown) => ({ notes: false, notesError: e instanceof Error ? e.message : String(e) }));
      }

      return writeStatus(dir, { ...status, stage: 'done', updatedAt: now(), result: { ...result.summary, ...notes } });
    } catch (e) {
      if (signal.aborted) return this.writeCancelled(dir);
      const message = e instanceof Error ? e.message : String(e);
      this.log(`pipeline error: ${message}`);
      return writeStatus(dir, { ...status, stage: 'error', updatedAt: now(), error: message });
    }
  }
}

async function findReport(reportDir: string): Promise<string | null> {
  const files = (await readdir(reportDir, { recursive: true }).catch(() => [] as string[])).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;
  files.sort();
  return path.join(reportDir, files[0]!);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}
