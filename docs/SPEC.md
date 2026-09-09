# LecScribe 仕様書 v0.5

ページに `<video>` で埋め込まれたスライド動画（Brightcove などの MSE / `blob:` 再生を含む HTML5 動画）を Chrome で再生しながら、音声をローカル録音し、スライドが切り替わったときだけ動画領域のスクリーンショットを保存し、視聴後に Mac 上の WhisperKit で日本語文字起こしを行い、スライドと文字起こしを時間軸で統合したノートを生成する。

本書は原案 v0.1（リポジトリには含めない）を技術検証したうえで改訂したもの。文中の「原案 §n」は v0.1 の節番号を指す。原案から変えた点・確定した点は §5 に、未決事項は §20 にまとめる。実装時は本書を正とする。

改訂履歴:

- v0.6（2026-09-09）: キャプチャの瞬間に動画上へサムネイルのトーストを出す（§15.3）。文字が 1 行ずつ出るスライドを最終状態で上書きする（§9.2b）。`notes.md` / `lecture.md` から「（ノート）」と「（このスライドの間の発話はありません）」を削除（§13.4、§13.5）。Whisper の幻覚区間を除去（§13.2b）。承認フローと Host 検査（D-10、§12.3）、利用者向けの `install.sh`（§12.1）。
- v0.5（2026-09-09）: 出力フォルダを `notes.md` + `slides/` だけに整理し、作業ファイルを `.lecscribe/` へ（§14）。`lecture.md` / `notes.md` の節見出しを廃止（§13.4）。文字起こし中・送信待ちのセッションを「破棄」で中止・削除できるように（§11.3、`POST /sessions/:id/cancel`）。文字起こし中も次の録音を始められ、Stop 後は送信待ちに並ぶ（§6.5）。パネルのボタン名を「フォルダを開く / やり直す / 文字起こしする / 破棄」に（§15.1。「Downloads に書き出す」は後に UI から削除）。
- v0.4（2026-09-09）: Phase 7〜9 の実装で確定した事項を反映。`whisperkit-cli` 1.1.0 のフラグと report の形（§13.1）、モデル比較（`large-v3` を既定に維持）、スライド割り当ての 1.5 秒補正（§13.4）、LLM による `notes.md`（§13.5、`codex exec` / OpenAI API / Ollama）、launchd 常駐（README）。UI は「アイコンのポップアップで Start → サイドパネルで監視」（D-12）。
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
7. スライド画像と、そのスライドについて話している内容を並べたノート（`lecture.md`）を生成する

---

## 2. 想定環境

| 項目 | 内容 |
|---|---|
| OS | macOS 14 Sonoma 以降（WhisperKit の要件 ✅）、Apple Silicon |
| 開発機 | MacBook Pro（Apple M3 Max、64 GB） |
| ブラウザ | Chrome 安定版（Manifest V3、offscreen API） |
| 対象動画 | Web ページに `<video>` で埋め込まれた HTML5 のスライド動画。Brightcove Player（video.js ベース、`<video class="vjs-tech">`）を第一想定 |
| 言語 | 日本語の解説 |
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
│  動画ページのタブ                                                       │
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
│   ┌─ service worker ─┐  ┌─ パネル ────────┐  ┌─ options ───────┐        │
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

### D-02 AirPods への音声パススルーは Web Audio で行う ✅（Phase 1 で実機確認済み: 二重再生なし）

- offscreen document 内で `MediaStreamAudioSourceNode → AudioContext.destination`。macOS の既定出力（AirPods）に出る。
- タブキャプチャ中はタブ音声がローカル再生されないため必要（公式サンプルも同じ処置）。
- 設定 `audio.passthrough: true | false` を持つ。既定は `true` で確定（2026-09-08、Mac 内蔵スピーカーで二重再生なしを確認）。
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

- 実サイトの `<video>` は `src="blob:https://<サイトのドメイン>/…"` の MSE 再生であることを確認済み（Q-02）。MediaSource 経由の動画は同一オリジン扱いのため canvas は tainted にならない見込み ⚠️（Phase 4 で確認）。
- Start 時の probe で「1×1 の drawImage → getImageData が SecurityError を投げるか」「`video.mediaKeys` があるか」を調べ、どちらかに該当すればスライド機能を無効化して音声のみ続行する（§8.5）。
- **前面タブ前提**: バックグラウンド対策（tabCapture 映像の crop 経路）は座標変換・コントロールバー除外・DPR 対応が必要で効果も未検証のため、MVP から外す（ユーザー判断、Q-03）。タブが非表示になった場合は警告し、復帰後の差分検知で回復する。
- これにより原案 §15（再生バー・カーソル等の除外）と §36（座標更新）は不要になる。crop 経路が必要になった場合の設計は v0.2 の本節と §8.4 を参照する。

### D-04 「録音時刻 ⇄ 動画時刻」のタイムラインを新設（原案の欠落）

- 文字起こしの時刻は「録音開始からの経過秒」、スクショの時刻は `video.currentTime`。一時停止・シーク・再生速度変更・バッファリングがあると両者はずれる。原案にはこの対応がない。
- content script が `play / pause / seeked / ratechange / waiting / playing / ended` と 10 秒ごとの tick を `{ t, videoTime, rate, state }` として記録し、`timeline.json` に保存する（§10）。
- 統合時に区分線形写像で「録音時刻 → 動画時刻」を変換し、字幕（SRT / VTT）は動画時刻基準で出力する。
- スクショには `videoTime` と `t`（録音時刻）の両方を記録する。

### D-05 再生速度は 1.0x を推奨し、それ以外は警告する

- 1.5x などで録音した音声は Whisper の精度が落ちる。MVP では パネル に警告を出すにとどめる。
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
- 将来 cross-origin iframe 内の動画に対応する場合: `activeTab` は cross-origin iframe への注入を許可しない ✅ ため、パネル がその `src` のオリジンに対して `chrome.permissions.request({ origins })` を行い（`optional_host_permissions`、ユーザー操作中に限る）、再注入する。

