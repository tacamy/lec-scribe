# LecScribe

ページに `<video>` で埋め込まれたスライド動画（Brightcove などの `blob:` 再生を含む）を Chrome で再生しながら、音声をローカル録音し、スライドが切り替わったときだけ動画領域のスクリーンショットを保存し、視聴後に Mac 上の WhisperKit で日本語文字起こしを行って、スライドと文字起こしを時間軸で統合したノートを生成する Chrome 拡張（Manifest V3）と Mac ローカルサーバー。

- 音声・画像・文字起こしはすべて Mac 内で処理し、外部クラウドへ送信しない
- 動画ファイルの直接取得や DRM / 認証 / アクセス制御の回避は行わない。`chrome.tabCapture` でユーザーが正当に再生中のタブを取り込むだけ

## 状態

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 足場（pnpm workspace、WXT、Vitest、Playwright スモーク、fixture、CI） | 完了 |
| 1 | tabCapture + 音声パススルー | 完了（Mac で確認済み: パススルー動作、二重再生なし） |
| 2 | 録音（OPFS へ逐次保存 → エクスポート） | 完了（Mac で確認済み） |
| 3 | 動画ページの `<video>` 検出と状態追跡 | 完了（Mac で確認済み） |
| 4 | `<video>` からのフレーム取得と画像保存（開始時 1 枚 + 手動） | 完了（Mac で確認済み） |
| 5 | 画面変化の自動検知 | 完了（Mac で確認済み） |
| 6 | 再生イベントのタイムライン記録（録音時刻 ⇄ 動画時刻） | 完了（Mac で確認済み） |
| 7 | Mac ローカルサーバー + ffmpeg + WhisperKit で文字起こし | 完了（Mac で確認済み。131 秒の録音を 2 回目 42 秒で処理） |
| 8 | スライドと文字起こしの統合（`lecture.md`） | 完了（Mac で確認済み） |
| 9 | LLM で話し言葉を整えて要点を付けたノート（`notes.md`、任意） | 完了（`codex exec` で確認済み。OpenAI API / Ollama も選択可） |

Phase 9 のあとも、検知の精度・同じ場面の画像のまとめ方・一覧の操作を実際の講義動画で詰めています。実機で未確認の項目は [docs/CHECKS.md](docs/CHECKS.md) の「残っている実機確認」にあります。

| ドキュメント | 内容 |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | 仕様書 v0.5（現行。設計判断 D-xx と未決事項 Q-xx を含む） |
| [docs/CHECKS.md](docs/CHECKS.md) | Phase ごとの手動確認手順と記録 |

## 使い方（利用者向け）

必要なもの: Apple Silicon の Mac、Chrome。

1. Chrome ウェブストアから LecScribe 拡張を入れる（公開準備中）。
2. ツールバーの LecScribe アイコンを押す。Mac 側の準備がまだなら、ポップアップに次の 1 行が出るので「ターミナル」に貼り付けて Enter を押す。

   ```sh
   curl -fsSL https://raw.githubusercontent.com/tacamy/lec-scribe/main/install.sh | bash
   ```

   Homebrew と ffmpeg / whisperkit-cli を入れ、サーバーを `~/LecScribe-app/` に置いてログイン時に自動起動するよう登録します。途中で Mac のパスワードを聞かれることがあります。
3. もう一度アイコンを押して「このMacと接続」→ Mac に出る確認画面で「許可」。
4. 動画ページで動画を再生し、アイコン → Start。見終わったら Stop すると文字起こしが始まり、`~/LecScribe/` にノートができます（初回はモデルのダウンロードで数分余計にかかります）。
5. ノートを整える（任意）。このままだと `notes.md` は文字起こしそのままです。話し言葉を整えて要点と見出しを付けるには、ターミナルで次を実行します。

   ```sh
   bash ~/LecScribe-app/enable-notes.sh
   ```

   Codex CLI を入れて ChatGPT アカウントでログインします（定額枠で動くので API キーは不要）。ローカルの Ollama を使うなら末尾に `ollama`、無効に戻すなら `none` を付けます。拡張の設定画面の「ノート作成」でも今の状態とこのコマンドを確認できます。

更新は `bash ~/LecScribe-app/update.sh`。

## 使い方（開発中）

```sh
pnpm install
pnpm build                       # 拡張を extension/dist/chrome-mv3 にビルド
pnpm typecheck && pnpm test      # 型検査と単体テスト
node scripts/smoke-extension.mjs # headless Chromium で拡張を読み込むスモークテスト
pnpm fixtures:make               # 合成スライド動画を生成（Phase 3 以降で使用）
pnpm fixtures:serve              # http://127.0.0.1:8787/player.html
pnpm --filter @lec-scribe/server start   # ローカルサーバー。拡張のポップアップに出る「このMacと接続」→ Mac のダイアログで「許可」
```

