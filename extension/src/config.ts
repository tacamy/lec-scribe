/**
 * ユーザーが変えられる設定。chrome.storage.local の `config` に保存する。
 * 実装済みの Phase で使う項目だけ宣言する。全体像は docs/SPEC.md 付録 A。
 */
export type Config = {
  audio: {
    /** キャプチャした音声を既定の出力デバイス（AirPods 等）へ流す */
    passthrough: boolean;
    /** Opus のビットレート */
    bitsPerSecond: number;
    /** MediaRecorder の timeslice */
    timesliceMs: number;
  };
  slide: {
    imageFormat: 'png' | 'jpeg';
    /** imageFormat が jpeg のときの品質（0〜1） */
    jpegQuality: number;
    /** 保存画像の幅の上限。0 なら動画のネイティブ解像度のまま */
    maxSlideWidth: number;
  };
};

export const DEFAULT_CONFIG: Config = {
  audio: {
    passthrough: true,
    bitsPerSecond: 64_000,
    timesliceMs: 10_000,
  },
  slide: {
    imageFormat: 'png',
    jpegQuality: 0.9,
    maxSlideWidth: 0,
  },
};

const STORAGE_KEY = 'config';

/** 保存された上書きを既定値にセクション単位で浅くマージする */
export function mergeConfig(base: Config, override: unknown): Config {
  if (!override || typeof override !== 'object') return structuredClone(base);
  const o = override as Partial<Record<keyof Config, unknown>>;
  const out = structuredClone(base);
  for (const key of Object.keys(base) as (keyof Config)[]) {
    const section = o[key];
    if (section && typeof section === 'object') Object.assign(out[key], section);
  }
  return out;
}

export async function loadConfig(): Promise<Config> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return mergeConfig(DEFAULT_CONFIG, stored[STORAGE_KEY]);
}

export async function saveConfig(config: Config): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}