### D-10 localhost 認証は「サーバー生成トークン + Origin 検査」（原案の向きを反転）

- 原案（拡張がトークンを生成してサーバーへ渡す）では、他の Web サイトも同じ手順を踏めるため防御にならない。
- サーバーが初回起動時にランダムトークンを生成して `~/.lec-scribe/token` に保存し、端末に表示する。ユーザーが拡張の Options に 1 回貼り付ける。
- サーバーは `Authorization: Bearer <token>` と `Origin: chrome-extension://…` を検査し、`127.0.0.1` のみで listen する。
- 貼り付けをなくす承認フロー（2026-09-09）: 未接続のときはポップアップ / サイドパネルに出る「このMacと接続」（設定画面にもある）を押すと、service worker が `POST /pair` を送り（ポップアップはダイアログにフォーカスを取られて閉じるため）、サーバーが macOS のダイアログ（osascript）で「Chrome 拡張 xxx が接続を求めています」と確認し、「許可」なら拡張専用のトークンを発行して返す。拡張はそれを保存し、以後 Bearer で送る（承認済みの拡張 ID とトークンは `~/.lec-scribe/trusted.json`）。`/pair` は `Origin` が `chrome-extension://<id>` の要求だけ受け付けるので、Web ページや別の拡張はトークンを受け取れない（Origin はブラウザが付ける）。トークンで認可するのは、host_permissions のある拡張ページからの GET には Origin が付かないため。共有トークンの手貼りも引き続き使える。

### D-11 技術スタック

- モノレポ（pnpm workspaces）: `extension/`（WXT + TypeScript）、`server/`（Node.js 22 + TypeScript、ランタイム依存なし）、`docs/`、`fixtures/`。
- 拡張とサーバーを同じ言語にして保守しやすくする。WXT は MV3 のマニフェスト生成と HMR を備え、offscreen document は unlisted page として、content script は `registration: 'runtime'` として扱える ⚠️（Phase 0 で確認）。
- テスト: Vitest（変化検知、タイムライン写像、SRT / VTT 生成などの純粋関数）。E2E: Playwright + ローカル fixture ページ（Phase 3〜6）。tabCapture を伴う Phase 1・2・7・8 は Mac で手動確認する（[CHECKS.md](./CHECKS.md)）。
- ユーザー確認済み（Q-07）。

### D-12 UI は「アイコンのポップアップで Start → サイドパネルで監視」。状態は offscreen document と `chrome.storage.session` に持つ

- ポップアップはページをクリックした瞬間に閉じるため、録音中に動画を操作しながら状態を見られない。一方 `chrome.tabCapture.getMediaStreamId` は「アイコンをクリックしたその時点のタブ」にだけ許可（`activeTab`）が出て、ページ遷移で失効する。開きっぱなしのサイドパネルから Start すると許可切れで失敗することを実機で確認した（2026-09-08）。
- そこで同じページ（`sidepanel.html`）をポップアップ（`?mode=popup`）とサイドパネルの両方で使う。アイコンのクリックでポップアップが開き（= activeTab 付与）、Start を押すとキャプチャを開始して `chrome.sidePanel.open()` でサイドパネルを開き、ポップアップは閉じる。以降の監視・Stop・エクスポートはパネルで行う。
- パネルの Start は許可が残っている場合のみ成功する。失敗時はアイコンから開始するよう案内する。
- 正本は `chrome.storage.session` と offscreen document。service worker は 30 秒で停止しうる。


サイドパネルは録音を始めたタブにだけ出す（2026-09-09）。Start 時に `sidePanel.setOptions({ tabId, enabled: true })` でそのタブ向けに有効化し、全タブ共通のパネルは起動時に `setOptions({ enabled: false })` で無効にしておく。別のタブでは画面を広く使え、録音の様子はアイコンのポップアップ（同じページ）で見られる。

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
  "action": { "default_パネル": "パネル.html" },
  "background": { "service_worker": "background.js", "type": "module" },
  "options_ui": { "page": "options.html", "open_in_tab": true }
}
```

- `content_scripts` は宣言しない。常時注入せず、Start 時に `activeTab` の範囲で注入する。
- `<all_urls>` や `optional_host_permissions` は要求しない。
- permission は Phase ごとに必要になった時点で追加する（Phase 3 時点: `tabCapture` / `offscreen` / `activeTab` / `storage` / `downloads` / `sidePanel` / `scripting`。host_permissions は `http://127.0.0.1/*` のみで、ローカルサーバーと fixture ページへの注入テストに使う）。

### 6.2 コンテキストと責務

| コンテキスト | 責務 | 寿命・注意 |
|---|---|---|
| side panel | Stop、状態表示、セッション一覧（フォルダを開く / やり直す / 文字起こしする / 破棄）。Start はアイコンのポップアップ（同じページを `?mode=popup` で開く） | ページ操作で閉じない。`storage.session` の変更を購読して描画する |
| service worker | 状態機械、streamId 取得、content script 注入、offscreen 作成、メッセージ配線、タブの閉鎖・遷移監視 | 30 秒で停止しうる。状態は `storage.session` に置き、起動時に復元する |
| offscreen document | `getUserMedia`、AudioContext パススルー、MediaRecorder、OPFS 書き込み、サーバーへのアップロードと進捗取得 | 録音の正本。使える拡張 API は `chrome.runtime` のみ |
| content script | `<video>` 検出と probe、フレーム取得と変化検知、タイムライン記録、非表示検知 | ページ遷移で消える。動画のある frame にだけ注入する |
| options | サーバーポート / トークン、検知パラメータ、音声設定 | `storage.local` |

### 6.3 Start シーケンス

