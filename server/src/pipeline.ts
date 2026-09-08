import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from './config.ts';
import { run } from './exec.ts';
import { toSrt, toTxt, toVtt, type Segment } from './format.ts';
import { NOTES_FILE, migrateLayout, workPath } from './layout.ts';
import { createBackend, polish } from './llm.ts';
import { assignSlides, buildLectureMarkdown, buildNotesMarkdown, groupSections, isSlideList, type MergedSegment } from './merge.ts';
import { isTimeline, toVideoTime } from './timeline.ts';
import { normalizeReport, whisperkitArgs } from './whisperkit.ts';

/** pipeline.json の内容。拡張が GET /sessions/:id/status で読む */
export type PipelineStatus = {
  stage: 'uploaded' | 'queued' | 'converting' | 'transcribing' | 'merging' | 'polishing' | 'done' | 'error';
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
};

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
  private readonly running = new Set<string>();
  private readonly config: ServerConfig;
  private readonly log: (message: string) => void;

  constructor(config: ServerConfig, log: (message: string) => void = () => undefined) {
    this.config = config;
    this.log = log;
  }

  isRunning(dir: string): boolean {
    return this.running.has(dir);
  }

  /** キューに積んで即座に戻る。結果は pipeline.json に書かれる */
  enqueue(dir: string): Promise<PipelineStatus> {
    this.running.add(dir);
    const task = this.queue.then(() => this.process(dir)).finally(() => this.running.delete(dir));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async process(dir: string): Promise<PipelineStatus> {
    const now = () => new Date().toISOString();
    let status: PipelineStatus = { stage: 'converting', outputDir: dir, startedAt: now(), updatedAt: now(), timings: {} };
    await writeStatus(dir, status);
    const step = async <T>(stage: PipelineStatus['stage'], work: () => Promise<T>): Promise<T> => {
      status = await writeStatus(dir, { ...status, stage, updatedAt: now() });
      const started = Date.now();
      const result = await work();
      status.timings = { ...status.timings, [stage]: Math.round((Date.now() - started) / 100) / 10 };
      return result;
    };

    try {
      await migrateLayout(dir);
      const audioWebm = workPath(dir, 'audio.webm');
      const audioWav = workPath(dir, 'audio.wav');

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
        ]);
        if (r.code !== 0) throw new Error(`ffmpeg failed (${r.code}): ${r.stderr.trim().split('\n').slice(-5).join(' / ')}`);
      });

      const reportDir = workPath(dir, 'whisperkit');
      const segments = await step('transcribing', async () => {
        await rm(reportDir, { recursive: true, force: true });
        await mkdir(reportDir, { recursive: true });
        const args = whisperkitArgs({ audioPath: audioWav, model: this.config.model, language: this.config.language, reportDir });
        this.log(`${this.config.whisperkitBin} ${args.join(' ')}`);
        const r = await run(this.config.whisperkitBin, args, { cwd: dir, onLine: (line) => this.log(`  ${line}`) });
        if (r.code !== 0) {
          throw new Error(`whisperkit-cli failed (${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-5).join(' / ')}`);
        }
        const report = await findReport(reportDir);
        if (!report) throw new Error(`whisperkit-cli produced no JSON report in ${reportDir}`);
        const parsed = normalizeReport(JSON.parse(await readFile(report, 'utf8')));
        if (parsed.length === 0) throw new Error(`no segments in ${report}`);
        return parsed;
      });

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
        // 講義ノート（SPEC §13.4）: スライドごとに画像とその間の発話。作業フォルダに置く
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
      const backend = createBackend({
        kind: this.config.llm,
        model: this.config.llmModel,
        codexBin: this.config.codexBin,
        openaiApiKey: this.config.openaiApiKey,
        ollamaUrl: this.config.ollamaUrl,
        charsPerCall: this.config.llmCharsPerCall,
      });
      if (backend) {
        notes = await step('polishing', async () => {
          const inputs = result.sections.map((s) => ({ id: s.id, heading: s.heading, text: s.texts.join('') }));
          const { results: polished, errors } = await polish(
            inputs,
            backend,
            {
              kind: this.config.llm,
              model: this.config.llmModel,
              codexBin: this.config.codexBin,
              openaiApiKey: this.config.openaiApiKey,
              ollamaUrl: this.config.ollamaUrl,
              charsPerCall: this.config.llmCharsPerCall,
            },
            this.log,
          );
          if (polished.size === 0) return { notes: false, notesError: errors.join(' / ') || 'no output' };
          await writeFile(
            path.join(dir, NOTES_FILE),
            buildNotesMarkdown({
              title: result.session?.title,
              url: result.session?.url,
              startedAt: result.session?.startedAt,
              backendName: backend.name,
              sections: result.sections,
              polished,
            }),
          );
          return errors.length > 0 ? { notes: true, notesError: errors.join(' / ') } : { notes: true };
        }).catch((e: unknown) => ({ notes: false, notesError: e instanceof Error ? e.message : String(e) }));
      }

      return writeStatus(dir, { ...status, stage: 'done', updatedAt: now(), result: { ...result.summary, ...notes } });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log(`pipeline error: ${message}`);
      return writeStatus(dir, { ...status, stage: 'error', updatedAt: now(), error: message });
    }
  }
}

async function findReport(reportDir: string): Promise<string | null> {
  const files = (await readdir(reportDir, { recursive: true })).filter((f) => f.endsWith('.json'));
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
