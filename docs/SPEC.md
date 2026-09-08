# LecScribe 仕様書 v0.3

大学講義動画（大学サイトに埋め込まれた HTML5 / Brightcove 動画）を Chrome で再生しながら、音声をローカル録音し、スライドが切り替わったときだけ動画領域のスクリーンショットを保存し、講義終了後に Mac 上の WhisperKit で日本語文字起こしを行い、スライドと文字起こしを時間軸で統合した講義ノートを生成する。

本書は原案 v0.1（[spec-v0.1-original.md](./spec-v0.1-original.md)）を技術検証したうえで改訂したもの。原案から変えた点・確定した点は §5 に、未決事項は §20 にまとめる。実装時は本書を正とする。

改訂履歴:

- v0.3（2026-09-08）: 未決事項への回答を反映。前面タブ前提にしてバックグラウンド対策を MVP から外し、MVP の tabCapture を音声のみに簡素化。crop 経路と iframe 権限フローは将来項目へ。再生速度 1.0x、既定モデル `large-v3`、サーバーは Node.js + TypeScript、出力先 `~/LecScribe` を確定。実サイトの `<video>` が同一ページ内の MSE（`blob:`）再生であることを確認。
- v0.2（2026-09-08）: 原案 v0.1 を技術検証して改訂。

凡例: ✅ 一次情報で確認済み ／ ⚠️ 実機での確認が必要（該当 Phase で検証する）

---

## 1. 目的

原案 §1 を踏襲する。

1. 動画の音声を取得し、日本語で文字起こしする
2. 録音中も AirPods 等から通常どおり音声を聞ける
3. 動画プレイヤー領域だけを対象に、画面が大きく変化したときだけスクリーンショットを保存する
4. 文字起こしとスクリーンショットを動画時間に紐付ける
5. 音声・画像を外部クラウドへ送信せず、Mac 上で処理する

v0.2 で追加した目的:

6. サーバーが起動していなくても、Chrome が落ちても、録音済みデータを失わない
7. スライド画像と、そのスライドについて話している内容を並べた講義ノート（`lecture.md`）を生成する

---

## 2. 想定環境

| 項目 | 内容 |
|---|---|
| OS | macOS 14 Sonoma 以降（WhisperKit の要件 ✅）、Apple Silicon |
| 開発機 | MacBook Pro（Apple M3 Max、64 GB） |
| ブラウザ | Chrome 安定版（Manifest V3、offscreen API） |
| 対象動画 | 大学サイト上の HTML5 動画。Brightcove Player（video.js ベース、`<video class="vjs-tech">`）を第一想定 |
| 言語 | 日本語講義 |
| 音声出力 | macOS の既定出力デバイス（内蔵スピーカー、AirPods 等） |
| ローカル処理 | Node.js 22 LTS、Homebrew の `whisperkit-cli` と `ffmpeg` |

---

## 3. 基本方針

### 3.1 動画ファイルを直接取得しない

原案 §3.1・§42 をそのまま採用する。m3u8 / blob URL / 署名付き URL / DRM / 認証 / アクセス制御に触れる処理は一切実装しない。取得するのは「ユーザーが Chrome で正当に再生しているタブ」の音声・映像のみ（`chrome.tabCapture`）。

### 3.2 ローカル完結

音声・画像・文字起こしは Mac から出さない。拡張機能が通信する相手は `127.0.0.1` のローカルサーバーだけ。

### 3.3 データを失わない

録音とスライドは録音中から拡張側のストレージ（OPFS）に逐次書き込む。サーバー未起動・処理失敗でも、再送またはエクスポートで回収できる。

### 3.4 段階的に作る

Phase ごとに「完了条件」を満たしてから次へ進む（§19）。

---

## 4. 全体構成

```text
┌─ Chrome ──────────────────────────────────────────────────────────────┐
│  大学サイトのタブ                                                       │
│   ┌─ content script（動画のある frame に注入）───────────────────┐       │
│   │ <video> 検出 / drawImage で変化検知 / 再生イベント記録        │       │
│   │ 前面タブ前提（§8.6）                                        │       │
│   └───────────────┬──────────────────────────────────────────┘       │
│                   │ runtime message（スライドPNG, timeline）            │
│   tabCapture（audio のみ）                                             │
│         │         ▼                                                  │
│   ┌─ offscreen document ──────────────────────────────────────────┐   │
│   │ getUserMedia(streamId)                                         │   │
│   │   ├─ AudioContext → destination（= 既定出力 = AirPods）          │   │
│   │   └─ MediaRecorder（WebM/Opus, 10秒ごと）→ Worker → OPFS 追記     │   │
│   │ スライド PNG / slides.json / timeline.json も OPFS へ             │   │
│   │ Stop 後: 127.0.0.1 のサーバーへアップロード、進捗を取得            │   │
│   └───────────────────────────────────────────────────────────────┘   │
│   ┌─ service worker ─┐  ┌─ popup ────────┐  ┌─ options ───────┐        │
│   │ 状態機械 / 配線   │  │ Start / Stop   │  │ token, 閾値 等   │        │
│   └──────────────────┘  └────────────────┘  └─────────────────┘        │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ HTTP（127.0.0.1 のみ、Bearer token）
┌─ Mac ローカルサーバー（Node.js / TypeScript）─▼──────────────────────────┐
│ 受信 → ffmpeg（webm → wav 16kHz mono）→ whisperkit-cli（ja）→ 統合        │
│ → ~/LecScribe/<session>/ { audio, transcript.*, slides/, lecture.md }    │
└───────────────────────────────────────────────────────────────────────┘
```

各コンテキストの責務は §6.2 を参照。

---

## 5. 設計判断（原案からの変更点・確定事項）

### D-01 MV3 のタブキャプチャは「getMediaStreamId + offscreen document」 ✅

