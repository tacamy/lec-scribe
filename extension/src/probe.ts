/**
 * 動画ページ内の <video> を探して情報を返す probe（SPEC §8.1, §8.2）。
 *
 * `probeVideos` は chrome.scripting.executeScript の `func` として各 frame で
 * 実行される。関数を文字列化して注入する仕組みなので、この関数の中から
 * モジュール外の変数や import を参照してはいけない。
 */
export type ProbeVideo = {
  /** document.querySelectorAll('video') 内の位置。selector で見つからないときの予備 */
  index: number;
  /** 再取得用のセレクタ（#id / video.vjs-tech / video） */
  selector: string;
  player: 'video.js' | 'html5';
  /** src の先頭 80 文字（blob: か https: かの判定材料） */
  src: string;
  videoWidth: number;
  videoHeight: number;
  rect: { x: number; y: number; width: number; height: number };
  currentTime: number;
  duration: number | null;
  paused: boolean;
  ended: boolean;
  playbackRate: number;
  readyState: number;
  playing: boolean;
  /** 1×1 の drawImage → getImageData が成功したか。readyState < 2 では判定できず null */
  taintFree: boolean | null;
  /** EME（DRM）が使われているか */
  drm: boolean;
};

export type ProbeResult = {
  frameUrl: string;
  visibility: DocumentVisibilityState;
  videos: ProbeVideo[];
  /** ページと異なるオリジンの iframe。MVP では中の動画は扱わない（SPEC D-09） */
  crossOriginIframes: string[];
};

export type VideoCandidate = ProbeVideo & { frameId: number; frameUrl: string };

/** 検知用 content script が録音中に送ってくる動画の状態（SPEC §6.6 DETECT_STATUS） */
export type VideoStatus = {
  selector: string;
  player: 'video.js' | 'html5';
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  duration: number | null;
  paused: boolean;
  ended: boolean;
  playing: boolean;
  playbackRate: number;
  readyState: number;
  /** document.visibilityState === 'visible' */
  visible: boolean;
  /** 直近に映像フレームが描画された時刻（epoch ms）。requestVideoFrameCallback 非対応なら null */
  lastFrameAt: number | null;
  taintFree: boolean | null;
  drm: boolean;
  /** 変化検知の直近の判定（閾値調整の目安。Phase 5） */
  detect?: { state: 'watching' | 'stabilizing'; diffPrev: number; diffSaved?: number };
  updatedAt: number;
};

export function probeVideos(): ProbeResult {
  const videos = Array.from(document.querySelectorAll('video'));
  const vjsCount = videos.filter((v) => v.classList.contains('vjs-tech')).length;

  const describe = (video: HTMLVideoElement, index: number): ProbeVideo => {
    let selector = 'video';
    if (video.id && document.querySelectorAll(`#${CSS.escape(video.id)}`).length === 1) {
      selector = `#${CSS.escape(video.id)}`;
    } else if (video.classList.contains('vjs-tech') && vjsCount === 1) {
      selector = 'video.vjs-tech';
    }

    // MSE（blob:）の動画は同一オリジン扱いで canvas に描ける見込みだが、
    // 直リンクで CORS ヘッダがない場合は tainted になるので実際に試す。
    let taintFree: boolean | null = null;
    if (video.readyState >= 2 && video.videoWidth > 0) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, 1, 1);
          ctx.getImageData(0, 0, 1, 1);
          taintFree = true;
        }
      } catch {
        taintFree = false;
      }
    }

    const rect = video.getBoundingClientRect();
    return {
      index,
      selector,
      player: video.classList.contains('vjs-tech') ? 'video.js' : 'html5',
      src: (video.currentSrc || video.src || '').slice(0, 80),
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      currentTime: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      paused: video.paused,
      ended: video.ended,
      playbackRate: video.playbackRate,
      readyState: video.readyState,
      playing: !video.paused && !video.ended && video.readyState > 2,
      taintFree,
      drm: video.mediaKeys !== null && video.mediaKeys !== undefined,
    };
  };

  const crossOriginIframes: string[] = [];
  for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
    try {
      const origin = new URL(iframe.src, location.href).origin;
      if (origin !== location.origin && origin !== 'null' && !crossOriginIframes.includes(origin)) {
        crossOriginIframes.push(origin);
      }
    } catch {
      // src が空や不正な iframe は無視
    }
  }

  return {
    frameUrl: location.href,
    visibility: document.visibilityState,
    videos: videos.map(describe),
    crossOriginIframes,
  };
}

/**
 * 全 frame の probe 結果から 1 つ選ぶ。
 * 優先順位: readyState >= 2 のもの → 再生中のもの → 表示面積が大きいもの。
 */
export function chooseCandidate(
  frames: Array<{ frameId: number; result: ProbeResult | undefined }>,
): VideoCandidate | undefined {
  const candidates: VideoCandidate[] = [];
  for (const { frameId, result } of frames) {
    if (!result) continue;
    for (const video of result.videos) candidates.push({ ...video, frameId, frameUrl: result.frameUrl });
  }
  const area = (v: VideoCandidate) => Math.max(v.rect.width * v.rect.height, v.videoWidth * v.videoHeight);
  candidates.sort((a, b) => {
    const ready = Number(b.readyState >= 2) - Number(a.readyState >= 2);
    if (ready !== 0) return ready;
    const playing = Number(b.playing) - Number(a.playing);
    if (playing !== 0) return playing;
    return area(b) - area(a);
  });
  return candidates[0];
}