1. パネル: 現在のタブを取得し、service worker に `START { tabId }` を送る
2. service worker: 進行中セッションがあれば拒否する（同時 1 セッション）
3. service worker: `chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probe })` を実行。戻り値は frame ごとの `{ frameId, result }` で、各 frame の `<video>` 候補（§6.6 `VideoCandidate`）と cross-origin `<iframe>` の `src` 一覧が得られる
4. 候補が皆無なら警告 `NO_VIDEO` を付けて音声のみ録音する（エラーにはしない。cross-origin iframe 内の動画は MVP 非対応で、iframe があれば `CROSS_ORIGIN_IFRAME` も付ける。D-09）
5. service worker: `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification })`（既存があれば再利用）
6. service worker: `chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })` → offscreen に `CAPTURE_START { streamId, config, meta }`
7. offscreen: `getUserMedia` → AudioContext パススルー → OPFS にセッションディレクトリ作成 → `MediaRecorder.start(timeslice)` → `recorderStartEpochMs = Date.now()` を返す
8. service worker: 候補のうち最良の 1 つ（§8.1）を選び、その `frameId` にだけ検知用 content script（`detector.js`）を `chrome.scripting.executeScript({ files })` で注入する。失敗しても録音は続け、警告 `NO_VIDEO` を付ける
9. service worker → content script: `DETECT_START { sessionId, selector, index, recorderStartEpochMs }` → 応答の `VideoStatus` を状態に保存する
10. content script: timeline に `start` を記録し、初回スライドを保存し、サンプリングを開始する
11. service worker: 状態を `CAPTURING` にして `storage.session` を更新 → パネル が反映する

6〜9 の途中で失敗した場合は offscreen を閉じ、状態を `ERROR` にする。

### 6.4 Stop シーケンス

1. パネル → service worker: `STOP`
2. service worker → content script: `DETECT_STOP`（timeline に `stop` を記録し、サンプリングを停止）
3. service worker → offscreen: `CAPTURE_STOP`。`MediaRecorder.stop()` → 最終チャンクを書き込み → トラック停止 → `status.json` を `captured` に
4. 状態 `UPLOADING`: offscreen が `GET /health` → `POST /sessions` → 音声・スライド・timeline を PUT → `POST /sessions/:id/finalize`
5. 状態 `PROCESSING`: `GET /sessions/:id/status` を 2 秒ごとにポーリング → `done` で `COMPLETED`（出力ディレクトリを表示）
6. 失敗時: `ERROR`。データは OPFS に残り、パネルの一覧から「文字起こしする」（再送）「破棄」を選べる
7. 処理中（`UPLOADING` / `PROCESSING`）に別のセッションを Stop したとき、または一覧で「文字起こしする / やり直す」を押したときは `pendingUploads` に積み、前の処理が終わり次第順に送る（何件でも並べられる）。処理中・送信待ちのセッションを「破棄」すると `POST /sessions/:id/cancel { delete: true }` で中止・削除し、次の送信待ちを始める

自動停止: 対象タブが閉じられた、またはキャプチャトラックが `ended` になった場合は Stop と同じ処理を自動で行う。ページ遷移（content script 消失）の場合は録音を継続しつつ「動画ページから移動しました」と警告し、スライド検知だけ停止する。

### 6.5 状態機械

```text
IDLE → STARTING → CAPTURING → STOPPING → UPLOADING → PROCESSING → COMPLETED
                                              │            │
                                              └────────────┴──→ ERROR ─(文字起こしする)→ UPLOADING
                                                     │                └─(破棄)→ IDLE
                                                     └─(破棄: サーバーに cancel + delete)→ COMPLETED / IDLE
```

`UPLOADING` / `PROCESSING` の間も `Start` は押せる（録音側の状態が優先され、Server 行に処理の段階を出す）。Stop したセッションは送信待ち（`pendingUploads`）に並ぶ。

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

すべて `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage` の JSON。offscreen document と service worker は同じ `onMessage` を受けるため、`target: 'sw' | 'offscreen' | 'content' | 'パネル'` で宛先を区別する。content script 宛は `chrome.tabs.sendMessage(tabId, msg, { frameId })` で frame を指定する。