- MV3 の service worker には DOM も MediaStream もないため、`chrome.tabCapture.capture()` は使えない。
- service worker で `chrome.tabCapture.getMediaStreamId({ targetTabId })` を呼び、その ID を offscreen document に渡し、そこで `navigator.mediaDevices.getUserMedia()`（`chromeMediaSource: 'tab'`）を実行する。Google 公式サンプル `sample.tabcapture-recorder` と同じ構成。
- offscreen document は拡張あたり同時に 1 つ。`reasons: ['USER_MEDIA']`。offscreen document で使える拡張 API は `chrome.runtime` のみ ✅。
- streamId は取得後すみやかに 1 回だけ使う。MVP は音声のみを要求する（D-03）。

### D-02 AirPods への音声パススルーは Web Audio で行う ✅（二重再生の有無は Phase 1 で確認 ⚠️）

- offscreen document 内で `MediaStreamAudioSourceNode → AudioContext.destination`。macOS の既定出力（AirPods）に出る。
- タブキャプチャ中はタブ音声がローカル再生されないため必要（公式サンプルも同じ処置）。
- 万一「二重に聞こえる」場合に備え、設定 `audio.passthrough: true | false` を持つ。
- `AudioContext` は生成後に `resume()` を呼ぶ（suspended 対策）。

### D-03 スライド用フレームは content script が `<video>` 要素を直接 drawImage して取得する（原案からの主要変更）

原案は tabCapture の映像を座標で crop する方式だった。v0.3 では `<video>` を直接読む方式のみを MVP に採用し、tabCapture は音声のみで開始する。

| | 採用: content script が `<video>` を canvas に drawImage | 将来: tabCapture video を crop |
|---|---|---|
| 解像度 | 動画ネイティブ（実サイトは 1280×720 の見込み） | 表示サイズ × DPR に依存 |
| プレイヤー UI / カーソル / 字幕オーバーレイ | 映らない | 映る（除外処理が必要） |
| fullscreen / zoom / リサイズ / スクロール | 影響なし | 座標再計算が必要 |
| 動画が viewport 外 | 取得できる | 取得できない |
| cross-origin 動画（CORS ヘッダなしの直リンク） | canvas が tainted になり不可 | 可 |
| タブがバックグラウンド | フレームが更新されない（前面タブ前提、§8.6） | キャプチャ中は描画が継続する見込み |

- 実サイトの `<video>` は `src="blob:https://<大学ドメイン>/…"` の MSE 再生であることを確認済み（Q-02）。MediaSource 経由の動画は同一オリジン扱いのため canvas は tainted にならない見込み ⚠️（Phase 4 で確認）。
- Start 時の probe で「1×1 の drawImage → getImageData が SecurityError を投げるか」「`video.mediaKeys` があるか」を調べ、どちらかに該当すればスライド機能を無効化して音声のみ続行する（§8.5）。
- **前面タブ前提**: バックグラウンド対策（tabCapture 映像の crop 経路）は座標変換・コントロールバー除外・DPR 対応が必要で効果も未検証のため、MVP から外す（ユーザー判断、Q-03）。タブが非表示になった場合は警告し、復帰後の差分検知で回復する。
- これにより原案 §15（再生バー・カーソル等の除外）と §36（座標更新）は不要になる。crop 経路が必要になった場合の設計は v0.2 の本節と §8.4 を参照する。

### D-04 「録音時刻 ⇄ 動画時刻」のタイムラインを新設（原案の欠落）

- 文字起こしの時刻は「録音開始からの経過秒」、スクショの時刻は `video.currentTime`。一時停止・シーク・再生速度変更・バッファリングがあると両者はずれる。原案にはこの対応がない。
- content script が `play / pause / seeked / ratechange / waiting / playing / ended` と 10 秒ごとの tick を `{ t, videoTime, rate, state }` として記録し、`timeline.json` に保存する（§10）。
- 統合時に区分線形写像で「録音時刻 → 動画時刻」を変換し、字幕（SRT / VTT）は動画時刻基準で出力する。
- スクショには `videoTime` と `t`（録音時刻）の両方を記録する。

### D-05 再生速度は 1.0x を推奨し、それ以外は警告する

- 1.5x などで録音した音声は Whisper の精度が落ちる。MVP では popup に警告を出すにとどめる。
- 将来: timeline の `rate` を使い、サーバー側で ffmpeg `atempo` により 1.0x に正規化する。
- ユーザー判断（Q-04）: 視聴は 1.0x で行う。2x では時間圧縮された音声になり誤認識が目立つ。録音後に伸長し直す案も二重の時間伸縮で劣化するため採用しない。

### D-06 録音中の保存先は拡張の OPFS（Origin Private File System）

- `MediaRecorder` の `timeslice`（10 秒）ごとのチャンクを、offscreen document 配下の Worker が `createSyncAccessHandle()` で `audio.webm` に追記し、都度 `flush()` する。`createWritable()` は `close()` まで実体に反映されないため、長時間録音には使わない。
- スライド PNG、`slides.json`、`timeline.json` も同じセッションディレクトリに書く。
- サーバーへの送信は Stop 後。録音中はサーバーが不要。

### D-07 最終成果物の書き出し主体は Mac ローカルサーバー

- `~/LecScribe/<日時>_<タイトル>/` に集約する。
- `chrome.downloads` によるエクスポートはフォールバック兼 Phase 2 / 6 の動作確認手段。

### D-08 音声形式は WebM/Opus、サーバー側で ffmpeg により WAV 16 kHz mono へ変換 ✅

- Chrome の `MediaRecorder` は `audio/webm;codecs=opus` が既定。`whisperkit-cli` の入力は wav / mp3 / m4a / flac ✅ のため変換が必須。
- Chrome の WebM は duration ヘッダを持たない ✅ が、ffmpeg のデコードには支障ない。
- 代替案（AudioWorklet で直接 WAV 16 kHz を書く）は ffmpeg 依存をなくせるが実装量が増えるため見送り。

### D-09 iframe 対応は MVP から外す（実サイトは同一ページ内の `<video>`）✅

- 実サイトでは `document.querySelector('video')` で `<video id="…_html5_api" class="vjs-tech">` が取得できることを確認済み（Q-01）。Brightcove の in-page embed で、iframe ではない。
- MVP は `activeTab + chrome.scripting.executeScript({ allFrames: true })` のみ。`optional_host_permissions` は宣言しない。
- 将来 cross-origin iframe 内の動画に対応する場合: `activeTab` は cross-origin iframe への注入を許可しない ✅ ため、popup がその `src` のオリジンに対して `chrome.permissions.request({ origins })` を行い（`optional_host_permissions`、ユーザー操作中に限る）、再注入する。

