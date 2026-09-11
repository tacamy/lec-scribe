# LecScribe

講義動画を見ながら、話の内容と画面を Mac の中だけでノートにまとめる Chrome 拡張です。

ページに `<video>` で埋め込まれた動画（Brightcove などの `blob:` 再生を含む）を再生すると、音声を録音し、スライドが切り替わったときだけ画面を保存します。見終わると Mac 上の WhisperKit が日本語で文字起こしし、スライドと本文を時間順に並べたノート（Markdown）ができます。

- 音声・画像・文字起こしはすべて Mac 内で処理し、外部に送りません（ノートを整える機能だけは例外。後述）
- 動画ファイルの取得や DRM / 認証 / アクセス制御の回避は行いません。再生中のタブの音と画面を取り込むだけです

## できること

**録音と画面の保存**

- タブの音声を録音します。再生中の音はイヤホンからそのまま聞こえます
- スライドが切り替わったときだけ画面を保存します。講師のワイプが動いただけ、映像の中で被写体が動いただけでは保存しません
- 文字が 1 行ずつ出るスライドは、次に進んだ瞬間に全部出た状態で保存し直します
- 保存したときは動画の右下にサムネイルが 2.5 秒出るので、画面を見ていなくても撮れたことが分かります
- 手動で「今の画面を保存」もできます

**文字起こしとノート**

- 日本語の文字起こしを WhisperKit（`large-v3`）で行います
- スライド画像と本文を時間順に並べた `notes.md` を作ります。画像は文の途中には入りません
- 同じ場面の画像が何枚も撮れたときは、まとめて 1 枚だけ載せます（見た目の近さ、写っている文字、色の分布で判定。画像自体は残ります）
- 「ご視聴ありがとうございました」のような、話していないのに現れる文を取り除きます
- 任意で、話し言葉を書き言葉に整え、全体の要点と話題ごとの見出し・要点を付けられます

**作業のしかた**

- 文字起こしの最中に次の動画の録音を始められます。Stop すると順番待ちに並びます
- 一覧の「やり直す」で、録音し直さずにノートだけ作り直せます。音声が同じなら文字起こしを再利用するので数分で終わり、本文も同じならノートの結果も使い回すので数秒で終わります
- 処理中は「中止」で止められます。要らない録音は「削除」、残しておくが一覧から消したいものは「非表示」にできます

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

利用者に必要なものは 2 つだけです。残りは `install.sh` が入れます。

- Apple Silicon の Mac（macOS 14 以降）
- Chrome 安定版（116 以降）

`install.sh` が入れるもの: Xcode Command Line Tools、Homebrew、Node.js、ffmpeg、whisperkit-cli。ノートを整える機能を使う場合は `enable-notes.sh` が Codex CLI を入れ、ChatGPT アカウントでのログインを案内します（ChatGPT の有料プランが要ります。Ollama を選べば不要です）。

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