```ts
// パネル → sw
{ type: 'START', tabId } | { type: 'STOP' } | { type: 'RETRY_UPLOAD' } | { type: 'EXPORT' } | { type: 'DISCARD' }

// sw → content
{ type: 'DETECT_START', sessionId, selector, index, recorderStartEpochMs }   // chrome.tabs.sendMessage(tabId, msg, { frameId })
{ type: 'DETECT_STOP' }

// content → offscreen
{ type: 'SLIDE', sessionId, seq, videoTime, t, capturedAt, width, height, mime, dataBase64 }
{ type: 'TIMELINE_EVENT', sessionId, event: TimelineEvent }
{ type: 'DETECT_STATUS', sessionId, status: VideoStatus }   // content → sw。再生イベント時と 5 秒ごと

// popup → sw（Start 前の表示用）
{ type: 'PROBE', tabId }   // → { probe: { chosen?: VideoCandidate, videoCount, frames, crossOriginIframes } }

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
3. 候補が複数ある場合は最大面積。将来は パネル で選択できるようにする

`<video>` の差し替え（プレイリスト遷移など）に備え、`MutationObserver` で消失を検知して再検出する。

### 8.2 probe

§6.6 の `VideoCandidate` を返す。taint 判定は 1×1 の canvas に `drawImage(video, 0, 0, 1, 1)` → `getImageData` が `SecurityError` を投げるかで行う。`readyState < 2` の場合は `loadeddata` を最大 5 秒待つ。

### 8.3 フレーム取得

- 検知用 canvas（既定 160×90、`willReadFrequently: true`）と保存用 canvas（動画ネイティブ解像度、`maxSlideWidth` で縮小）を持つ。
- サンプリングは `video.requestVideoFrameCallback` を使い、`sampleIntervalMs` 間隔に間引く。未対応時は `setInterval`。
- `requestVideoFrameCallback` は一時停止中は発火しないため、原案 §19（一時停止中は検知停止）が自然に満たされる。
- 保存は `canvas.toBlob('image/png')` → base64 → offscreen へ送信（`SLIDE`）。offscreen が `slides/slide_NNN.png` を書き、`slides.json` を更新する。連番は offscreen が振る。
- Phase 4 の確認用に、サイドパネルの「スクショを保存」で今のフレームを 1 枚保存できる（`CAPTURE_FRAME`）。Phase 5 以降も手動保存として残す。
- 画像の解像度は `videoWidth × videoHeight`、つまりその時点で再生中のレンディションの解像度になる。実サイト（Brightcove、HLS の ABR）では通常表示で 960×540、全画面で 1280×720 だった（2026-09-08）。常に高解像度で撮りたい場合は、プレイヤーの画質設定を最高に固定するか全画面で視聴する。拡張側でレンディションを固定する処理は入れない。

### 8.4 crop 経路（将来）

MVP では実装しない。必要になった場合は v0.2 §8.4 の設計を採用する: offscreen document が tabCapture の video トラックを取り込み、content script から届く矩形・DPR・viewport サイズで crop し、`.vjs-control-bar` を除外する。

### 8.5 DRM

`video.mediaKeys` が非 null の場合は「DRM 保護動画のためスライド保存は無効」と表示し、音声のみ続行する（音声も取得できない可能性がある）。回避処理は実装しない。

### 8.6 前面タブ前提（バックグラウンド非対応）

- 対象タブは「表示中のウィンドウの前面タブ」に置く。macOS では Chrome のウィンドウが他のウィンドウで完全に隠れると非表示扱いになるため、別アプリで作業する場合はウィンドウを並べる。
- 非表示中は `requestVideoFrameCallback` が止まりフレームが更新されない。`visibilitychange` で hidden になった、または `playing` 状態なのに 5 秒以上フレームが来ない場合は `TAB_HIDDEN` を警告する。
- 復帰後は最後に保存した画像との差分で不足分を保存するため、スライドの取りこぼしは起きにくい。ただしそのスライドの `videoTime` は切り替え時刻ではなく復帰時刻になる。
- 録音とタイムライン記録は非表示中も継続する（音声再生中のタブはタイマー抑制の対象外 ✅）。
- Phase 3 の実機確認（2026-09-08）: 音声キャプチャ中に別のタブへ切り替えても `document.visibilityState` は `visible` のままで、`requestVideoFrameCallback` も止まらなかった（TAB_HIDDEN が出なかった）。Chrome がキャプチャ中のタブを表示扱いにして描画を続けるためと考えられる。Phase 4 で背景中もフレームが取れることを確認できれば、前面タブ前提は「ウィンドウを最小化しない」程度に緩められる。
- 再生の再開やシークの直後は一時停止中の経過を「フレームが来ない」と誤判定しやすいので、`play` / `playing` / `seeked` でフレーム時刻をリセットする。

---

## 9. 変化検知

### 9.1 パラメータ

| 名前 | 既定 | 意味 |
|---|---|---|
| `sampleIntervalMs` | 500 | サンプリング間隔 |
| `detectWidth` / `detectHeight` | 160 / 90 | 比較用の縮小サイズ |
| `pixelDiffThreshold` | 24 | 画素差（0〜255）がこの値以上なら「変化画素」 |
| `changeThreshold` | 0.02 | 変化画素率がこれ以上なら「変化候補」 |
| `stableThreshold` | 0.015 | 直前サンプルとの差がこれ未満なら「安定」 |
| `stableSamples` | 2 | 連続してこの回数安定したら確定 |
| `maxStabilizeMs` | 3000 | 安定待ちの上限。超えたら現フレームで確定 |
| `dedupeThreshold` | 0.015 | 最後に保存した画像との差がこれ未満なら保存しない |
| `minShotIntervalMs` | 2000 | 保存間隔の下限 |
| `imageFormat` / `jpegQuality` | png / 0.9 | 保存形式 |
| `maxSlideWidth` | 0（無制限） | 保存画像の幅上限 |

### 9.2 手順

```text
sample()                                   // sampleIntervalMs ごと
  small = resize(frame, detectWidth, detectHeight)          // RGBA
  diffPrev = ratio(max(|ΔR|,|ΔG|,|ΔB|) >= pixelDiffThreshold)   // 直前サンプルとの比較
  prev = small
  state == WATCHING:
    diffPrev >= changeThreshold → state = STABILIZING, stabilizeStart = now, stableCount = 0
  state == STABILIZING:
    diffPrev < stableThreshold → stableCount++
    else                       → stableCount = 0
    stableCount >= stableSamples または 経過 >= maxStabilizeMs:
      diffSaved = ratio(max(|ΔR|,|ΔG|,|ΔB|) >= pixelDiffThreshold)   // 最後に保存した画像との比較
      diffSaved >= dedupeThreshold かつ 前回保存から minShotIntervalMs 以上 → save()
      state = WATCHING

save()
  lastSaved = small
  full = drawImage(video) → toBlob → SLIDE メッセージ