### D-10 localhost 認証は「サーバー生成トークン + Origin 検査」（原案の向きを反転）

- 原案（拡張がトークンを生成してサーバーへ渡す）では、他の Web サイトも同じ手順を踏めるため防御にならない。
- サーバーが初回起動時にランダムトークンを生成して `~/.lec-scribe/token` に保存し、端末に表示する。ユーザーが拡張の Options に 1 回貼り付ける。
- サーバーは `Authorization: Bearer <token>` と `Origin: chrome-extension://…` を検査し、`127.0.0.1` のみで listen する。

### D-11 技術スタック

- モノレポ（pnpm workspaces）: `extension/`（WXT + TypeScript）、`server/`（Node.js 22 + TypeScript、ランタイム依存なし）、`docs/`、`fixtures/`。
- 拡張とサーバーを同じ言語にして保守しやすくする。WXT は MV3 のマニフェスト生成と HMR を備え、offscreen document は unlisted page として、content script は `registration: 'runtime'` として扱える ⚠️（Phase 0 で確認）。
- テスト: Vitest（変化検知、タイムライン写像、SRT / VTT 生成などの純粋関数）。E2E: Playwright + ローカル fixture ページ（Phase 3〜6）。tabCapture を伴う Phase 1・2・7・8 は Mac で手動確認する（[CHECKS.md](./CHECKS.md)）。
- ユーザー確認済み（Q-07）。

### D-12 UI は popup。状態は offscreen document と `chrome.storage.session` に持つ

- popup はフォーカスを失うと閉じるため、状態の正本にしない。service worker も 30 秒で停止しうる。
- 将来的に Side Panel（常時表示、直近スライドのサムネイル表示）への移行を検討する。

### D-13 `lecture.md` を MVP（Phase 8）に含める

原案では将来機能だが、統合処理ができていれば追加コストが小さく、最も価値の高い成果物のため。

### D-14 スライドと文字起こしの対応は「セグメント開始時点で表示中のスライド」

原案の「最も近い時刻」ではなく、`slide.videoTime <= segment.videoStart` を満たす最後のスライドに紐付ける。話している最中に切り替わった場合は開始時点のスライドに属する。

---

## 6. Chrome 拡張

### 6.1 manifest（案）

```jsonc
{
  "manifest_version": 3,
  "name": "LecScribe",
  "version": "0.1.0",
  "permissions": [
    "tabCapture",   // getMediaStreamId
    "offscreen",    // offscreen document
    "activeTab",    // Start を押したタブへの一時アクセス
    "scripting",    // content script の動的注入
    "storage",      // 設定と実行状態
    "downloads"     // エクスポート（フォールバック）
  ],
  "host_permissions": ["http://127.0.0.1/*"],
  "action": { "default_popup": "popup.html" },
  "background": { "service_worker": "background.js", "type": "module" },
  "options_ui": { "page": "options.html", "open_in_tab": true }
}
```

- `content_scripts` は宣言しない。常時注入せず、Start 時に `activeTab` の範囲で注入する。
- `<all_urls>` や `optional_host_permissions` は要求しない。
- permission は Phase ごとに必要になった時点で追加する（Phase 1 時点: `tabCapture` / `offscreen` / `activeTab` / `storage`）。

### 6.2 コンテキストと責務

| コンテキスト | 責務 | 寿命・注意 |
|---|---|---|
| popup | Start / Stop、状態表示、権限要求 UI、再送 / エクスポート / 破棄 | 閉じると消える。`storage.session` の変更を購読して描画する |
| service worker | 状態機械、streamId 取得、content script 注入、offscreen 作成、メッセージ配線、タブの閉鎖・遷移監視 | 30 秒で停止しうる。状態は `storage.session` に置き、起動時に復元する |
| offscreen document | `getUserMedia`、AudioContext パススルー、MediaRecorder、OPFS 書き込み、サーバーへのアップロードと進捗取得 | 録音の正本。使える拡張 API は `chrome.runtime` のみ |
| content script | `<video>` 検出と probe、フレーム取得と変化検知、タイムライン記録、非表示検知 | ページ遷移で消える。動画のある frame にだけ注入する |
| options | サーバーポート / トークン、検知パラメータ、音声設定 | `storage.local` |

### 6.3 Start シーケンス

1. popup: 現在のタブを取得し、service worker に `START { tabId }` を送る
2. service worker: 進行中セッションがあれば拒否する（同時 1 セッション）
3. service worker: `chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probe })` を実行。戻り値は frame ごとの `{ frameId, result }` で、各 frame の `<video>` 候補（§6.6 `VideoCandidate`）と cross-origin `<iframe>` の `src` 一覧が得られる
4. 候補が皆無なら `NO_VIDEO` エラー（cross-origin iframe 内の動画は MVP 非対応、D-09）
5. service worker: 候補のうち最良の 1 つ（§8.1）を選び、その `frameId` にだけ検知用 content script を注入する
6. service worker: `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification })`（既存があれば再利用）
7. service worker: `chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })` → offscreen に `CAPTURE_START { sessionId, streamId, config }`
8. offscreen: `getUserMedia` → AudioContext パススルー → OPFS にセッションディレクトリ作成 → `MediaRecorder.start(timeslice)` → `recorderStartEpochMs = Date.now()` を返す
9. service worker → content script: `DETECT_START { sessionId, config, recorderStartEpochMs }`
10. content script: timeline に `start` を記録し、初回スライドを保存し、サンプリングを開始する
11. service worker: 状態を `CAPTURING` にして `storage.session` を更新 → popup が反映する

6〜9 の途中で失敗した場合は offscreen を閉じ、状態を `ERROR` にする。

### 6.4 Stop シーケンス

