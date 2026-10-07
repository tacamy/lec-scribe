import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type ServerConfig, usesVision } from './config.ts';
import { run } from './exec.ts';
import { toSrt, toTxt, toVtt, type Segment } from './format.ts';
import { NOTES_FILE, SLIDES_DIR, migrateLayout, restoreUnusedSlides, tidyUnusedSlides, workPath } from './layout.ts';
import { applyCorrections, checkWithFallback, createBackend, isModelUnavailable, outline, polish, type Correction, type Outline, type PolishOutput } from './llm.ts';
import { cacheKey, deriveFromCache, readNotesCache, sameSettings, writeNotesCache } from './notes-cache.ts';
import { assignSlides, buildLectureMarkdown, buildNotesMarkdown, groupAssigned, isSlideList, type MergedSegment, type SlideEntry } from './merge.ts';
import { arrangeImages, findPickRegions, runPicker } from './picker.ts';
import { pickShownSlides, readThumbnail, shownSlides, type SceneDecision } from './scenes.ts';
import { visionDistances } from './vision.ts';
import { isTimeline, toVideoTime } from './timeline.ts';
import { dropWindowArtifacts, normalizeReport, whisperkitArgs } from './whisperkit.ts';

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
    /** 同じ場面として notes.md に載せなかった画像の数（§13.4b） */
    hiddenSlides?: number;
    /** notes.md を作れたか。ノート作成が無効なら undefined */
    notes?: boolean;
    notesError?: string;
    /** 前回の LLM の結果を使い回したか（§13.5b） */
    notesReused?: boolean;
    /** ノート作成の途中で利用者が止めた（初回の処理の「中止」。文字起こしのままのノートで完了にした。§11.3） */
    notesCancelled?: boolean;
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
    // 処理の前に slides/ へ戻した画像が全部残っている。前回の notes.md があればそれに合わせて片付け直す（§14）
    const tidied = await tidyUnusedSlides(dir).catch((e: unknown) => {
      log(`画像を片付けられませんでした: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    if (tidied && tidied.moved > 0) log(`notes.md に載せなかった画像 ${tidied.moved} 枚を .lecscribe/unused/ へ移しました（slides/ は ${tidied.kept} 枚）`);
    recovered.push(dir);
  }
  return recovered;
}

export const PIPELINE_FILE = 'pipeline.json';
/**
 * 「やり直す」を受け付けた時点の pipeline.json（完了していたもの）の控え（§11.3、2026-09-20）。
 * やり直しを中止したら、これを pipeline.json に書き戻す（＝やり直す前の状態に戻す）。
 * 完了・失敗で終わったら捨てる。初回の処理には無い
 */
export const PREVIOUS_FILE = 'pipeline.previous.json';

/**
 * 「やり直す」の前に、完了していた状態の控えを取る。POST /finalize が pipeline.json を queued で上書きする前に呼ぶ。
 * 完了していなかった（失敗・中止のまま）なら控えは作らず、古い控えが残っていれば捨てる
 * （もっと前の完了状態に戻してしまわないように）
 */
export async function snapshotDone(dir: string): Promise<void> {
  const previous = await readPipelineStatus(dir);
  const file = workPath(dir, PREVIOUS_FILE);
  if (previous?.stage === 'done') await writeFile(file, JSON.stringify(previous, null, 2)).catch(() => undefined);
  else await rm(file, { force: true }).catch(() => undefined);
}

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
  // 処理中に Finder でフォルダが消されると、ここでセッションフォルダごと作り直す。ensureLayout と同じく本人だけが読めるように（§18）
  await mkdir(workPath(dir), { recursive: true, mode: 0o700 });
  await writeFile(workPath(dir, PIPELINE_FILE), JSON.stringify(status, null, 2));
  return status;
}

/** 画像の救出（§13.4c）に渡す、場面まとめまでの結果 */
type PickerInput = {
  segments: readonly { videoStart: number; videoEnd: number; text: string }[];
  allSlides: readonly SlideEntry[];
  shown: readonly SlideEntry[];
  decisions: readonly SceneDecision[];
  texts: ReadonlyMap<string, string>;
};

type Job = {
  controller: AbortController;
  /** ノート作成（LLM）だけを止める。処理全体の中止（controller）でも止まる */
  llm: AbortController;
  task: Promise<PipelineStatus>;
  started: boolean;
  /** いまの段階。ノート作成中だけ「文字起こしのままで完了にする」を受け付ける */
  stage?: PipelineStatus['stage'];
  /**
   * この回の whisperkit の状況。中止のときに、文字起こしの記録（transcript）をどうするかを決める。
   *   untouched: 動かしていない（前の report を使い回した、まだ順番待ち）。前の記録をそのまま残す
   *   running:   動かしている途中。report を書き換えている最中なので記録を落とす（壊れた report を再利用して失敗し続けないように）
   *   finished:  この回で作り直した。ディスクにあるのは新しい report なので、記録も新しいものにする
   */
  whisper: { state: 'untouched' | 'running' } | { state: 'finished'; record: NonNullable<PipelineStatus['transcript']> };
};

/**
 * audio.webm → audio.wav → whisperkit-cli → transcript.json / .txt / .srt / .vtt（SPEC §12.4）。
 * 同時に 1 件だけ動かす。
 */
export class Pipeline {
  private queue: Promise<unknown> = Promise.resolve();
  /** 待機中・実行中のセッション。cancel() で中断できる */
  private readonly jobs = new Map<string, Job>();
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
    const llm = new AbortController();
    // 処理全体を止めたら LLM も止まる（AbortSignal.any は使わない。Node 22 の前半に、束ねた signal が GC で外れる不具合がある）
    controller.signal.addEventListener('abort', () => llm.abort(), { once: true });
    const job: Job = {
      controller,
      llm,
      task: Promise.resolve({ stage: 'queued', outputDir: dir, updatedAt: '' }),
      started: false,
      whisper: { state: 'untouched' },
    };
    job.task = this.queue
      .then(() => {
        if (controller.signal.aborted) return this.writeCancelled(dir, job);
        job.started = true;
        return this.process(dir, job);
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

  /**
   * ノート作成中なら LLM だけを止め、文字起こしのままのノートで完了にする（初回の処理の「中止」。§11.3）。
   * 文字起こしまで済んでいるのに、録音ごと消してしまわないため。ノート作成中でなければ何もしないで false
   */
  async finishWithoutNotes(dir: string): Promise<boolean> {
    const job = this.jobs.get(dir);
    if (!job || !job.started || job.stage !== 'polishing') return false;
    job.llm.abort();
    await job.task.catch(() => undefined);
    return true;
  }

  /**
   * report JSON を読んで区間にし、窓の重複や決まり文句だけの区間（Whisper の幻覚）を落とす。
   * 落としたものはログに残す。全部落ちたときは「区間がない」と区別できる文言で失敗させる
   */
  private async readSegments(report: string): Promise<Segment[]> {
    const all = normalizeReport(JSON.parse(await readFile(report, 'utf8')));
    if (all.length === 0) throw new Error(`no segments in ${report}`);
    const { kept, dropped } = dropWindowArtifacts(all);
    for (const d of dropped) this.log(`dropped artifact segment (${d.reason}) ${d.start.toFixed(1)}-${d.end.toFixed(1)}: ${d.text.slice(0, 40)}`);
    if (kept.length === 0) throw new Error(`all ${all.length} segments in ${report} were dropped as Whisper artifacts`);
    return kept;
  }

  /**
   * 映像中心の画面で同じ場面が続く画像を notes.md から外す。サムネイルは ffmpeg で作る。
   * 取れなければ何も外さない。判断は .lecscribe/scenes.json に残す
   */
  private async pickScenes(
    dir: string,
    slides: SlideEntry[],
    signal?: AbortSignal,
  ): Promise<{ slides: SlideEntry[]; decisions: SceneDecision[]; texts: Map<string, string> }> {
    // sceneColor が 0 でも、中身が同じ画像を外す判定は残す（scenes.ts）
    if (slides.length < 2) return { slides: [...slides], decisions: [], texts: new Map() };
    const thumbs = new Map<string, Uint8Array>();
    for (const s of slides) {
      if (signal?.aborted) return { slides: [...slides], decisions: [], texts: new Map() };
      const thumb = await readThumbnail(this.config.ffmpegBin, path.join(dir, SLIDES_DIR, s.filename), signal);
      if (thumb) thumbs.set(s.filename, thumb);
    }
    if (thumbs.size === 0) return { slides: [...slides], decisions: [], texts: new Map() };
    // 見た目の距離と写っている文字（macOS の Vision）。用意できなければ色と画素だけで判定する
    const measure = usesVision(this.config)
      ? await visionDistances(slides.map((s) => path.join(dir, SLIDES_DIR, s.filename)), this.log, signal)
      : null;
    const visionOptions = measure ? { distance: measure.distance, text: measure.text, tight: this.config.sceneVision, photo: this.config.sceneVisionPhoto } : undefined;
    const decisions = pickShownSlides(slides, thumbs, this.config.sceneColor, visionOptions, this.config.sceneKeep);
    await writeFile(
      workPath(dir, 'scenes.json'),
      JSON.stringify(
        {
          threshold: this.config.sceneColor,
          vision: measure ? { tight: this.config.sceneVision, photo: this.config.sceneVisionPhoto, text: slides.some((_, i) => measure.text(i) !== undefined) } : null,
          decisions,
        },
        null,
        2,
      ),
    ).catch(() => undefined);
    const hidden = decisions.filter((d) => !d.shown);
    if (hidden.length > 0) this.log(`notes.md から外した画像（同じ場面・ほぼ一色）: ${hidden.length} 枚（${hidden.map((d) => d.filename).join(', ')}）`);
    // Vision が読んだ文字は画像の救出（§13.4c）の歯止めにも使う（字幕の写った代表を文字のない画像に差し替えない）
    const texts = new Map<string, string>();
    if (measure) {
      slides.forEach((s, i) => {
        const text = measure.text(i);
        if (text) texts.set(s.filename, text);
      });
    }
    return { slides: shownSlides(slides, decisions), decisions, texts };
  }

  /**
   * 映像・板書の節で外された画像から、本文の助けになる瞬間を LLM に選ばせて足す・差し替える（SPEC §13.4c）。
   * codex のときだけ動く。失敗しても処理は止めない。載せる画像が変わらなければ null を返す。
   * ノート作成の段階（polishing）で呼ぶ: LLM の呼び出しなので、初回の処理の「中止」が録音ごと消さずに
   * ノート作成だけを止める扱いになるように（§11.3。2026-10-02 のレビュー）
   */
  private async rescueImages(
    dir: string,
    input: PickerInput,
    settings: { model: string; fallbackModel: string; signal: AbortSignal },
  ): Promise<SlideEntry[] | null> {
    if (!settings.model || settings.signal.aborted) return null;
    try {
      const regions = findPickRegions(input.segments, input.allSlides, input.decisions, input.texts);
      if (regions.length === 0) return null;
      const run = await runPicker({
        dir,
        slidesDir: path.join(dir, SLIDES_DIR),
        regions,
        settings: { codexBin: this.config.codexBin, model: settings.model, fallbackModel: settings.fallbackModel, signal: settings.signal },
        log: this.log,
      });
      if (settings.signal.aborted) return null;
      if (run.reused) this.log('画像の救出: 前回の選択を使い回します');
      for (const e of run.errors) this.log(`画像の救出に失敗（ノートはそのまま作ります）: ${e}`);
      if (run.accepted.length > 0) this.log(`画像の救出 (${run.model}): ${run.accepted.length} 枚を足しました（${run.accepted.join(', ')}）`);
      for (const s of run.swaps) this.log(`画像の差し替え (${run.model}): ${s.from} → ${s.to}（同じまとまりの中で、本文に合う瞬間へ）`);
      // scenes.json にも残す（外した判断と同じ場所で追えるように）
      try {
        const scenes = JSON.parse(await readFile(workPath(dir, 'scenes.json'), 'utf8')) as Record<string, unknown>;
        scenes['picker'] = { model: run.model, accepted: run.accepted, swaps: run.swaps, rejected: run.rejected, errors: run.errors };
        await writeFile(workPath(dir, 'scenes.json'), JSON.stringify(scenes, null, 2));
      } catch {
        // scenes.json が無い・読めないときは記録だけ諦める
      }
      if (run.accepted.length === 0 && run.swaps.length === 0) return null;
      return arrangeImages(input.shown, input.allSlides, input.decisions, run.accepted, run.swaps);
    } catch (error) {
      this.log(`画像の救出に失敗（ノートはそのまま作ります）: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** audio.webm → wav → whisperkit-cli。report の区間を返す */
  private async transcribe(
    dir: string,
    audioWebm: string,
    audioWav: string,
    reportDir: string,
    step: <T>(stage: PipelineStatus['stage'], work: () => Promise<T>) => Promise<T>,
    signal: AbortSignal,
  ): Promise<Segment[]> {
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
        return this.readSegments(report);
      });
  }

  /**
   * 中止を書く。「やり直す」の中止なら、やり直す前の状態（控え）に丸ごと戻す。notes.md は前回のまま残っているので、
   * 状態も「完了」のままが実態に合う。ただしこの回で whisperkit を動かしていたら、文字起こしの記録だけは落とす。
   * 控えが無い（初回の処理、前回が失敗・中止だった）ときは cancelled と書き、同じ条件で記録を引き継ぐ
   */
  private async writeCancelled(dir: string, job: Job): Promise<PipelineStatus> {
    this.log(`cancelled: ${dir}`);
    const snapshotFile = workPath(dir, PREVIOUS_FILE);
    let snapshot: PipelineStatus | null = null;
    try {
      snapshot = JSON.parse(await readFile(snapshotFile, 'utf8')) as PipelineStatus;
    } catch {
      // 控えなし
    }
    const restored = snapshot?.stage === 'done' ? snapshot : null;
    // 文字起こしの記録は、ディスクにある report と合うものにする（Job.whisper）
    const transcript =
      job.whisper.state === 'finished' ? job.whisper.record : job.whisper.state === 'running' ? undefined : (restored ?? (await readPipelineStatus(dir)))?.transcript;
    const { transcript: _stale, ...base } = restored ?? ({ stage: 'cancelled', outputDir: dir, updatedAt: new Date().toISOString() } satisfies PipelineStatus);
    const status: PipelineStatus = { ...base, ...(transcript ? { transcript } : {}) };
    // 中止と同時に削除されたフォルダを作り直さない
    const exists = await stat(dir).then(() => true).catch(() => false);
    if (!exists) return status;
    if (restored) this.log(`やり直しを中止したので、やり直す前の状態に戻しました: ${dir}`);
    await rm(snapshotFile, { force: true }).catch(() => undefined);
    // 処理の前に slides/ へ戻した画像を、残っている notes.md（前回のまま）に合わせて片付け直す
    await this.tidySlides(dir);
    return writeStatus(dir, status).catch(() => status);
  }

  /** notes.md に載せなかった画像を .lecscribe/unused/ へ片付ける（§14）。処理の終わり（完了・失敗・中止）に呼ぶ */
  private async tidySlides(dir: string): Promise<void> {
    try {
      const tidied = await tidyUnusedSlides(dir);
      if (tidied && tidied.moved > 0) {
        this.log(`notes.md に載せなかった画像 ${tidied.moved} 枚を .lecscribe/unused/ へ移しました（slides/ は ${tidied.kept} 枚）`);
      }
    } catch (e) {
      this.log(`画像を片付けられませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async process(dir: string, job: Job): Promise<PipelineStatus> {
    const signal = job.controller.signal;
    const now = () => new Date().toISOString();
    // 前回の文字起こしの条件は、最初の書き込みで消す前に読んでおく
    const previous = await readPipelineStatus(dir);
    let status: PipelineStatus = { stage: 'converting', outputDir: dir, startedAt: now(), updatedAt: now(), timings: {}, transcript: previous?.transcript };
    await writeStatus(dir, status);
    const step = async <T>(stage: PipelineStatus['stage'], work: () => Promise<T>): Promise<T> => {
      if (signal.aborted) throw new Error('cancelled');
      job.stage = stage;
      status = await writeStatus(dir, { ...status, stage, updatedAt: now() });
      const started = Date.now();
      const result = await work();
      if (signal.aborted) throw new Error('cancelled');
      status.timings = { ...status.timings, [stage]: Math.round((Date.now() - started) / 100) / 10 };
      return result;
    };

    try {
      await migrateLayout(dir);
      // 前回の処理で片付けた画像を slides/ に戻す。場面まとめと救出は全画像から選ぶ（§14）
      const restored = await restoreUnusedSlides(dir);
      if (restored > 0) this.log(`片付けていた画像 ${restored} 枚を処理の間 slides/ に戻しました`);
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

      let segments: Segment[];
      if (previousReport) {
        this.log(`transcript を再利用: ${previousReport}`);
        segments = await this.readSegments(previousReport);
      } else {
        // ここから先は report を書き換える。途中で中止されたら、前の文字起こしの記録はもう使えない
        job.whisper = { state: 'running' };
        segments = await this.transcribe(dir, audioWebm, audioWav, reportDir, step, signal);
        job.whisper = { state: 'finished', record: { model: this.config.model, audioBytes } };
      }
      status.transcript = { model: this.config.model, audioBytes, ...(previousReport ? { reused: true } : {}) };

      const result = await step('merging', async () => {
        const timeline = await readJson(workPath(dir, 'timeline.json'));
        const events = isTimeline(timeline) ? timeline : null;
        const slidesJson = await readJson(workPath(dir, 'slides.json'));
        const validSlides = isSlideList(slidesJson);
        const allSlides = validSlides ? slidesJson : [];
        // 配列でない形（オブジェクトなど）も黙って画像なしにしない。ファイルが無い・JSON として読めないときは undefined
        if (!validSlides && slidesJson !== undefined) {
          this.log(`slides.json の形が違う（画像の名前が slide_001.png の形でないなど）ので、画像なしでノートを作ります: ${dir}`);
        }
        // 同じ場面の画像は notes.md に並べない（§13.4b）。判断は scenes.json に残す
        const { slides: shownOnly, decisions, texts } = await this.pickScenes(dir, allSlides, signal);
        const segsWithVideoTime = segments.map((s) => ({
          ...s,
          videoStart: events ? toVideoTime(events, s.start) : s.start,
          videoEnd: events ? toVideoTime(events, s.end) : s.end,
        }));
        const session = (await readJson(workPath(dir, 'session.json'))) as
          | { title?: string; url?: string; startedAt?: string }
          | undefined;
        /**
         * 載せる画像の並びから transcript.json・lecture.md・節・文字起こしのままのノートを作る。
         * 画像の救出（§13.4c）で並びが変わったら、ノート作成の段階で作り直す
         */
        const build = async (slides: readonly SlideEntry[]) => {
          const mapped: MergedSegment[] = assignSlides(segsWithVideoTime, slides);
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
          // ノート（SPEC §13.4）: スライドごとに画像とその間の発話。作業フォルダに置く
          // 割り当ては 1 回だけ。節は mapped の slide のまま束ね、lecture.md・notes.md で同じ節を使う。区間の数はもとの区間で数える
          const sections = groupAssigned(mapped, slides);
          const lectureInput = {
            title: session?.title,
            url: session?.url,
            startedAt: session?.startedAt,
            segments: mapped,
            slides: [...slides],
            sections,
            segmentCount: segsWithVideoTime.length,
          };
          await writeFile(workPath(dir, 'lecture.md'), buildLectureMarkdown({ ...lectureInput, imagePrefix: '../slides/' }));
          const rawNotes = buildLectureMarkdown({
            ...lectureInput,
            note: this.config.llm === 'none' ? '文字起こしそのままの本文。サーバーを --llm 付きで動かすと、整えた本文と要点になる' : undefined,
          });
          return {
            mapped,
            sections,
            rawNotes,
            hiddenSlides: allSlides.length > slides.length ? allSlides.length - slides.length : undefined,
          };
        };
        const built = await build(shownOnly);
        const mapped = built.mapped;
        // 字幕のファイルは画像の並びに依らないので 1 度だけ書く。画像の境目で分けた区間（§13.4）ではなく、もとの区間で書く
        const forSubtitles: Segment[] = segsWithVideoTime.map((s) => ({ start: s.videoStart, end: s.videoEnd, text: s.text }));
        await writeFile(workPath(dir, 'transcript.srt'), toSrt(forSubtitles));
        await writeFile(workPath(dir, 'transcript.vtt'), toVtt(forSubtitles));
        await writeFile(workPath(dir, 'transcript.txt'), toTxt(forSubtitles));
        // ユーザー向けの notes.md はまず文字起こしそのままで置き、LLM が使えれば整えた版で上書きする。
        // ただし前回の整えた notes.md が既にあるとき（やり直し）は触らない。途中で「中止」しても前回の結果が残るように。
        // ノート作成に失敗したときは、あとでこの本文を書き込む（前回の結果が残ったままにならないように）
        const notesFile = path.join(dir, NOTES_FILE);
        const hasNotes = await stat(notesFile).then(() => true).catch(() => false);
        if (!hasNotes || this.config.llm === 'none') await writeFile(notesFile, built.rawNotes);
        if (!this.config.keepWav) await rm(audioWav, { force: true });
        const pickerInput: PickerInput = { segments: segsWithVideoTime, allSlides, shown: shownOnly, decisions, texts };
        return {
          summary: {
            // もとの区間の数（画像の境目で分けた区間は数えない。救出で並びが変わっても変わらない）
            segments: segsWithVideoTime.length,
            durationSec: Math.round(mapped[mapped.length - 1]!.end),
            hasTimeline: events !== null,
            slides: allSlides.length,
            ...(built.hiddenSlides ? { hiddenSlides: built.hiddenSlides } : {}),
          } as NonNullable<PipelineStatus['result']>,
          sections: built.sections,
          session,
          rawNotes: built.rawNotes,
          build,
          pickerInput,
        };
      });

      // ノート作成（任意）。失敗しても文字起こしまでは done にする
      let notes: { notes?: boolean; notesError?: string; notesReused?: boolean; notesCancelled?: boolean } = {};
      /** ノート作成に失敗したら、文字起こしそのままの本文を置く（前回の内容が残ったままにならないように） */
      const fallbackNotes = async (notesError: string) => {
        await writeFile(path.join(dir, NOTES_FILE), result.rawNotes).catch(() => undefined);
        this.log(`ノートを整えられませんでした（${notesError}）。文字起こしそのままの本文を置きました`);
        return { notes: false, notesError };
      };
      // モデルは処理の開始時に一度だけ写し取る（POST /settings は共有の config を書き換えるので、
      // 進行中の処理に混ぜるとキャッシュの記録と実際に使ったモデルが食い違う。2026-10-01 のレビュー）
      const llmCheckModel = this.config.llmCheckModel;
      const llmPickModel = this.config.llmPickModel;
      const llmSettings = {
        kind: this.config.llm,
        model: this.config.llmModel,
        codexBin: this.config.codexBin,
        openaiApiKey: this.config.openaiApiKey,
        ollamaUrl: this.config.ollamaUrl,
        charsPerCall: this.config.llmCharsPerCall,
        // LLM だけを止める signal。処理全体の中止でも止まる（enqueue でつないである）
        signal: job.llm.signal,
      };
      /** 利用者がノート作成だけを止めた（処理全体の中止ではない） */
      const notesStopped = () => job.llm.signal.aborted && !signal.aborted;
      const backend = createBackend(llmSettings);
      if (backend) {
        notes = await step('polishing', async () => {
          // 映像・板書の節では、外した画像から本文の助けになる瞬間を救い出す・差し替える（§13.4c）。
          // 画像の並びが変わったら transcript.json・lecture.md・節を作り直してから整える
          if (llmSettings.kind === 'codex') {
            const rescued = await this.rescueImages(dir, result.pickerInput, {
              model: llmPickModel,
              fallbackModel: llmSettings.model,
              signal: job.llm.signal,
            });
            if (signal.aborted) throw new Error('cancelled');
            if (notesStopped()) throw new Error('notes stopped');
            if (rescued) {
              const rebuilt = await result.build(rescued);
              result.sections = rebuilt.sections;
              result.rawNotes = rebuilt.rawNotes;
              const { hiddenSlides: _previous, ...summary } = result.summary;
              result.summary = { ...summary, ...(rebuilt.hiddenSlides ? { hiddenSlides: rebuilt.hiddenSlides } : {}) };
            }
          }
          // 整えのモデルが使えず指定なしに切り替えたとき、以降（要点・校正の受け皿）も同じ切り替え先を使う
          let activeBackend = backend;
          /** activeBackend が使っているモデル（受け皿に切り替えたら ''）。校正の受け皿を出すかの比較はこちらで行う */
          let activeModel = llmSettings.model;
          const inputs = result.sections.map((s) => ({ id: s.id, heading: s.heading, text: s.texts.join('') }));
          // 本文と呼び出し先が前と同じなら、保存しておいた結果を使う（§13.5b）
          const cacheSettings = {
            kind: llmSettings.kind,
            model: llmSettings.model,
            charsPerCall: llmSettings.charsPerCall,
            ...(llmCheckModel ? { checkModel: llmCheckModel } : {}),
          };
          const key = cacheKey(inputs, cacheSettings);
          const stored = await readNotesCache(dir);
          // 失敗が残っているキャッシュは使い回さない（一時的な失敗が永久に固定されるため）
          const cached = stored && stored.key === key && (stored.errors ?? []).length === 0 && stored.outline ? stored : null;
          if (stored && !cached && stored.key === key) this.log('前回のノートに失敗が残っているので作り直します');
          let polished: Map<string, PolishOutput>;
          let topics: Outline | undefined;
          let errors: string[];
          let reused = false;
          if (cached) {
            this.log(`前回のノートを使い回します（${cached.backend}, ${cached.generatedAt}）`);
            polished = new Map(cached.polished.map((p) => [p.id, p]));
            topics = cached.outline;
            errors = cached.errors ?? [];
            reused = true;
          } else {
            // 節の区切りだけが変わった（載せる画像を選び直した）なら、前回の結果を組み替えて使う。
            // 一致しない節だけ LLM に頼む
            // 呼び出し先・モデル・分割の大きさが変わっていたら組み替えずに作り直す（前のモデルの文章を使い回さないため）。
            // 失敗が残っているキャッシュも組み替えの材料にしない
            const previous = stored && sameSettings(stored, cacheSettings) && (stored.errors ?? []).length === 0 ? stored : null;
            const derived = previous ? deriveFromCache(previous, inputs) : { polished: new Map<string, PolishOutput>(), unmatched: inputs.map((s) => s.id) };
            const todo = inputs.filter((s) => derived.unmatched.includes(s.id));
            polished = derived.polished;
            errors = [];
            /** 校正で当てた直し（キャッシュに記録する） */
            let corrections: Correction[] = [];
            /** 校正だけの失敗。本文は揃っているので、errors（notesError とキャッシュの使い回しの判断）には混ぜない */
            let checkErrors: string[] = [];
            if (todo.length > 0) {
              if (todo.length < inputs.length) this.log(`前回のノートを組み替えて使い、${todo.length} 節だけ作り直します`);
              let result = await polish(todo, activeBackend, llmSettings, this.log);
              if (signal.aborted) throw new Error('cancelled');
              if (notesStopped()) throw new Error('notes stopped');
              // 整えのモデルが使えない（プランにない等。設定画面で選べるようになったぶん起きやすい）ときは、
              // 指定なし（呼び出し先の既定のモデル）で 1 度だけやり直す。文字起こしのままのノートに落とさない（2026-10-01）
              if (llmSettings.model && result.results.size === 0 && result.errors.some(isModelUnavailable)) {
                const fallback = createBackend({ ...llmSettings, model: '' });
                if (fallback) {
                  this.log(`整えのモデル（${activeBackend.name}）が使えないようです: ${result.errors.find(isModelUnavailable)}。${fallback.name}（指定なし）でやり直します`);
                  activeBackend = fallback;
                  activeModel = '';
                  result = await polish(todo, activeBackend, llmSettings, this.log);
                  if (signal.aborted) throw new Error('cancelled');
                  if (notesStopped()) throw new Error('notes stopped');
                }
              }
              for (const [id, out] of result.results) polished.set(id, out);
              errors = result.errors;
              // 校正（任意、§13.5）: 新しく整えた節だけを原文と突き合わせ、誤変換を直す。組み替えで使い回した節は前回すでに校正済み
              const checkBackend = llmCheckModel ? createBackend({ ...llmSettings, model: llmCheckModel }) : null;
              const checkInputs = checkBackend
                ? todo.flatMap((s) => {
                    const text = polished.get(s.id)?.text;
                    return text ? [{ id: s.id, original: s.text, polished: text }] : [];
                  })
                : [];
              if (checkBackend && checkInputs.length > 0) {
                // 校正モデルが使えない（プランにない等）ときは、本文と同じモデルで校正し直す（未校正のまま完成させない）
                // 校正モデルが「いま整えに使ったモデル」と同じときだけ受け皿なし（同じものを二度試しても無駄）。
                // 整えが既定のモデルに切り替わっていたら、校正モデルと名前が同じでも受け皿はその既定のモデルにする（2026-10-01 のレビュー）
                const checked = await checkWithFallback(checkInputs, checkBackend, llmCheckModel !== activeModel ? activeBackend : null, llmSettings, this.log);
                if (signal.aborted) throw new Error('cancelled');
                if (notesStopped()) throw new Error('notes stopped');
                // 校正の失敗は polish の errors に混ぜない（2026-10-01 のレビュー）: 本文は揃っていて直しが入らないだけなので、
                // 混ぜると拡張が「一部の節だけ文字起こしのまま」と誤って表示し、キャッシュも使い回されなくなる
                checkErrors = checked.errors;
                if (checkErrors.length > 0) this.log(`校正の一部が失敗しました（本文は未校正のまま使います）: ${checkErrors.join(' / ')}`);
                const applied = applyCorrections(new Map(checkInputs.map((s) => [s.id, s.polished])), checked.corrections);
                for (const [id, text] of applied.texts) polished.set(id, { id, text });
                corrections = applied.applied;
                if (checked.corrections.length > 0) {
                  const dropped = checked.corrections.length - corrections.length;
                  this.log(`校正: ${corrections.length} 件の誤変換を直しました${dropped > 0 ? `（${dropped} 件は本文に見つからず捨てました）` : ''}`);
                }
              }
            }
            // 発話のある節が 1 つも整わなかったら失敗とする（空の節はキャッシュの組み替えでも埋まるため数に入れない）
            const hasText = inputs.some((i) => i.text !== '');
            if (polished.size === 0 || (hasText && ![...polished.values()].some((x) => x.text !== ''))) {
              return await fallbackNotes(errors.join(' / ') || 'no output');
            }
            if (todo.length === 0 && derived.outline) {
              this.log(`前回のノートを組み替えて使い回します（${previous!.backend}, ${previous!.generatedAt}）`);
              topics = derived.outline;
              reused = true;
            } else {
              // 整えた本文全体（整えられなかった節は文字起こしのまま）から全体の要点と話題の区切りを作る
              const outlineInput = inputs.map((s) => ({ id: s.id, text: polished.get(s.id)?.text ?? s.text }));
              const { outline: made, error: outlineError } = await outline(outlineInput, activeBackend, llmSettings, this.log);
              if (signal.aborted) throw new Error('cancelled');
              if (notesStopped()) throw new Error('notes stopped');
              topics = made;
              if (outlineError) errors.push(outlineError);
            }
            await writeNotesCache(dir, {
              key,
              generatedAt: now(),
              backend: activeBackend.name,
              settings: cacheSettings,
              inputs: inputs.map((s) => ({ id: s.id, text: s.text })),
              polished: [...polished.values()],
              ...(corrections.length > 0 ? { corrections } : {}),
              ...(checkErrors.length > 0 ? { checkErrors } : {}),
              ...(topics ? { outline: topics } : {}),
              ...(errors.length > 0 ? { errors } : {}),
            });
          }
          if (polished.size === 0) return await fallbackNotes(errors.join(' / ') || 'no output');
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
          return {
            notes: true,
            ...(errors.length > 0 ? { notesError: errors.join(' / ') } : {}),
            ...(reused ? { notesReused: true } : {}),
          };
        }).catch(async (e: unknown) => {
          // 「中止」のときは前回の結果を残し、外側で cancelled として書く。ここで notes: false のまま返すと
          // 段階が done になり、利用者が自分で止めたのに一覧へ「ノートを整えられませんでした」が出る（§13.5）
          if (signal.aborted) throw e;
          // 利用者がノート作成だけを止めた（初回の処理の「中止」。§11.3）。文字起こしは済んでいるので、
          // 文字起こしのままのノートで完了にする。失敗ではないので、拡張は別の文言で知らせる
          if (notesStopped()) return { ...(await fallbackNotes('ノート作成を中止しました')), notesCancelled: true };
          // それ以外の失敗では文字起こしそのままの本文に戻す
          return await fallbackNotes(e instanceof Error ? e.message : String(e));
        });
      }

      // 最後まで進んだので、やり直す前の状態の控えはもう要らない
      await rm(workPath(dir, PREVIOUS_FILE), { force: true }).catch(() => undefined);
      await this.tidySlides(dir);
      return writeStatus(dir, { ...status, stage: 'done', updatedAt: now(), result: { ...result.summary, ...notes } });
    } catch (e) {
      if (signal.aborted) return this.writeCancelled(dir, job);
      const message = e instanceof Error ? e.message : String(e);
      this.log(`pipeline error: ${message}`);
      // 失敗で終わったら控えは捨てる（次の「やり直す」の中止で、失敗より前の状態に戻してしまわないように）
      await rm(workPath(dir, PREVIOUS_FILE), { force: true }).catch(() => undefined);
      // notes.md があれば（前回のままか、文字起こしそのままの本文）それに合わせて画像を片付け直す
      await this.tidySlides(dir);
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
