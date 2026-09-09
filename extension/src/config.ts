/**
 * ユーザーが変えられる設定。chrome.storage.local の `config` に保存する。
 * 実装済みの Phase で使う項目だけ宣言する。全体像は docs/SPEC.md 付録 A。
 */
export type Config = {
  /** Mac ローカルサーバー（SPEC §12）。paired（設定画面の「このMacと接続」で承認済み）か token があれば送信する */
  server: {
    port: number;
    /** Bearer で送るトークン。「このMacと接続」で承認されたときにサーバーが発行したもの（手で貼ることもできる） */
    token: string;
    /** 「このMacと接続」で承認済み（token はそのとき発行されたもの） */
    paired: boolean;
  };
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
    /**
     * スライドが切り替わる直前の状態（文字が 1 行ずつ出るスライドなら全部出た状態）で画像を上書きする。
     * 保存した画像との差が updateThreshold 以上のときだけ
     */
    finalState: boolean;
    updateThreshold: number;
  };
  /** 画面変化の検知パラメータ（SPEC §9.1） */
  detect: {
    /** サンプリング間隔 */
    sampleIntervalMs: number;
    /** 比較用の縮小サイズ */
    detectWidth: number;
    detectHeight: number;
    /** 画素差（0〜255）がこの値以上なら「変化画素」 */
    pixelDiffThreshold: number;
    /** 変化画素率がこれ以上なら「変化候補」 */
    changeThreshold: number;
    /** 直前サンプルとの差がこれ未満なら「安定」 */
    stableThreshold: number;
    /** 連続してこの回数安定したら確定 */
    stableSamples: number;
    /** 安定待ちの上限。超えたら現フレームで確定 */
    maxStabilizeMs: number;
    /** 最後に保存した画像との差がこれ未満なら保存しない */
    dedupeThreshold: number;
    /** 保存間隔の下限 */
    minShotIntervalMs: number;
    /** 再生中にタイムラインへ定期的に記録する間隔（SPEC §10.1） */
    tickIntervalMs: number;
  };
};

export const DEFAULT_CONFIG: Config = {
  server: {
    port: 47321,
    token: '',
    paired: false,
  },
  audio: {
    passthrough: true,
    bitsPerSecond: 64_000,
    timesliceMs: 10_000,
  },
  slide: {
    imageFormat: 'png',
    jpegQuality: 0.9,
    maxSlideWidth: 0,
    finalState: true,
    // 動き続ける領域は比較から除くので、ワイプの動き（0.4〜0.9%）より下でよい（SPEC §9.2b）
    updateThreshold: 0.004,
  },
  // 閾値は fixture の実測から決めた（SPEC §9.3）:
  // 本文テキストだけが変わるスライドで約 3.2%、講師ワイプの動きで 0.4〜0.9%。
  detect: {
    sampleIntervalMs: 500,
    detectWidth: 160,
    detectHeight: 90,
    pixelDiffThreshold: 24,
    changeThreshold: 0.025,
    stableThreshold: 0.015,
    stableSamples: 2,
    maxStabilizeMs: 3000,
    dedupeThreshold: 0.015,
    minShotIntervalMs: 2000,
    tickIntervalMs: 10_000,
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

/** サーバーに送れる状態か。実際に使うのはトークンなので、承認済みでもトークンを消していれば未接続 */
export function serverEnabled(config: Pick<Config, 'server'>): boolean {
  return config.server.token.length > 0;
}

/** サーバーへの要求に付けるヘッダー */
export function authHeaders(server: { token: string }): Record<string, string> {
  return server.token ? { authorization: `Bearer ${server.token}` } : {};
}

export async function loadConfig(): Promise<Config> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return mergeConfig(DEFAULT_CONFIG, stored[STORAGE_KEY]);
}

export async function saveConfig(config: Config): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}