1. popup → service worker: `STOP`
2. service worker → content script: `DETECT_STOP`（timeline に `stop` を記録し、サンプリングを停止）
3. service worker → offscreen: `CAPTURE_STOP`。`MediaRecorder.stop()` → 最終チャンクを書き込み → トラック停止 → `status.json` を `captured` に
4. 状態 `UPLOADING`: offscreen が `GET /health` → `POST /sessions` → 音声・スライド・timeline を PUT → `POST /sessions/:id/finalize`
5. 状態 `PROCESSING`: `GET /sessions/:id/status` を 2 秒ごとにポーリング → `done` で `COMPLETED`（出力ディレクトリを表示）
6. 失敗時: `ERROR`。データは OPFS に残り、popup から「再送」「エクスポート」「破棄」を選べる

自動停止: 対象タブが閉じられた、またはキャプチャトラックが `ended` になった場合は Stop と同じ処理を自動で行う。ページ遷移（content script 消失）の場合は録音を継続しつつ「動画ページから移動しました」と警告し、スライド検知だけ停止する。

### 6.5 状態機械

```text
IDLE → STARTING → CAPTURING → STOPPING → UPLOADING → PROCESSING → COMPLETED
                                              │            │
                                              └────────────┴──→ ERROR ─(再送)→ UPLOADING
                                                                      └─(エクスポート / 破棄)→ IDLE
```

原案の 5 状態（IDLE / CAPTURING / PROCESSING / COMPLETED / ERROR）に `STARTING / STOPPING / UPLOADING` を追加する。`storage.session` に保存する内容:

```ts
type SessionState = {
  state: 'IDLE' | 'STARTING' | 'CAPTURING' | 'STOPPING' | 'UPLOADING' | 'PROCESSING' | 'COMPLETED' | 'ERROR';
  sessionId?: string;
  tabId?: number;
  title?: string;
  startedAt?: string;          // ISO 8601
  slideCount: number;
  audioBytes: number;
  frameSource?: 'direct' | 'none';
  warnings: WarningCode[];     // PLAYBACK_RATE, TAB_HIDDEN, SERVER_UNREACHABLE, DRM, NAVIGATED, ...
  progress?: { stage: string; percent?: number };
  outputDir?: string;
  error?: { code: ErrorCode; message: string };
};
```

### 6.6 メッセージ定義（抜粋）

すべて `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` の JSON。offscreen document と service worker は同じ `onMessage` を受けるため、`target: 'sw' | 'offscreen' | 'content' | 'popup'` で宛先を区別する。content script 宛は `chrome.tabs.sendMessage(tabId, msg, { frameId })` で frame を指定する。

```ts
// popup → sw
{ type: 'START', tabId } | { type: 'STOP' } | { type: 'RETRY_UPLOAD' } | { type: 'EXPORT' } | { type: 'DISCARD' }

// sw → content
{ type: 'DETECT_START', sessionId, config, recorderStartEpochMs }
{ type: 'DETECT_STOP' }

// content → offscreen
{ type: 'SLIDE', sessionId, seq, videoTime, t, capturedAt, width, height, mime, dataBase64 }
{ type: 'TIMELINE_EVENT', sessionId, event: TimelineEvent }
{ type: 'DETECT_STATUS', frameSource, lastFrameAt, playbackRate, visibility }

// sw → offscreen
{ type: 'CAPTURE_START', sessionId, streamId, config }             // → { recorderStartEpochMs }
{ type: 'CAPTURE_STOP' }
{ type: 'UPLOAD', sessionId } | { type: 'EXPORT', sessionId } | { type: 'DISCARD', sessionId }

// offscreen → sw
{ type: 'CAPTURE_STATS', audioBytes, slideCount }
{ type: 'UPLOAD_PROGRESS', stage, percent }
{ type: 'CAPTURE_ERROR', code, message }
```

`VideoCandidate`（probe の戻り値）:

```ts
type VideoCandidate = {
  frameId: number;            // executeScript の結果に付く frameId
  selector: string;           // 再取得用
  videoWidth: number; videoHeight: number;
  rect: DOMRect;              // CSS px、viewport 基準
  currentTime: number; paused: boolean; playbackRate: number; readyState: number;
  taintFree: boolean;         // 1×1 drawImage → getImageData が成功したか
  drm: boolean;               // video.mediaKeys != null
  src: string;                // blob: か https: か（判定材料）
};
```

バイナリ（PNG）は base64 文字列で送る。1 枚あたり数百 KB〜2 MB、分間数枚のため許容範囲。

---

## 7. 音声キャプチャ・録音