ツールバーのアイコンのポップアップから Start すると、そのタブにサイドパネルが開いて録音中の状態を表示します（他のタブには出ません。他のタブからはアイコンのポップアップで同じ状態を見られます）。Stop すると自動でサーバーに送って文字起こしが始まります。処理中に次の動画の録音を始めてもよく、Stop 後は送信待ちに並びます。一覧の「文字起こしする / やり直す」も処理中に押せて、同じく送信待ちに並びます。「やり直す」は同じ音声・同じモデルなら文字起こしを再利用してノートだけ作り直すので数分で終わります。本文も変わっていなければノート作成の結果（LLM の応答）も使い回すので、数秒で終わり Codex の枠も使いません。一覧には保存済みのセッションが新しい順に全部出ます（ポップアップでは一覧の中でスクロール）。タイトルが省略されている行は、タイトルに乗せると全文が出ます。処理中の行は「中止」で止められます（初回なら途中のデータも消えます。やり直し中なら止めるだけ）。処理済みの行は「非表示」で一覧から隠せて（データは残り、一覧の下から戻せます）、「削除」で `~/LecScribe` のフォルダごと消せます。スライドを保存すると動画の右下にサムネイルが約 2.5 秒出るので、パネルを見ていなくても撮れたことが分かります。文字が 1 行ずつ出るスライドは、次のスライドに移った瞬間に全部出た状態で画像を上書きします（比較のときは講師のワイプなど動き続ける部分を除くので、本文が少し変わっただけでも拾います）。同じ場面が何枚も撮れたときは、サーバーが見た目の近さと写っている文字（macOS の Vision の画像比較と文字認識。Xcode Command Line Tools が必要、Mac の中だけで動きます）と色の分布で「同じ場面」を判定して notes.md にはその場面の最後の 1 枚だけ載せます（画像は `slides/` に残ります。`--scene-vision` / `--scene-vision-photo` / `--scene-color` で調整。まとめを全部やめるにはこの 3 つを 0 にします。`--scene-keep first` で最初の 1 枚に）。画像は文の途中には挟まず、文の切れ目に置きます。Chrome への読み込み方と各 Phase の確認項目は [docs/CHECKS.md](docs/CHECKS.md) を参照。

### 出力フォルダ

`~/LecScribe/<タイトル>_<日時>/` に、ユーザー向けの `notes.md` と `slides/` だけが見える形で出力します。音声・文字起こし（json / srt / vtt / txt）・timeline などの作業ファイルは隠しフォルダ `.lecscribe/` にまとめています（Finder では Cmd+Shift+. で表示）。

### 話し言葉を整えて要点を付ける（任意）

文字起こしは話し言葉のままです。サーバー起動時に `--llm` を指定すると、フィラーを除いて書き言葉に整え、冒頭に動画全体の要点、本文には話題ごとの見出しと要点を付けた `notes.md` を作ります（見出しはスライドの切り替わりではなく内容から決めます）。

出来上がった `notes.md` は普通の Markdown なので、不要なスライドの行を消すなど自由に編集できます（ただし「やり直す」を押すと作り直され、編集は消えます）。

導入スクリプトで入れた場合は `bash ~/LecScribe-app/enable-notes.sh` で設定できます。開発中に手で切り替えるときは:

```sh
pnpm --filter @lec-scribe/server start -- --llm codex            # Codex CLI（ChatGPT の定額枠、要 codex login）
pnpm --filter @lec-scribe/server start -- --llm openai            # OpenAI API（環境変数 OPENAI_API_KEY）
pnpm --filter @lec-scribe/server start -- --llm ollama --llm-model qwen2.5:32b   # ローカル LLM
LEC_SCRIBE_LLM=codex pnpm --filter @lec-scribe/server agent:install             # 常駐サーバーに渡す場合（既存の設定は引き継がれます）
```

`codex` と `openai` では文字起こしのテキストが外部に送られます（音声・画像は送りません）。

### サーバーの常駐化（macOS）

ターミナルで起動しておく代わりに、launchd のユーザーエージェントとして登録するとログイン時に自動起動し、落ちても再起動されます。

```sh
pnpm --filter @lec-scribe/server agent:install    # 登録して起動。そのあと拡張のポップアップで「このMacと接続」
pnpm --filter @lec-scribe/server agent:status     # 状態と /health
pnpm --filter @lec-scribe/server agent:restart    # サーバーのコードを更新したあとに（処理中なら拒む。--force で強制）
pnpm --filter @lec-scribe/server agent:uninstall  # 解除
```

ログは `~/Library/Logs/lec-scribe/server.log`。登録時の `node` のパスと `PATH`（Homebrew の `whisperkit-cli` / `ffmpeg` を含む）を書き込むので、Node を入れ替えたときは `agent:install` をやり直してください。ターミナルで起動したサーバーが残っているとポートが重なるので、先に止めてから登録します。

起動には `~/Applications/LecScribe Server.app`（中身は Node を呼ぶだけのスクリプト）を経由します。これは macOS の「ログイン項目と機能拡張」に「LecScribe Server」という名前で表示させるためで、直接 `node` を登録すると署名者の「Node.js Foundation」と表示されてしまいます。表示される場所は「アプリのバックグラウンドでのアクティビティ」で、「ログイン時に開く」には出ません（launchd のエージェントはこちらに分類されます）。署名していないので「開発元を識別できない項目」と付きます。

## 構成

```text
lec-scribe/
├── extension/   Chrome 拡張（WXT + TypeScript）
│   ├── entrypoints/  background.ts / sidepanel/ / offscreen/ / detector.ts（動画のある frame に注入）
│   └── src/          config, state, messages, format, opfs/（純粋関数は Vitest）
├── server/      Mac ローカルサーバー（Node.js 22 + TypeScript、依存なし）
├── fixtures/    動作確認用のローカルプレイヤーページと合成スライド動画
├── scripts/     スモークテスト
└── docs/        仕様・確認手順
```

## 動作要件

- macOS 14 以降、Apple Silicon
- Chrome 安定版（116 以降）
- Node.js 22、pnpm 10
- `brew install whisperkit-cli ffmpeg`（Phase 7 以降）
- Xcode Command Line Tools（`swiftc`。同じ場面の画像をまとめる判定に使います。無くても動きますが、似た画像が並びます）

## ライセンス

MIT
