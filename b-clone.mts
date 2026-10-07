// 写しが APFS のクローンか: 空き容量の変化で見る（du はクローンでも別々に数えるので使えない）
import { readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncSlides } from '/private/tmp/claude-501/-Users-tacamy-repos-lec-scribe/3dab2aca-d521-45e6-a31a-24fe41ccbeef/scratchpad/tidy-wt/server/src/layout.ts';
const dir = process.argv[2]!;
const free = () => Number(execFileSync('df', ['-k', dir], { encoding: 'utf8' }).trim().split('\n')[1]!.split(/\s+/)[3]);
for (const n of readdirSync(`${dir}/slides`)) rmSync(`${dir}/slides/${n}`);
const before = free();
const r = await syncSlides(dir);
const after = free();
const bytes = readdirSync(`${dir}/slides`).reduce((s, n) => s + statSync(`${dir}/slides/${n}`).size, 0);
console.log(`copied ${r?.copied}, files total ${(bytes / 1e6).toFixed(1)} MB, free space change ${((before - after) / 1024).toFixed(1)} MB`);
