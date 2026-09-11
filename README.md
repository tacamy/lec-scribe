# LecScribe

講義動画を見ながら、話の内容と画面をノート（Markdown）にまとめる Chrome 拡張です。

ページに `<video>` で埋め込まれた動画（Brightcove などの `blob:` 再生を含む）を再生すると、音声を録音し、スライドが切り替わったときだけ画面を保存します。見終わると Mac 上の WhisperKit が日本語で文字起こしし、スライドと本文を時間順に並べたノートができます。

- 音声・画像・文字起こしはすべて Mac 内で処理し、外部に送りません（ノートを整える機能だけは例外。後述）
- 動画ファイルの取得や DRM / 認証 / アクセス制御の回避は行いません。再生中のタブの音と画面を取り込むだけです

## できること

- タブの音声を録音します。録音中も音はそのまま聞こえます（イヤホンでもスピーカーでも、いつもの出力先から）
- スライドが変わったときだけ保存するので、同じ画面が何枚も並びません。画面の隅に映った講師が動いた、映像の中の人や物が動いた、といった変化では増えません
- 文字がアニメーションで少しずつ出るスライドは、途中の状態ではなく、全部そろった 1 枚が残ります
- 保存したときは動画の右下にサムネイルが出るので、いつ保存されたかが分かります
- 手動で「今の画面を保存」もできます
- 日本語の文字起こしを WhisperKit（`large-v3`）で行います
- スライド画像と本文を時間順に並べた `notes.md` を作ります。画像は文の途中には入りません
- 同じ場面の画像が何枚も撮れたときは、まとめて 1 枚だけ載せます（見た目の近さ、写っている文字、色の分布で判定。画像自体は残ります）
- ChatGPT（Codex CLI）かローカルの Ollama を使える場合は、話し言葉を書き言葉に整え、全体の要点と話題ごとの見出し・要点を付けられます

## 使い方

### 1. 準備（初回だけ）

1. Chrome ウェブストアから LecScribe 拡張を入れます（公開準備中）
2. ツールバーの LecScribe アイコンを押します。Mac 側の準備がまだなら、ポップアップに次の 1 行が出るので「ターミナル」に貼り付けて Enter を押します

   ```sh
   curl -fsSL https://raw.githubusercontent.com/tacamy/lec-scribe/main/install.sh | bash
   ```

   文字起こしに必要なもの（Homebrew、ffmpeg、whisperkit-cli など）を入れて、サーバーを `~/LecScribe-app/` に置き、ログイン時に自動で起動するようにします。途中で Mac のパスワードを聞かれることがあります

3. もう一度アイコンを押して「このMacと接続」。Mac に出る確認画面で「許可」を押します

### 2. 録音する

動画ページで動画を再生してから、アイコン → Start。そのタブにサイドパネルが開いて状態が見えます（他のタブには出ません。他のタブではアイコンのポップアップで同じ状態を見られます）。

見終わったら Stop。そのまま文字起こしが始まります。パネルを閉じても、Chrome を別のタブに移しても処理は続きます。初回はモデルのダウンロードで数分余計にかかります。

終わるのを待たずに、次の動画の録音を始められます。Stop すると順番待ちに並び、前の処理が終わり次第かかります。

### 3. できあがるもの

`~/LecScribe/<タイトル>_<日時>/` に、`notes.md` と `slides/` だけが見える形でできます。一覧の「フォルダを開く」で開けます。

音声・文字起こし（json / srt / vtt / txt）・タイムラインなどの作業ファイルは、隠しフォルダ `.lecscribe/` にまとめてあります（Finder では Cmd+Shift+. で表示）。

`notes.md` は普通の Markdown なので、要らない画像の行を消すなど自由に編集できます。ただし「やり直す」を押すと作り直されるので、編集は消えます。

### 4. ノートを整える（任意）

このままだと `notes.md` は文字起こしそのままです。話し言葉を整えて要点と見出しを付けるには、ターミナルで次を実行します。

```sh
bash ~/LecScribe-app/enable-notes.sh
```

Codex CLI を入れて ChatGPT アカウントでログインします（定額枠で動くので API キーは不要）。ローカルの Ollama を使うなら末尾に `ollama`、やめるなら `none` を付けます。拡張の設定画面の「ノート作成」でも、今の状態とこのコマンドを確認できます。

