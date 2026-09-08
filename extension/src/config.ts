/**
 * User-adjustable settings. Persisted in chrome.storage.local under `config`.
 * Only the sections needed by the phases implemented so far are declared;
 * see docs/SPEC.md Appendix A for the full planned shape.
 */
export type Config = {
  audio: {
    /** Route captured tab audio back to the default output device (AirPods etc.). */
    passthrough: boolean;
    /** Opus bitrate for the recording (Phase 2). */
    bitsPerSecond: number;
    /** MediaRecorder timeslice (Phase 2). */
    timesliceMs: number;
  };
};

export const DEFAULT_CONFIG: Config = {
  audio: {
    passthrough: true,
    bitsPerSecond: 64_000,
    timesliceMs: 10_000,
  },
};

const STORAGE_KEY = 'config';

/** Shallow-merge stored overrides onto the defaults, section by section. */
export function mergeConfig(base: Config, override: unknown): Config {
  if (!override || typeof override !== 'object') return structuredClone(base);
  const o = override as Partial<Record<keyof Config, unknown>>;
  const out = structuredClone(base);
  for (const key of Object.keys(base) as (keyof Config)[]) {
    const section = o[key];
    if (section && typeof section === 'object') {
      out[key] = { ...out[key], ...(section as object) } as Config[typeof key];
    }
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