```

- 初回（`DETECT_START` 直後）は無条件に 1 枚保存する（原案 §18）。
- 変化が確定しても `minShotIntervalMs` が経っていない場合は捨てずに保留し、次のサンプルや一時停止時の判定で保存する（連続した切り替えの 2 枚目を落とさないため）。
- 一時停止・終了の瞬間は画面が静止していることが確実なので、安定待ち中なら即判定する。
- 閾値の根拠（2026-09-09 に再測定。1280×720 の合成スライドを 160×90 に縮小して比較。差分率は比較解像度をいくら上げてもほぼ変わらないので、解像度ではなく「どこを比べるか」で精度を上げている）:

| 変化 | 差分率 |
|---|---|
| スライドまるごと切り替わり | 2.7%（実講義では 3.2〜19%） |
| 本文が 1 行増える | 0.85% |
| 講師ワイプが動くだけ | 0.31%（実測 0.4〜0.9%） |
| 見出しの 1 文字が変わる | 0.04% |

  切り替えの判定（`changeThreshold` 2.5%）は「まるごと切り替わり」だけを拾う。本文が 1 行増える程度の変化はここでは拾わず、§9.2b の最終状態の上書き（`updateThreshold` 0.4%、動き続ける画素は除く）に任せる。ワイプの動きは除外されるので 0.4% には届かない。

- 旧測定（2026-09-08、fixture を 160×90 グレースケールで実測）: 本文テキストだけが変わるスライドの切り替えで隣接サンプル差 約 3.2%、見出しの明暗と大きな番号が変わる切り替えで約 19%、講師ワイプ相当の動きだけなら 0.4〜0.9%。
- 画素の比較は RGB 各チャンネルの差の最大値で行う（`ImageData` の RGBA 配列をそのまま走査、アルファは無視）。当初はグレースケール（輝度）で比べる案だったが、輝度が同じで色だけ変わる切り替え（カラー → モノクロ）を原理的に見逃すため変更した（2026-09-08）。fixture の実測ではノイズの底（0.4〜0.9%）も切り替え時の差（約 19.5%）も輝度比較と同じで、コスト増もない。
- `diffRatio(a, b, threshold)` などを純粋関数として切り出し、Vitest で fixture 画像を使って閾値の挙動をテストする。

### 9.2b 最終状態の保持（2026-09-09）

文字が 1 行ずつ出るスライドは、切り替わり直後の安定した状態（最初の 1 行だけの画面）が保存され、全部出た状態が残らない。1 行の追加は差分が小さく（1% 前後、講師ワイプの動きと同程度）、切り替わりとしては拾えないので、閾値を下げるのではなく撮り方を変える。

- 検知スクリプトは、切り替わりではないサンプル（`watching` かつ直前との差が `changeThreshold` 未満。ワイプの動きや 1 行の追加を含む）のたびに、そのフレームをフル解像度で 1 枚だけ保持する（`rememberStable`）。
- 次の切り替わりを検知した瞬間（`watching` → `stabilizing`）、保持していたフレーム＝前のスライドの最終状態を、その保存済み画像と比べる。差が `slide.updateThreshold`（既定 0.4%）以上なら、同じファイル名・同じ番号のまま画像を上書きし、`slides.json` に `updated: true` と `finalVideoTime` / `finalT` を記録する（`SLIDE_UPDATE`）。差が小さければ何もしない。
- この比較（`ChangeDetector.diffFromSaved`）は **動き続けている画素を除く**（2026-09-09）。同じスライドを見ている間、サンプルごとに画素の変化回数を数え、3 回以上変わった画素（講師のワイプや動画の中身）は比較から外す。新しいスライドを保存したら数え直す。サンプルが 4 つ未満の間は全画素で比べる。
- 一時停止・終了・Stop のときも同じ処理をするので、最後のスライドも最終状態になる。
- 重複判定の基準（`lastSaved`）は最終状態に差し替えるが、保存間隔の時計は動かさない（`replaceSaved`）。
- 切り替わり直後の画像は残らない（上書き）。前のスライドに戻った場合、そのスライドは戻った先の画面で再び上書きされうる。`slide.finalState: false` で無効化できる。

### 9.3 誤検知対策

- 重複判定（`dedupeThreshold`）の基準になる「最後に保存した画像」は、フル解像度を canvas に描いた瞬間の縮小フレームを使う。エンコード・送信の完了後に取り直すと、保存に時間がかかる環境（CI など）では次のスライドが基準になってしまい、次の切り替わりを重複として捨てる（2026-09-09 に CI で判明し修正）。

- `<video>` を直接読むためプレイヤー UI とカーソルは映らず、対策対象は「講師のカメラ映像（ワイプ）」と「動画内の小さなアニメーション」に絞られる。
- 第 1 段階は上記の全体差分率で運用し、実際の動画で閾値を調整する。
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

（2026-09-09）「Downloads に書き出す」は UI から外した。サーバーで処理する運用では音声も `~/LecScribe/<セッション>/.lecscribe/` に残るため。`EXPORT` メッセージと offscreen 側の実装は残しており、開発時の回収手段として使える。

`chrome.downloads.download()` で `~/Downloads/LecScribe/<sessionId>/` 配下に各ファイルを保存する（`saveAs: false`）。サーバーが使えないときの回収手段であり、Phase 2 / 6 の動作確認にも使う。

### 11.3 破棄・保持

- 「破棄」で OPFS のセッションディレクトリを削除する。エクスポート済みのファイル（`~/Downloads/LecScribe/`）やサーバーの出力（`~/LecScribe/`）は削除しない。確認ダイアログにその旨を明記する。
- 例外として、文字起こし中・送信待ちのセッションを「破棄」したときは、サーバーに `POST /sessions/:id/cancel { delete: true }` を送って処理（ffmpeg / whisperkit / codex）を止め、`~/LecScribe/` のフォルダごと削除する（まだ成果物になっていないため。時間と LLM のトークンを無駄にしない）。ただし既に `notes.md` があるフォルダ（「やり直す」中の破棄）は削除しない。送信待ちが残っていれば次を始める。
- サーバー処理が `done` になった後も既定では OPFS に残し、パネル の「破棄」で削除する（`storage.autoDeleteAfterDone` で自動削除可）。
- 過去セッションの一覧と操作は パネル の「履歴」で行う（MVP では直近 1 件のみでも可）。

---

## 12. Mac ローカルサーバー

### 12.1 起動と設定

利用者向けの導入は `install.sh`（`curl … | bash` の 1 行。Homebrew → node / git / ffmpeg / whisperkit-cli → `~/LecScribe-app/` に取得 → `agent.mjs install`）。ノート作成（§13.5）は既定で無効で、`enable-notes.sh [codex|ollama|none]` が Codex CLI の導入とログインを済ませて `LEC_SCRIBE_LLM` 付きで登録し直す。`agent.mjs install` は既に登録されている plist の `LEC_SCRIBE_*` / `OPENAI_API_KEY` を引き継ぐので、あとから `install.sh` を流し直してもこの設定は消えない。引き継ぎをやめたい変数は空文字で渡す（`LEC_SCRIBE_LLM_MODEL= … agent:install`。`enable-notes.sh` はバックエンドを切り替えるときに前のモデル名をこれで落とす）。`GET /health` が `llm` を返し、拡張の設定画面の「ノート作成」が今の状態と有効化のコマンドを表示する（2026-09-09）。拡張は Chrome ウェブストアで配る前提で、未接続画面がサーバーを見つけられないときにこの 1 行をコピーできる形で案内する（2026-09-09）。更新は `update.sh`（処理中なら待って `agent restart`）。

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
| POST | `/pair` | `{ name? }`。認証不要だが `Origin: chrome-extension://<id>` 必須。macOS のダイアログで承認されると `{ paired: true, token }`（承認済みなら同じトークンを返す）。拒否は 403、ダイアログ表示中は 429 |
| POST | `/sessions/:id/cancel` | `{ delete?: boolean }`。待機中なら取り下げ、実行中なら子プロセス（ffmpeg / whisperkit / codex）を止める。`delete` でフォルダごと削除（拡張の「破棄」が処理中のセッションに対して使う） |
| POST | `/sessions/:id/open` | `{ target?: 'folder' \| 'lecture' }`。出力フォルダまたは `notes.md` を macOS の `open` で開く |