すでに文字起こし済みのセッションも、一覧の「やり直す」を押せば録音し直さずにノートだけ作り直せます。音声が同じなら文字起こしを再利用するので数分で終わります。

この機能を使うと、**文字起こしのテキストが ChatGPT（または OpenAI API）に送られます**。音声と画像は送りません。Ollama を選べば Mac の中だけで動きます。

### 5. 更新する

```sh
bash ~/LecScribe-app/update.sh
```

文字起こしの最中なら終わるまで待ってから入れ替えます。

### サーバーについて

インストールするとサーバーが常駐し、ログイン時に自動で起動します。macOS の「設定 → 一般 → ログイン項目と機能拡張」の「アプリのバックグラウンドでのアクティビティ」に **LecScribe Server** として表示されます（「ログイン時に開く」には出ません）。署名していないので「開発元を識別できない項目」と付きます。

ログは `~/Library/Logs/lec-scribe/server.log` にあります。

## 動作要件

### 自分で用意するもの

- Apple Silicon の Mac（macOS 14 以降）
- Chrome 安定版（116 以降）

### 自動で入るもの

`install.sh` が入れます。すでに入っていれば飛ばします。

| | 用途 |
|---|---|
| Homebrew | 以下を入れるために使う |
| whisperkit-cli | 文字起こし |
| ffmpeg | 音声の変換 |
| Node.js | サーバーの実行 |
| Xcode Command Line Tools | 同じ場面の画像をまとめる判定（無くても動きますが、似た画像が並びます） |

### ノートを整える場合だけ

話し言葉を書き言葉に整え、要点と見出しを付ける機能（使い方 4）を使うときだけ必要です。使わないなら要りません。

| | 用途 |
|---|---|
| ChatGPT の有料プラン | Codex CLI から使う。`enable-notes.sh` が導入とログインを案内します |
| （代わりに）Ollama | Mac の中だけで動かす場合。外部には何も送りません |

## 開発

```sh
pnpm install
pnpm build                       # 拡張を extension/dist/chrome-mv3 にビルド
pnpm lint && pnpm typecheck && pnpm test
node scripts/smoke-extension.mjs # headless Chromium で拡張を読み込む統合テスト（push 前に通す）
pnpm fixtures:make && pnpm fixtures:serve   # http://127.0.0.1:8787/player.html
pnpm --filter @lec-scribe/server start -- --llm codex   # サーバーを手で起動
```

常駐サーバーの操作:

```sh
pnpm --filter @lec-scribe/server agent:install    # 登録して起動
pnpm --filter @lec-scribe/server agent:status     # 状態と /health
pnpm --filter @lec-scribe/server agent:restart    # コードを更新したあとに（処理中なら拒む。--force で強制）
pnpm --filter @lec-scribe/server agent:uninstall  # 解除
```

`agent:install` は登録時の `node` のパスと `PATH`（Homebrew の `whisperkit-cli` / `ffmpeg` を含む）を書き込むので、Node を入れ替えたらやり直してください。ターミナルで起動したサーバーが残っているとポートが重なるので、先に止めます。

```text
lec-scribe/
├── extension/   Chrome 拡張（WXT + TypeScript）
│   ├── entrypoints/  background.ts / sidepanel/ / offscreen/ / detector.ts（動画のある frame に注入）
│   └── src/          config, state, messages, format, detect, opfs/（純粋関数は Vitest）
├── server/      Mac ローカルサーバー（Node.js 22 + TypeScript、依存なし）
├── fixtures/    動作確認用のローカルプレイヤーページと合成スライド動画
├── scripts/     スモークテスト
└── docs/        仕様・確認手順
```

| ドキュメント | 内容 |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | 仕様書（設計判断 D-xx、閾値の根拠、設定値一覧） |
| [docs/CHECKS.md](docs/CHECKS.md) | Mac 実機での確認手順と記録。Chrome への読み込み方もここ |

Phase 0〜9（足場、録音、動画検出、フレーム取得、変化検知、タイムライン、文字起こし、統合、ノート）はすべて実装と実機確認を終えています。そのあとも検知の精度・画像のまとめ方・一覧の操作を実際の講義動画で詰めていて、未確認の項目は CHECKS.md の「残っている実機確認」にあります。

## ライセンス

MIT