### 7.1 getUserMedia

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  video: false,
} as MediaStreamConstraints);
```

- 映像は要求しない（D-03）。streamId は 1 回しか使えないため、将来 crop 経路を追加する場合は Start 時点で `video` を含めて要求する必要がある。
- 型定義上 `mandatory` は非標準のためキャストする。

### 7.2 パススルー

```ts
const ctx = new AudioContext();
ctx.createMediaStreamSource(stream).connect(ctx.destination);
await ctx.resume();
```

### 7.3 録音

- `new MediaRecorder(new MediaStream(stream.getAudioTracks()), { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64_000 })`
- `start(10_000)`。`ondataavailable` のチャンクを Worker へ転送し、OPFS の `audio.webm` へ追記して `flush()` する。
- timeslice で分割した Blob を順に連結したものは 1 本の WebM として有効（先頭チャンクにヘッダ、以降はクラスタ）。
- `stop()` 後、最後の `ondataavailable` を書き終えてから `status.json` を更新する。
- 動画が一時停止中も録音は止めない（無音区間は文字起こし側の VAD が処理する）。時刻の対応は timeline で取る。

### 7.4 データ量の目安（180 分）

| 種別 | サイズ |
|---|---|
| audio.webm（Opus 64 kbps） | 約 85 MB |
| audio.wav（16 kHz mono 16 bit、サーバー側の一時ファイル） | 約 345 MB |
| スライド PNG（1280×720、100〜200 枚） | 約 20〜60 MB |

---

## 8. 動画要素の検出とフレーム取得

### 8.1 検出

優先順位は原案 §34 を踏襲する。

1. `document.querySelectorAll('video')` のうち `readyState >= 2` のもの。再生中を優先し、同点なら面積最大
2. `.vjs-tech`
3. 候補が複数ある場合は最大面積。将来は popup で選択できるようにする

`<video>` の差し替え（プレイリスト遷移など）に備え、`MutationObserver` で消失を検知して再検出する。

### 8.2 probe

§6.6 の `VideoCandidate` を返す。taint 判定は 1×1 の canvas に `drawImage(video, 0, 0, 1, 1)` → `getImageData` が `SecurityError` を投げるかで行う。`readyState < 2` の場合は `loadeddata` を最大 5 秒待つ。

### 8.3 フレーム取得

- 検知用 canvas（既定 160×90、`willReadFrequently: true`）と保存用 canvas（動画ネイティブ解像度、`maxSlideWidth` で縮小）を持つ。
- サンプリングは `video.requestVideoFrameCallback` を使い、`sampleIntervalMs` 間隔に間引く。未対応時は `setInterval`。
- `requestVideoFrameCallback` は一時停止中は発火しないため、原案 §19（一時停止中は検知停止）が自然に満たされる。
- 保存は `canvas.toBlob('image/png')` → base64 → offscreen へ送信。

### 8.4 crop 経路（将来）

MVP では実装しない。必要になった場合は v0.2 §8.4 の設計を採用する: offscreen document が tabCapture の video トラックを取り込み、content script から届く矩形・DPR・viewport サイズで crop し、`.vjs-control-bar` を除外する。

### 8.5 DRM

`video.mediaKeys` が非 null の場合は「DRM 保護動画のためスライド保存は無効」と表示し、音声のみ続行する（音声も取得できない可能性がある）。回避処理は実装しない。

### 8.6 前面タブ前提（バックグラウンド非対応）

- 対象タブは「表示中のウィンドウの前面タブ」に置く。macOS では Chrome のウィンドウが他のウィンドウで完全に隠れると非表示扱いになるため、別アプリで作業する場合はウィンドウを並べる。
- 非表示中は `requestVideoFrameCallback` が止まりフレームが更新されない。`visibilitychange` で hidden になった、または `playing` 状態なのに 5 秒以上フレームが来ない場合は `TAB_HIDDEN` を警告する。
- 復帰後は最後に保存した画像との差分で不足分を保存するため、スライドの取りこぼしは起きにくい。ただしそのスライドの `videoTime` は切り替え時刻ではなく復帰時刻になる。
- 録音とタイムライン記録は非表示中も継続する（音声再生中のタブはタイマー抑制の対象外 ✅）。

---

## 9. 変化検知

### 9.1 パラメータ

| 名前 | 既定 | 意味 |
|---|---|---|
| `sampleIntervalMs` | 500 | サンプリング間隔 |
| `detectWidth` / `detectHeight` | 160 / 90 | 比較用の縮小サイズ |
| `pixelDiffThreshold` | 24 | 画素差（0〜255）がこの値以上なら「変化画素」 |
| `changeThreshold` | 0.05 | 変化画素率がこれ以上なら「変化候補」 |
| `stableThreshold` | 0.01 | 直前サンプルとの差がこれ未満なら「安定」 |
| `stableSamples` | 2 | 連続してこの回数安定したら確定 |
| `maxStabilizeMs` | 3000 | 安定待ちの上限。超えたら現フレームで確定 |
| `dedupeThreshold` | 0.03 | 最後に保存した画像との差がこれ未満なら保存しない |
| `minShotIntervalMs` | 2000 | 保存間隔の下限 |
| `imageFormat` / `jpegQuality` | png / 0.9 | 保存形式 |
| `maxSlideWidth` | 0（無制限） | 保存画像の幅上限 |

### 9.2 手順

```text
sample()                                   // sampleIntervalMs ごと
  gray = grayscale(resize(frame, detectWidth, detectHeight))
  diffPrev = ratio(|gray - prevGray| >= pixelDiffThreshold)
  prevGray = gray
  state == WATCHING:
    diffPrev >= changeThreshold → state = STABILIZING, stabilizeStart = now, stableCount = 0
  state == STABILIZING:
    diffPrev < stableThreshold → stableCount++
    else                       → stableCount = 0
    stableCount >= stableSamples または 経過 >= maxStabilizeMs:
      diffSaved = ratio(|gray - lastSavedGray| >= pixelDiffThreshold)
      diffSaved >= dedupeThreshold かつ 前回保存から minShotIntervalMs 以上 → save()
      state = WATCHING

save()
  lastSavedGray = gray
  full = drawImage(video) → toBlob → SLIDE メッセージ
```

- 初回（`DETECT_START` 直後）は無条件に 1 枚保存する（原案 §18）。
- グレースケール変換は `0.299R + 0.587G + 0.114B`。`ImageData` の走査は `Uint8ClampedArray` を直接扱う。
- `diffRatio(a, b, threshold)` などを純粋関数として切り出し、Vitest で fixture 画像を使って閾値の挙動をテストする。

### 9.3 誤検知対策

- `<video>` を直接読むためプレイヤー UI とカーソルは映らず、対策対象は「講師のカメラ映像（ワイプ）」と「動画内の小さなアニメーション」に絞られる。
- 第 1 段階は上記の全体差分率で運用し、実講義で閾値を調整する。
- 第 2 段階（必要なら）: 画面を 8×8 ブロックに分け、`changeThreshold` を超えたブロック数の割合で判定する。ワイプ内の動きは少数ブロックに閉じるため抑制できる。
- 第 3 段階（将来）: 除外矩形をユーザーが指定できるようにする。

---

## 10. タイムライン

### 10.1 記録

```ts
type TimelineEvent = {
  t: number;          // 録音開始からの秒（(Date.now() - recorderStartEpochMs) / 1000）
  videoTime: number;  // video.currentTime
  rate: number;       // video.playbackRate
  state: 'playing' | 'paused' | 'waiting' | 'ended';
  type: 'start' | 'play' | 'pause' | 'seeked' | 'ratechange' | 'waiting' | 'playing' | 'ended' | 'tick' | 'stop';
};
```

- `Date.now()` は content script と offscreen document で共通の壁時計。`MediaRecorder.start()` 直後の `Date.now()` を `recorderStartEpochMs` とし、録音先頭との誤差は数十 ms 程度と見込む。
- tick は 10 秒ごと（再生中のみ）。バッファリングによる微小な停止やドリフトの上限を抑える。

### 10.2 写像（録音時刻 → 動画時刻）

```text
toVideoTime(t):
  e = t 以下で最後のイベント
  e.state == 'playing' → e.videoTime + (t - e.t) * e.rate
  それ以外            → e.videoTime