`stage`: `queued → converting → transcribing → merging → done | error`

### 12.3 認証・通信

- `Host` が `127.0.0.1` / `localhost` 以外なら 403（DNS リバインディング対策。2026-09-09 に実装）。
- `Authorization: Bearer <token>` 必須。共有トークン（`~/.lec-scribe/token`）か、`POST /pair` で承認時に発行した拡張ごとのトークン（`trusted.json`）のどちらかに一致しなければ 401。
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

補足（2026-09-09）:

- 同じセッションを finalize し直したとき（拡張の「やり直す」）、`pipeline.json` の `transcript`（モデル名と `audio.webm` のバイト数）が今回と一致し、`whisperkit/` の report が残っていれば、ffmpeg と whisperkit-cli を飛ばして report を再利用する。ノートの形式やプロンプトを変えたあとに作り直すのが数分で済む。モデルを変えたときは文字起こしからやり直す。
- サーバー起動時に `outDir` を走査し、`queued` 〜 `polishing` のまま残っている `pipeline.json` を `error`（「サーバーが再起動したため中断」）にする。そのままだと拡張が永遠に処理中を見続けるため。
- `GET /health` は `processing`（待機中 + 実行中の件数）を返し、`agent.mjs restart` は 0 でなければ拒む（`--force` で強制）。

---

## 13. 文字起こしと統合

### 13.1 whisperkit-cli ✅

- 導入: `brew install whisperkit-cli`（macOS 14 以降）
- 確認済みフラグ: `--audio-path`, `--model`, `--language`, `--report`, `--report-path`, `--chunking-strategy vad`, `--skip-special-tokens`, `--verbose`
- 入力形式: wav / mp3 / m4a / flac
- 実機確認（2026-09-08）✅: Homebrew の `whisperkit-cli` 1.1.0 は「Argmax OSS CLI」で、コマンド名は `whisperkit-cli`、サブコマンド `transcribe`。上記フラグはすべて存在し、`--chunking-strategy` の既定は `vad`。`--report-path` のディレクトリは事前に作っておく必要がある（作られない）。サーバーは `--whisperkit` / `LEC_SCRIBE_WHISPERKIT` でコマンドを差し替えられる。
- report は `<basename>.json` と `<basename>.srt`。JSON は `{ text, segments: [{ id, seek, start, end, text, tokens, tokenLogProbs, avgLogprob, … }], language, timings }` で、`segments[].start / end` は秒。VAD のチャンク境界で区間が重なることがある（そのまま時刻順に並べる）✅。

### 13.2 モデル

| モデル | 用途 |
|---|---|
| `large-v3` | 日本語精度優先（既定。開発機は M3 Max / 64 GB のため速度面の制約は小さい） |
| `large-v3_turbo` | 速度優先。Phase 7 で精度差を実際の動画で比較して既定を決める |

初回実行時にモデル（数 GB）がダウンロードされる。サーバーの `--warmup` で事前取得できるようにする。

### 13.2b 幻覚区間の除去（2026-09-09）

WhisperKit の VAD 分割では、30 秒の窓いっぱいに広がる区間（`noSpeechProb` 0、logprob も高い）が本物の区間と時間的に重なって出ることがある。実例: 1 章の動画で 59.6〜89.6 秒・75.8〜105.8 秒・161〜191 秒に「ご視聴ありがとうございました」が入り、それぞれ本物の発話と重なっていた（104 区間中 3 つ。他の 3 本の動画では 0）。1 本の音声で区間が重なることはないので、`dropWindowArtifacts` で次を捨てる:

- 15 秒以上で、本文が決まり文句（「ご視聴ありがとうございました」「チャンネル登録お願いします」など）だけのもの。同じ文の繰り返しも 1 つとみなす。短い決まり文句は本当に言っている可能性があるので残す
- 20 秒以上の区間で、他の区間との重なりの合計が 5 秒以上のもの。長い区間から順に見て、重なりは「まだ残っている区間」とだけ数える。全区間と一度に比べると、幻覚の窓に巻き込まれた本物の長い区間まで一緒に消えてしまうため（幻覚の窓のほうが長いので、先に落ちる）

捨てた区間はサーバーのログに `dropped artifact segment (phrase|overlap)` として残る。全区間が落ちたときは `all N segments ... were dropped as Whisper artifacts` で失敗させ、report が空だった場合と区別する。`--no-speech-threshold` などの閾値では防げない（確信度が高いまま出るため）。

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
# <動画タイトル>

- 収録: 2026-09-08 10:30
- 元ページ: <URL>

- スライド: 12 枚 / 文字起こし: 297 区間

![slide_001](slides/slide_001.png)

今日はデザインについて説明します。…

---

![slide_002](slides/slide_002.png)

---

![slide_003](slides/slide_003.png)

