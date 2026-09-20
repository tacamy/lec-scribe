// 動画 fixture の世代と、生成時の引数の印。make-slides.mjs と scripts/smoke-extension.mjs の両方が使う。
// make-slides.mjs 本体は読み込むだけで chromium を起動するので、突き合わせに要る値だけをこの小さな module に置く。

/** 描画内容を変えたら上げる。スモークテストは古い世代の動画を作り直す */
export const FIXTURE_VERSION = 4;

/**
 * `fixtures/slides.webm.version` に書く印。世代だけでなく生成時の引数も残す。
 * スモークテストの時刻の確認は枚数・秒数・大きさに合わせてあるので、`pnpm fixtures:make`
 * （既定の 10 枚 × 5 秒）で作った動画が世代だけ合って使い回されると、確認が落ちる
 */
export function fixtureStamp({ slides, seconds, width, height }) {
  return `${FIXTURE_VERSION} ${slides}x${seconds}s ${width}x${height}`;
}
