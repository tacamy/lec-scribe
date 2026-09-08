// Generates fixtures/slides.webm: a synthetic lecture video made of N slides
// that switch every S seconds, with a small moving box in a corner (a stand-in
// for the lecturer's camera wipe) and a short beep at each slide change.
// Rendered with a canvas + MediaRecorder inside headless Chromium (Playwright),
// so it works wherever the E2E tests run. If `ffmpeg` is on PATH the result is
// remuxed so the file gets duration/cues and seeks properly in <video>.
//
// Usage: node fixtures/make-slides.mjs [--slides 10] [--seconds 5] [--width 1280] [--height 720] [--clock]
import { spawnSync } from 'node:child_process';
import { rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const opts = parseArgs(process.argv.slice(2));
const out = path.join(here, 'slides.webm');
const raw = path.join(here, 'slides.raw.webm');

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');
console.log(`rendering ${opts.slides} slides × ${opts.seconds}s at ${opts.width}×${opts.height} (real time)…`);

const base64 = await page.evaluate(async ({ slides, seconds, width, height, clock }) => {
  const canvas = document.getElementById('c');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(30);
  const audio = new AudioContext();
  const dest = audio.createMediaStreamDestination();
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(dest);
  osc.start();
  await audio.resume();
  stream.addTrack(dest.stream.getAudioTracks()[0]);

  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));

  const palette = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22'];
  const drawSlide = (i, t) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = palette[i % palette.length];
    ctx.fillRect(0, 0, width, height * 0.14);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(height * 0.07)}px sans-serif`;
    ctx.fillText(`Slide ${i + 1} / ${slides}`, width * 0.04, height * 0.1);
    ctx.fillStyle = '#222222';
    ctx.font = `${Math.round(height * 0.045)}px sans-serif`;
    for (let line = 0; line < 5; line++) {
      const y = height * (0.28 + line * 0.11);
      ctx.fillText(`• 項目 ${line + 1}: スライド ${i + 1} の本文テキスト（${'あいうえお'.repeat(1 + ((i + line) % 3))}）`, width * 0.06, y);
    }
    // Wipe: a small box whose contents move every frame.
    const bw = width * 0.18;
    const bh = height * 0.2;
    const bx = width - bw - width * 0.02;
    const by = height - bh - height * 0.04;
    ctx.fillStyle = '#333333';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#f5d0a9';
    const cx = bx + bw / 2 + Math.sin(t / 300) * bw * 0.12;
    const cy = by + bh / 2 + Math.cos(t / 450) * bh * 0.1;
    ctx.beginPath();
    ctx.arc(cx, cy, bh * 0.28, 0, Math.PI * 2);
    ctx.fill();
    if (clock) {
      ctx.fillStyle = '#666666';
      ctx.font = `${Math.round(height * 0.03)}px monospace`;
      ctx.fillText((t / 1000).toFixed(1) + 's', width * 0.02, height * 0.97);
    }
  };

  const total = slides * seconds * 1000;
  const t0 = performance.now();
  let lastSlide = -1;
  rec.start(1000);
  await new Promise((resolve) => {
    const frame = () => {
      const t = performance.now() - t0;
      const i = Math.min(slides - 1, Math.floor(t / (seconds * 1000)));
      if (i !== lastSlide) {
        lastSlide = i;
        const now = audio.currentTime;
        osc.frequency.setValueAtTime(440 * Math.pow(2, i / 12), now);
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.35);
      }
      drawSlide(i, t);
      if (t < total) requestAnimationFrame(frame);
      else resolve();
    };
    frame();
  });
  rec.stop();
  await stopped;
  const blob = new Blob(chunks, { type: 'video/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}, opts);

await browser.close();
await writeFile(raw, Buffer.from(base64, 'base64'));

const ffmpeg = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c', 'copy', out], { stdio: 'inherit' });
if (ffmpeg.status === 0) {
  await unlink(raw);
  console.log(`wrote ${path.relative(process.cwd(), out)} (remuxed with ffmpeg)`);
} else {
  await rename(raw, out);
  console.log(`wrote ${path.relative(process.cwd(), out)} (ffmpeg not found: file has no duration/cues, seeking may be limited)`);
}

function parseArgs(argv) {
  const o = { slides: 10, seconds: 5, width: 1280, height: 720, clock: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clock') o.clock = true;
    else if (a.startsWith('--') && a.slice(2) in o) o[a.slice(2)] = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}