…
```

節ごとの見出し（時刻 + ファイル名）は付けず、スライド画像と `---` で区切る（2026-09-09、読むときに邪魔なため。時刻は `transcript.json` / SRT / VTT にある）。発話のないスライド（上の例の `slide_002`）は画像だけを置き、注記は出さない（画面が細かく変わる動画では注記が並んで読みにくいため。2026-09-09）。スライドに属するセグメントを結合し、句点で改行する。最初のスライドより前の発話は「冒頭（スライドなし）」の節に入れる。自動検知で保存したスライド（`reason: change`）は切り替えの 1〜2 秒後に確定するため、表示開始を `videoTime - 1.5` 秒とみなして割り当てる（初回・手動はそのまま）。`transcript.json` の各区間にも `slide` を入れる。

---

### 13.5 ノート作成: 話し言葉を整えて要点を付ける（Phase 9、任意）

文字起こしは話し言葉のままなので、LLM でフィラーを除いて書き言葉に整え、要点を付けた `notes.md` を作る。`lecture.md`（文字起こしそのまま）は残す。

要点と見出しは **スライド単位ではなく話題単位** に付ける（2026-09-09 に変更）。画面の切り替わり（キャプチャ単位）は話の区切りと一致しないことが多く、特に Illustrator の操作デモのように画面が細かく変わる動画では節が断片になり、節ごとの要点がかえって読みにくかったため。

呼び出しは 2 段階:

1. `polish`: スライドごとの本文をバッチで整える（`{ sections: [{ id, text }] }`）。要点は作らない。
2. `outline`: 整えた本文全体を 1 回で渡し、動画全体の要点（5〜12 項目）と話題の区切り（`{ heading, summary[], startId }` の配列。`startId` はその話題が始まる節の id）を作る。最初の話題は先頭の節から始める。知らない id や順序の乱れた話題は捨てる。失敗しても `notes.md` は見出しなしで作り、`notesError` に残す。

`notes.md` の形: 見出し（`# <動画タイトル>`）のあとに「## 全体の要点」、以降は話題ごとに「## 見出し」「**要点**」、その中にスライド画像と本文を順に並べる（同じ話題の中のスライドは `---` で区切る）。発話のないスライドは画像だけ。整えられなかった節（LLM が本文を返さなかった、または空で返した節）にだけ「（整えられなかったため文字起こしのまま）」を付けて文字起こしを載せる。

- 呼び出し先はサーバー起動時の `--llm` で選ぶ（既定 `none` = 作らない）。
  - `codex`: Codex CLI の `codex exec` を非対話で呼ぶ。ChatGPT アカウントの定額枠で動き API キー不要。`--output-schema` で JSON の形を固定する。枠（5 時間・週）に当たると失敗する。OpenAI は自動処理には API キーを案内しているため、個人の少量利用に限る
  - `openai`: OpenAI API（`OPENAI_API_KEY`、従量課金）
  - `ollama`: ローカルの Ollama（テキストも外に出さない。既定モデル `qwen2.5:32b`）
- `polish` の入力はスライドごとの節（`groupSections`）。本文の文字数が `--llm-chars`（既定 4000）を超えないよう数節ずつまとめて呼ぶ。`outline` は 1 回（90 分の動画で 3 万字前後）。
- プロンプトの要点: 内容と順序を変えない、フィラーと言い直しの除去、です・ます調、専門用語はそのまま、要約や補足はしない。話題は細かく割りすぎない（10 分で 2〜4 個、90 分で 6〜15 個が目安）。
- 失敗（枠切れ、JSON 崩れ）はそのバッチだけ諦め、`notes.md` では文字起こしのまま載せる。ノート作成が全滅しても文字起こしまでは `done` にし、`pipeline.json` の `result.notesError` に理由を残す。
- 文字起こしテキストが外部に出るのは `codex` と `openai` のときだけ。音声・画像は送らない。

## 14. 出力ファイル

ユーザーが見るのは `notes.md` と `slides/` だけにし、作業ファイルは隠しフォルダ `.lecscribe/` に寄せる（2026-09-09）。セッションフォルダを移動・改名しても中身の対応が壊れないよう、別の場所には置かない。旧配置（作業ファイルがトップレベル）のフォルダは、次に処理したときに自動で並べ替える。

```text
~/LecScribe/20260908-103005-ab12_<タイトル>/
├── notes.md             ノート。--llm 指定時は整えた本文と要点、未指定時は文字起こしそのまま
├── slides/
│   ├── slide_001.png
│   └── ...
└── .lecscribe/          作業ファイル
    ├── session.json
    ├── audio.webm
    ├── audio.wav        （既定では処理後に削除）
    ├── transcript.json / .txt / .srt / .vtt
    ├── slides.json
    ├── timeline.json
    ├── capture-status.json
    ├── pipeline.json
    ├── lecture.md       文字起こしそのままの版（画像は ../slides/ を参照）
    └── whisperkit/      whisperkit-cli の report
```

`slides.json` の要素:

```json
{ "filename": "slide_003.png", "seq": 3, "videoTime": 1532.42, "t": 1540.10,
  "capturedAt": "2026-09-08T01:59:56.000Z", "width": 1280, "height": 720, "source": "direct" }
```

---

## 15. UI

### 15.1 サイドパネル

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

サーバー未接続（トークンなし）で何も動いていないときは、ポップアップ / サイドパネルに「このMacと接続」と説明だけを出し、Start や状態表示は出さない（2026-09-09。接続しないと文字起こしできないため。未接続では一覧も出さない）。

状態別の主ボタン: IDLE = Start（ポップアップ）、CAPTURING = Stop + 「今の画面を手動で保存」、UPLOADING / PROCESSING = Server 行に段階、COMPLETED = 「出力フォルダを開く」。

セッション一覧（録音中も表示）の各行: 処理済みなら「フォルダを開く」「やり直す」、未処理なら「文字起こしする」、常に「破棄」。処理中・送信待ちの行には「処理中」「送信待ち」のタグが付き、「破棄」を押すと確認のうえ処理を中止してサーバー側のフォルダも消す（§11.3）。

### 15.3 ページ上のフィードバック（2026-09-09）

スライドを保存・上書きした瞬間、検知スクリプトが動画の右下にサムネイルだけの小さなトーストを約 2.5 秒出す（文字も色分けも出さない。動画の領域を取るため）。保存・最終状態での更新・手動保存のどれでも同じ表示。Shadow DOM に閉じてページの CSS と干渉させない。全画面中は `document.fullscreenElement` の中に置く。サイドパネルを見ていなくても撮れたことが分かる。