```

逆写像（動画時刻 → 録音時刻）はシークで多価になるため、統合ではスクショ側が持つ `t` を使い、文字起こし側だけを動画時刻へ変換する。

### 10.3 単体テスト

一時停止、シーク（前後）、速度変更、停止中の tick を含むケースで `toVideoTime` を検証する。

---

## 11. ローカル保存とエクスポート

### 11.1 OPFS レイアウト（拡張オリジン）

```text
sessions/<sessionId>/
├── session.json     // title, url, startedAt, config, frameSource
├── audio.webm       // 追記
├── slides/slide_001.png ...
├── slides.json      // SlideMeta[]
├── timeline.json    // TimelineEvent[]
└── status.json      // { stage: 'capturing' | 'captured' | 'uploaded' | 'done' | 'error', ... }
```

`sessionId` は `YYYYMMDD-HHmmss-<random4>`。

### 11.2 エクスポート

`chrome.downloads.download()` で `~/Downloads/LecScribe/<sessionId>/` 配下に各ファイルを保存する（`saveAs: false`）。サーバーが使えないときの回収手段であり、Phase 2 / 6 の動作確認にも使う。

### 11.3 破棄・保持

- 「破棄」でセッションディレクトリを削除する。
- サーバー処理が `done` になった後も既定では OPFS に残し、popup の「破棄」で削除する（`storage.autoDeleteAfterDone` で自動削除可）。
- 過去セッションの一覧と操作は popup の「履歴」で行う（MVP では直近 1 件のみでも可）。

---

## 12. Mac ローカルサーバー

### 12.1 起動と設定

```text
pnpm --filter server start -- --port 47321 --out ~/LecScribe --model large-v3
```

| 項目 | 既定 |
|---|---|
| bind | `127.0.0.1` のみ |
| port | 47321 |
| out | `~/LecScribe`（ユーザー確認済み、Q-08） |
| model | `large-v3`（§13.2） |
| token | `~/.lec-scribe/token`（初回起動時に生成して表示） |

起動時に `ffmpeg` と `whisperkit-cli` の存在を確認し、なければ導入コマンドを表示して終了する。

### 12.2 API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/health` | `{ ok, version, ffmpeg, whisperkit, model }` |
| POST | `/sessions` | `session.json` 相当を受け取りディレクトリを作成 |
| PUT | `/sessions/:id/audio` | `audio.webm`（`application/octet-stream`、ストリーム書き込み） |
| PUT | `/sessions/:id/slides/:name` | PNG / JPEG |
| PUT | `/sessions/:id/slides.json`, `/sessions/:id/timeline.json` | メタデータ |
| POST | `/sessions/:id/finalize` | パイプライン開始（非同期、キューは同時 1 件） |
| GET | `/sessions/:id/status` | `{ stage, percent?, outputDir?, error? }` |

`stage`: `queued → converting → transcribing → merging → done | error`

### 12.3 認証・通信

- `Authorization: Bearer <token>` 必須。不一致は 401。
- `Origin` が `chrome-extension://` で始まらない、または `Host` が `127.0.0.1:<port>` でない場合は 403。
- CORS / Private Network Access: 拡張ページからの fetch は `host_permissions` があれば CORS の対象外の見込みだが、念のため preflight に `Access-Control-Allow-Origin: <Origin>` と `Access-Control-Allow-Private-Network: true` を返す ⚠️（Phase 7 で確認）。
- 外部ネットワークへの接続はしない。

### 12.4 パイプライン

```text
audio.webm
  → ffmpeg -y -i audio.webm -vn -ac 1 -ar 16000 -c:a pcm_s16le audio.wav
  → whisperkit-cli transcribe --audio-path audio.wav --model <model> --language ja
       --chunking-strategy vad --skip-special-tokens --report --report-path <dir>
  → report JSON を transcript.json に正規化（録音時刻）
  → timeline で動画時刻を付与
  → transcript.txt / .srt / .vtt（動画時刻基準）
  → slides.json と突き合わせて lecture.md
  → session.json に完了情報を追記、audio.wav は削除（keepWav 設定で保持可）
```

処理中の進捗は `whisperkit-cli --verbose` の出力から推定できれば `percent` に反映し、できなければ stage のみとする。

---

## 13. 文字起こしと統合

### 13.1 whisperkit-cli ✅

- 導入: `brew install whisperkit-cli`（macOS 14 以降）
- 確認済みフラグ: `--audio-path`, `--model`, `--language`, `--report`, `--report-path`, `--chunking-strategy vad`, `--skip-special-tokens`, `--verbose`
- 入力形式: wav / mp3 / m4a / flac
- 注意: 2026 年時点で WhisperKit の CLI は `argmax-cli` へ統合・改名が進んでいる ⚠️。Phase 7 で実コマンド名とフラグを確認し、`server/` の設定で切り替えられるようにする。
- report は `<basename>.json` と `<basename>.srt`。JSON の `segments[].start / end / text` を使う ⚠️（Phase 7 で実出力を確認）。

### 13.2 モデル

| モデル | 用途 |
|---|---|
| `large-v3` | 日本語精度優先（既定。開発機は M3 Max / 64 GB のため速度面の制約は小さい） |
| `large-v3_turbo` | 速度優先。Phase 7 で精度差を実講義で比較して既定を決める |

初回実行時にモデル（数 GB）がダウンロードされる。サーバーの `--warmup` で事前取得できるようにする。

### 13.3 正規化した transcript.json

```json
{
  "language": "ja",
  "model": "large-v3",
  "segments": [
    { "start": 0.0, "end": 8.5, "videoStart": 0.0, "videoEnd": 8.5,
      "text": "今日はデザインについて説明します。", "slide": "slide_001.png" }
  ]
}
```

### 13.4 lecture.md

