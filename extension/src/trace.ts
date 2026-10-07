/**
 * 検知の記録（trace.bin。SPEC §9.1e、2026-10-07）。
 *
 * 判定に使った縮小フレーム（160×90）と、そのときの判定を全部残す。録画した動画そのものは残さないので、
 * 検知の規則を変えて試すには撮り直すしかなかった。記録があれば、1 回の撮り直しで何通りもの規則を手元で再生して
 * 比べられる（scripts/replay-trace.mts）。
 *
 * 形式: ファイルは「u32（LE）の長さ ＋ gzip した塊」の繰り返し。塊の中身は
 *   'LSTR' u8 version=1 u32 count、そのあとに記録が count 個:
 *   u8 kind, f64 now（Date.now()）, f64 videoTime, u16 width, u16 height, u8 hasVerdict,
 *   （hasVerdict なら）u8 save, u8 state, f32 diffPrev, f32 diffSaved（なければ NaN）, u8 cells, f32 stillFraction,
 *   RGB の画素（width×height×3。alpha は落とす）
 * 塊ごとに gzip するのは、録画中に少しずつ書き足せるようにするため（1 塊 ≒ 2 MB の生データ）
 */

export const TRACE_FILE = 'trace.bin';

export type TraceKind = 'sample' | 'flush' | 'saved' | 'replaced';
const KINDS: readonly TraceKind[] = ['sample', 'flush', 'saved', 'replaced'];

export type TraceVerdict = {
  save: boolean;
  state: 'watching' | 'stabilizing';
  diffPrev: number;
  diffSaved?: number;
  cells: number;
  stillFraction: number;
};

export type TraceRecord = {
  kind: TraceKind;
  /** Date.now()（検知の時計。minShotIntervalMs などに使う） */
  now: number;
  videoTime: number;
  width: number;
  height: number;
  /** RGB の並び（width×height×3） */
  rgb: Uint8Array;
  /** sample / flush のときの判定。saved / replaced には無い */
  verdict?: TraceVerdict;
};

const MAGIC = [0x4c, 0x53, 0x54, 0x52] as const; // 'LSTR'
const VERSION = 1;
const HEADER_BYTES = 4 + 1 + 4;
const RECORD_HEAD_BYTES = 1 + 8 + 8 + 2 + 2 + 1;
const VERDICT_BYTES = 1 + 1 + 4 + 4 + 1 + 4;

/** RGBA の縮小フレームから alpha を落とす */
export function frameToRgb(frame: ArrayLike<number>, pixels: number): Uint8Array {
  const rgb = new Uint8Array(pixels * 3);
  for (let p = 0; p < pixels; p++) {
    rgb[p * 3] = frame[p * 4]!;
    rgb[p * 3 + 1] = frame[p * 4 + 1]!;
    rgb[p * 3 + 2] = frame[p * 4 + 2]!;
  }
  return rgb;
}

/** RGB を、検知が受け取るのと同じ RGBA（alpha 255）に戻す */
export function rgbToFrame(rgb: Uint8Array, pixels: number): Uint8ClampedArray {
  const frame = new Uint8ClampedArray(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    frame[p * 4] = rgb[p * 3]!;
    frame[p * 4 + 1] = rgb[p * 3 + 1]!;
    frame[p * 4 + 2] = rgb[p * 3 + 2]!;
    frame[p * 4 + 3] = 255;
  }
  return frame;
}

export function encodeBatch(records: readonly TraceRecord[]): Uint8Array {
  let size = HEADER_BYTES;
  for (const r of records) size += RECORD_HEAD_BYTES + (r.verdict ? VERDICT_BYTES : 0) + r.rgb.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  view.setUint32(5, records.length, true);
  let at = HEADER_BYTES;
  for (const r of records) {
    out[at] = KINDS.indexOf(r.kind);
    view.setFloat64(at + 1, r.now, true);
    view.setFloat64(at + 9, r.videoTime, true);
    view.setUint16(at + 17, r.width, true);
    view.setUint16(at + 19, r.height, true);
    out[at + 21] = r.verdict ? 1 : 0;
    at += RECORD_HEAD_BYTES;
    if (r.verdict) {
      out[at] = r.verdict.save ? 1 : 0;
      out[at + 1] = r.verdict.state === 'stabilizing' ? 1 : 0;
      view.setFloat32(at + 2, r.verdict.diffPrev, true);
      view.setFloat32(at + 6, r.verdict.diffSaved ?? Number.NaN, true);
      out[at + 10] = r.verdict.cells;
      view.setFloat32(at + 11, r.verdict.stillFraction, true);
      at += VERDICT_BYTES;
    }
    out.set(r.rgb, at);
    at += r.rgb.length;
  }
  return out;
}

export function decodeBatch(body: Uint8Array): TraceRecord[] {
  if (body.length < HEADER_BYTES || MAGIC.some((b, i) => body[i] !== b)) throw new Error('trace: not a batch');
  if (body[4] !== VERSION) throw new Error(`trace: unsupported version ${body[4]}`);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = view.getUint32(5, true);
  const records: TraceRecord[] = [];
  let at = HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const kind = KINDS[body[at]!];
    if (!kind) throw new Error(`trace: unknown kind ${body[at]}`);
    const now = view.getFloat64(at + 1, true);
    const videoTime = view.getFloat64(at + 9, true);
    const width = view.getUint16(at + 17, true);
    const height = view.getUint16(at + 19, true);
    const hasVerdict = body[at + 21] === 1;
    at += RECORD_HEAD_BYTES;
    let verdict: TraceVerdict | undefined;
    if (hasVerdict) {
      const diffSaved = view.getFloat32(at + 6, true);
      verdict = {
        save: body[at] === 1,
        state: body[at + 1] === 1 ? 'stabilizing' : 'watching',
        diffPrev: view.getFloat32(at + 2, true),
        ...(Number.isNaN(diffSaved) ? {} : { diffSaved }),
        cells: body[at + 10]!,
        stillFraction: view.getFloat32(at + 11, true),
      };
      at += VERDICT_BYTES;
    }
    const bytes = width * height * 3;
    records.push({ kind, now, videoTime, width, height, rgb: body.slice(at, at + bytes), ...(verdict ? { verdict } : {}) });
    at += bytes;
  }
  return records;
}

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart]);
  return new Uint8Array(await new Response(blob.stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array>)).arrayBuffer());
}

/** 1 塊を「u32 の長さ ＋ gzip」にする。ファイルに書き足していく単位 */
export async function packMember(records: readonly TraceRecord[]): Promise<Uint8Array> {
  const packed = await pipeThrough(encodeBatch(records), new CompressionStream('gzip'));
  const out = new Uint8Array(4 + packed.length);
  new DataView(out.buffer).setUint32(0, packed.length, true);
  out.set(packed, 4);
  return out;
}

/** trace.bin 全体（塊の繰り返し）を読む */
export async function readTrace(file: Uint8Array): Promise<TraceRecord[]> {
  const records: TraceRecord[] = [];
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let at = 0;
  while (at + 4 <= file.length) {
    const length = view.getUint32(at, true);
    const member = file.subarray(at + 4, at + 4 + length);
    if (member.length < length) throw new Error(`trace: truncated member at ${at}`);
    records.push(...decodeBatch(await pipeThrough(member, new DecompressionStream('gzip'))));
    at += 4 + length;
  }
  return records;
}