### 15.2 options

サーバー（「このMacと接続」で承認、接続テスト。詳細設定に port と token）。音声・検知・保存の項目は置かない（2026-09-09。既定のままで困らないため。config には残す）。

---

## 16. エラー処理

| 事象 | 検出 | 表示 | 復旧 |
|---|---|---|---|
| streamId 取得失敗 / getUserMedia 失敗 | 例外 | 「タブのキャプチャを開始できません」 | offscreen を閉じて IDLE |
| video 要素なし | probe | 警告「このページには動画が見つかりません。音声のみ録音します」 | 録音は継続 |
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

- 比較は 160×90 の RGB（原案 §37 のグレースケールから変更、§9.2）。保存時のみフル解像度。
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
- 完了条件: 対象サイトの動画を再生中に Start しても AirPods から音が途切れず、二重にも聞こえない ⚠️。Stop 後も再生が続く。手順は [CHECKS.md](./CHECKS.md)

### Phase 2: 録音

- MediaRecorder → Worker → OPFS。Stop でエクスポート（chrome.downloads）
- 完了条件: 10 分録音した `audio.webm` が再生でき、`ffmpeg -i` で読める。Chrome を強制終了しても直前チャンクまで残る

### Phase 3: 動画要素検出

- 動的注入、probe
- 完了条件: fixture と実サイトの両方で `VideoCandidate` が返る

### Phase 4: フレーム取得

- drawImage によるフレーム取得、taint 判定、DRM 判定、非表示検知
- 完了条件: 実サイトで動画フレームだけの画像が保存される（tainted にならないことを確認 ⚠️）。fullscreen・ウィンドウ縮小・タブ非表示時の挙動を記録する

### Phase 5: 変化検知

- §9 のアルゴリズムと Vitest。fixture でスライド 10 枚が 10 枚として検出され、ワイプの動きで誤検知しない
- 完了条件: fixture で適合率・再現率とも 100%。実際の動画 30 分で閾値を調整し、値を `docs/` に記録する

### Phase 6: スライド保存

- 初回保存、重複防止、timeline 記録、`slides.json` / `timeline.json`、エクスポート
- 完了条件: 実際の動画 1 本でスライド一式と JSON がエクスポートされ、`videoTime` が正しい

### Phase 7: ローカルサーバーと WhisperKit

- サーバー、認証、アップロード、ffmpeg、whisperkit-cli、進捗
- 完了条件: 90 分の動画の `audio.webm` から日本語 SRT が生成される。CLI 名 / フラグ / モデル既定を確定して記録する ⚠️

### Phase 8: 統合

- timeline による時刻変換、スライド対応付け、TXT / SRT / VTT / `lecture.md`、パネル の完了表示
- 完了条件: 実際の動画 1 本で `lecture.md` が生成され、スライドと本文の対応が目視で妥当

### Phase 9: ノート作成（notes.md）✅

- LLM（`codex exec` / OpenAI API / Ollama）で話し言葉を整え、全体の要点と話題ごとの見出し・要点を付けた `notes.md`（§13.5）
- 完了条件: 実際の動画 1 本で `notes.md` ができ、内容が改変されていない（Phase 9 の実機確認は CHECKS.md）

### 将来

リアルタイム文字起こし、再生速度の正規化（D-05）、除外矩形、Side Panel、要約・キーワード抽出・検索。

---

## 20. 未決事項（要回答・要実機確認）

| ID | 内容 | 状態 |
|---|---|---|
| Q-01 | 実サイトの `<video>` は同一ページ内か、cross-origin iframe 内か | **解決**: 同一ページ内。`document.querySelector('video')` で `id="…_html5_api" class="vjs-tech"` が取れる（D-09） |
| Q-02 | 実サイトの動画が MSE（`blob:` src）か。DRM があるか | **一部解決**: `src` は `blob:https://<サイトのドメイン>/…`（MSE）。DRM の有無は Phase 4 の probe（`video.mediaKeys`）で確認 |
| Q-03 | 視聴スタイル（前面タブか、別アプリで作業しながらか） | **解決**: バックグラウンド対策は MVP から外し、前面タブ前提にする（D-03、§8.6） |
| Q-04 | 再生速度 | **解決**: 1.0x で視聴する（D-05） |
| Q-05 | Mac のチップ / メモリ | **解決**: M3 Max / 64 GB。既定モデルは `large-v3`（§13.2） |
| Q-06 | 矩形ユーザー指定を MVP に含めるか | **解決**: 含めない（Q-01 の結果より不要） |
| Q-07 | サーバーの言語 | **解決**: Node.js + TypeScript（D-11） |
| Q-08 | 出力ディレクトリ | **解決**: `~/LecScribe`（§12.1） |
| Q-09 | tabCapture 中のタブが非表示でも `<video>` の drawImage が更新されるか | **有望**: Phase 3 の実機確認で、別タブ表示中も visibilityState が visible のままでフレームも届いた（§8.6）。Phase 4 で実際に画像が撮れるか確認する |
| Q-10 | 拡張ページから 127.0.0.1 への fetch に PNA / LNA の制限がかかるか | Phase 7 で確認 ⚠️ |
| Q-11 | WhisperKit CLI の現行コマンド名とフラグ、report JSON の形式 | **解決**: `whisperkit-cli transcribe`（Argmax OSS CLI 1.1.0）。フラグと report の形は §13.1 のとおり |
| Q-12 | パススルーで二重再生が起きないか | **解決**: 起きない（2026-09-08、Mac 内蔵スピーカー。[CHECKS.md](./CHECKS.md)） |

---

## 21. 実装しないこと

原案 §42 を維持する。

- Brightcove の m3u8 を直接取得する処理
- blob URL から動画ファイルを抽出する処理
- Fastly token 等の署名を解析・再利用する処理
- AES-128 等の暗号化ストリームを復号する処理
- DRM 回避、サイトの認証回避、アクセス制御回避
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