```markdown
# <講義タイトル>

- 収録: 2026-09-08 10:30
- 元ページ: <URL>

## 00:00:00 slide_001

![slide_001](slides/slide_001.png)

今日はデザインについて説明します。…

## 00:12:34 slide_002
…
```

見出しの時刻は動画時刻。スライドに属するセグメントを結合し、句点で改行する。

---

## 14. 出力ファイル

```text
~/LecScribe/2026-09-08_1030_<タイトル>/
├── session.json
├── audio.webm
├── audio.wav            （既定では処理後に削除）
├── transcript.json
├── transcript.txt
├── transcript.srt
├── transcript.vtt
├── slides/
│   ├── slide_001.png
│   └── ...
├── slides.json
├── timeline.json
└── lecture.md
```

`slides.json` の要素:

```json
{ "filename": "slide_003.png", "seq": 3, "videoTime": 1532.42, "t": 1540.10,
  "capturedAt": "2026-09-08T01:59:56.000Z", "width": 1280, "height": 720, "source": "direct" }
```

---

## 15. UI

### 15.1 popup

```text
┌──────────────────────────────────┐
│ LecScribe                        │
│ ● Capturing  00:42:13            │
│                                  │
│ Audio   ● 録音中  12.3 MB        │
│ Video   ● video.js 1280×720      │
│ Slides  12 枚（最終 00:41:02）   │
│                                  │
│ ⚠ 再生速度 1.5x                  │
│ ⚠ ローカルサーバー未接続         │
│                                  │
│ [ Stop ]                         │
└──────────────────────────────────┘
```

状態別の主ボタン: IDLE = Start、CAPTURING = Stop、UPLOADING / PROCESSING = 進捗表示、COMPLETED = 出力先表示 + 破棄、ERROR = 再送 / エクスポート / 破棄。

### 15.2 options

サーバー（port、token、接続テスト）、音声（bitrate、passthrough）、検知パラメータ（§9.1）、保存（形式、上限幅、自動削除）。

---

## 16. エラー処理

| 事象 | 検出 | 表示 | 復旧 |
|---|---|---|---|
| streamId 取得失敗 / getUserMedia 失敗 | 例外 | 「タブのキャプチャを開始できません」 | offscreen を閉じて IDLE |
| video 要素なし | probe | 「動画が見つかりません」 | 再試行 |
| canvas tainted | probe | 「この動画からはスライドを取得できません」 | 音声のみ続行 |
| DRM | probe | 「スライド保存は無効」 | 音声のみ続行 |
| タブ非表示 | `visibilitychange` / フレーム間隔 | 「タブを前面に表示してください」 | 復帰後に差分で回復 |
| 再生速度 ≠ 1.0 | `ratechange` | 警告 | — |
| タブ閉鎖 / トラック終了 | `tabs.onRemoved` / `track.onended` | 「録音を終了しました」 | 自動 Stop |
| ページ遷移 | content script 消失 | 「動画ページから移動しました」 | 録音継続、検知停止 |
| OPFS 書込失敗 / 容量不足 | 例外 / `navigator.storage.estimate()` | 「保存できません」 | Stop してエクスポート |
| サーバー未接続 | `/health` 失敗 | 「サーバーを起動してください」+ 起動コマンド | 再送 |
| トークン不一致 | 401 | 「トークンを確認してください」 | options へ誘導 |
| ffmpeg / whisperkit 失敗 | 非 0 終了 | stderr 末尾を表示 | 再送（サーバー側で再実行） |

---

## 17. パフォーマンス・長時間対応

- 比較は 160×90 グレースケール（原案 §37）。保存時のみフル解像度。
- 全音声・全フレームを RAM に持たない（timeslice → OPFS、フレームは直前 1 枚のみ保持）。
- 目標: 180 分でスライド 300 枚以下、拡張の常駐メモリ 200 MB 以下 ⚠️（Phase 5 で計測）。
- `navigator.storage.estimate()` で残容量を監視し、1 GB 未満で警告する。

---

## 18. セキュリティ・プライバシー

- 常時注入しない（`activeTab` + 動的注入）。`<all_urls>` を要求しない。
- 通信先は `127.0.0.1` のみ。テレメトリなし。
- サーバーは loopback bind、トークン、Origin 検査（D-10）。
- 出力ディレクトリはユーザーのホーム配下。第三者に配布しない個人学習用途を前提とする。
- 原案 §42 の禁止事項を維持する（§21）。

---

## 19. 開発計画

各 Phase は「完了条件」を満たしてから次へ進む。tabCapture が必要な確認は Mac 実機で行う。

### Phase 0: 足場

- pnpm workspaces、`extension/`（WXT + TS）、`server/`（Node + TS）、`docs/`、`fixtures/`
- lint / format / Vitest / Playwright の設定、GitHub Actions で lint・test・build
- `fixtures/player.html`: `<video class="vjs-tech">` で `fixtures/slides.webm` を再生する。動画は ffmpeg で生成する合成スライド動画（5 秒ごとに切り替わる 10 枚 + 小さく動く矩形でワイプを模す）
- 完了条件: `pnpm build` で拡張がビルドされ、Chrome に unpacked で読み込めてエラーがない

### Phase 1: tabCapture + AirPods パススルー（原案の最重要確認）

- Start で getMediaStreamId → offscreen → getUserMedia → AudioContext。Stop で解放
- 完了条件: 大学サイトの動画を再生中に Start しても AirPods から音が途切れず、二重にも聞こえない ⚠️。Stop 後も再生が続く。手順は [CHECKS.md](./CHECKS.md)

### Phase 2: 録音

- MediaRecorder → Worker → OPFS。Stop でエクスポート（chrome.downloads）
- 完了条件: 10 分録音した `audio.webm` が再生でき、`ffmpeg -i` で読める。Chrome を強制終了しても直前チャンクまで残る

### Phase 3: 動画要素検出

- 動的注入、probe
- 完了条件: fixture と大学サイトの両方で `VideoCandidate` が返る

### Phase 4: フレーム取得

- drawImage によるフレーム取得、taint 判定、DRM 判定、非表示検知
- 完了条件: 大学サイトで動画フレームだけの画像が保存される（tainted にならないことを確認 ⚠️）。fullscreen・ウィンドウ縮小・タブ非表示時の挙動を記録する

### Phase 5: 変化検知

- §9 のアルゴリズムと Vitest。fixture でスライド 10 枚が 10 枚として検出され、ワイプの動きで誤検知しない
- 完了条件: fixture で適合率・再現率とも 100%。実講義 30 分で閾値を調整し、値を `docs/` に記録する

### Phase 6: スライド保存

- 初回保存、重複防止、timeline 記録、`slides.json` / `timeline.json`、エクスポート
- 完了条件: 実講義 1 本でスライド一式と JSON がエクスポートされ、`videoTime` が正しい

### Phase 7: ローカルサーバーと WhisperKit

- サーバー、認証、アップロード、ffmpeg、whisperkit-cli、進捗
- 完了条件: 90 分講義の `audio.webm` から日本語 SRT が生成される。CLI 名 / フラグ / モデル既定を確定して記録する ⚠️

### Phase 8: 統合

- timeline による時刻変換、スライド対応付け、TXT / SRT / VTT / `lecture.md`、popup の完了表示
- 完了条件: 実講義 1 本で `lecture.md` が生成され、スライドと本文の対応が目視で妥当

### 将来

リアルタイム文字起こし、再生速度の正規化（D-05）、除外矩形、Side Panel、要約・キーワード抽出・検索。

---

## 20. 未決事項（要回答・要実機確認）

| ID | 内容 | 状態 |
|---|---|---|
| Q-01 | 実サイトの `<video>` は同一ページ内か、cross-origin iframe 内か | **解決**: 同一ページ内。`document.querySelector('video')` で `id="…_html5_api" class="vjs-tech"` が取れる（D-09） |
| Q-02 | 実サイトの動画が MSE（`blob:` src）か。DRM があるか | **一部解決**: `src` は `blob:https://<大学ドメイン>/…`（MSE）。DRM の有無は Phase 4 の probe（`video.mediaKeys`）で確認 |
| Q-03 | 視聴スタイル（前面タブか、別アプリで作業しながらか） | **解決**: バックグラウンド対策は MVP から外し、前面タブ前提にする（D-03、§8.6） |
| Q-04 | 再生速度 | **解決**: 1.0x で視聴する（D-05） |
| Q-05 | Mac のチップ / メモリ | **解決**: M3 Max / 64 GB。既定モデルは `large-v3`（§13.2） |
| Q-06 | 矩形ユーザー指定を MVP に含めるか | **解決**: 含めない（Q-01 の結果より不要） |
| Q-07 | サーバーの言語 | **解決**: Node.js + TypeScript（D-11） |
| Q-08 | 出力ディレクトリ | **解決**: `~/LecScribe`（§12.1） |
| Q-09 | tabCapture 中のタブが非表示でも `<video>` の drawImage が更新されるか | 優先度低。前面タブ前提のため Phase 4 で挙動を記録するのみ |
| Q-10 | 拡張ページから 127.0.0.1 への fetch に PNA / LNA の制限がかかるか | Phase 7 で確認 ⚠️ |
| Q-11 | WhisperKit CLI の現行コマンド名とフラグ、report JSON の形式 | Phase 7 で確認 ⚠️ |
| Q-12 | パススルーで二重再生が起きないか | Phase 1 で確認 ⚠️（[CHECKS.md](./CHECKS.md)） |

---

## 21. 実装しないこと

原案 §42 を維持する。

- Brightcove の m3u8 を直接取得する処理
- blob URL から動画ファイルを抽出する処理
- Fastly token 等の署名を解析・再利用する処理
- AES-128 等の暗号化ストリームを復号する処理
- DRM 回避、大学サイトの認証回避、アクセス制御回避
- 外部 STT API / 外部ストレージへの送信

---

## 付録 A. 設定値一覧

options で変更でき、`storage.local` に保存する。

```ts
type Config = {
  server: { port: number; token: string };                        // 47321, ''
  audio: { bitsPerSecond: number; timesliceMs: number; passthrough: boolean };  // 64000, 10000, true
  detect: {
    sampleIntervalMs: number; detectWidth: number; detectHeight: number;
    pixelDiffThreshold: number; changeThreshold: number; stableThreshold: number;
    stableSamples: number; maxStabilizeMs: number; dedupeThreshold: number;
    minShotIntervalMs: number; tickIntervalMs: number;
  };
  slide: { imageFormat: 'png' | 'jpeg'; jpegQuality: number; maxSlideWidth: number };
  storage: { autoDeleteAfterDone: boolean; lowSpaceWarnBytes: number };
};
```

## 付録 B. 確認済み事実と出典

| 事実 | 出典 |
|---|---|
| MV3 のタブ録音は getMediaStreamId + offscreen + getUserMedia + AudioContext パススルーで行う | GoogleChrome/chrome-extensions-samples `functional-samples/sample.tabcapture-recorder` |
| offscreen document は同時 1 つ。使える拡張 API は `chrome.runtime` のみ | Chrome 拡張 API リファレンス（offscreen） |
| `activeTab` は cross-origin iframe への注入を許可しない | chromium-extensions グループの議論、Chrome scripting API リファレンス |
| Chrome の MediaRecorder は `audio/webm;codecs=opus` が既定。WebM に duration がない | MDN `MediaRecorder.isTypeSupported`、addpipe のブログ |
| `whisperkit-cli` は `brew install whisperkit-cli`、macOS 14 以降、入力は wav / mp3 / m4a / flac | argmaxinc/WhisperKit README |
| `--language`, `--report`, `--report-path`, `--chunking-strategy vad`, `--skip-special-tokens` | argmaxinc/WhisperKit の issue #211 / #357 と CLI 利用例 |
| 音声再生中のタブはバックグラウンドのタイマー抑制を免除される | Chrome Developers ブログ「Background tabs in Chrome 57」 |
| 実サイトの `<video>` は同一ページ内の Brightcove in-page embed（`class="vjs-tech"`、`src` は `blob:` の MSE、表示 768×432、poster 1280×720） | ユーザーが DevTools で確認（2026-09-08） |
