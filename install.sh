#!/bin/bash
# LecScribe の Mac 側サーバーを入れて常駐させる。利用者はターミナルでこの 1 行を実行する:
#
#   curl -fsSL https://raw.githubusercontent.com/tacamy/lec-scribe/main/install.sh | bash
#
# やること: Homebrew（無ければ）→ node / git / ffmpeg / whisperkit-cli → リポジトリを ~/LecScribe-app に取得 →
# launchd にサーバーを登録して /health を確認。Chrome 拡張はウェブストアから入れる前提で、ここでは触らない。
# 環境変数: LEC_SCRIBE_APP_DIR（置き場所）、LEC_SCRIBE_REPO / LEC_SCRIBE_BRANCH（取得元）、
#           LEC_SCRIBE_LLM=codex などはそのまま常駐サーバーに渡る。
set -euo pipefail

APP_DIR="${LEC_SCRIBE_APP_DIR:-$HOME/LecScribe-app}"
REPO="${LEC_SCRIBE_REPO:-https://github.com/tacamy/lec-scribe.git}"
BRANCH="${LEC_SCRIBE_BRANCH:-main}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "macOS 専用です。"
[ "$(uname -m)" = "arm64" ] || fail "Apple Silicon（M1 以降）の Mac が必要です（WhisperKit が Intel Mac に対応していません）。"

# 1. Homebrew
if ! command -v brew >/dev/null 2>&1; then
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  else
    say "Homebrew を入れます（Mac のパスワードを聞かれます）"
    # curl | bash で動いているときは stdin がパイプなので、Homebrew のインストーラーが対話できるよう端末を渡す
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
fi

# 1.5 Xcode Command Line Tools（git の実体。Homebrew を入れたときに一緒に入るが、無ければここで入れる）
if ! xcode-select -p >/dev/null 2>&1; then
  say "Xcode Command Line Tools を入れます（ダイアログで「インストール」を押してください）"
  xcode-select --install || true
  until xcode-select -p >/dev/null 2>&1; do sleep 10; done
fi

# 2. 必要なコマンド
say "必要なコマンドを確認します"
need=()
command -v node >/dev/null 2>&1 || need+=(node)
command -v git >/dev/null 2>&1 || need+=(git)
command -v ffmpeg >/dev/null 2>&1 || need+=(ffmpeg)
command -v whisperkit-cli >/dev/null 2>&1 || need+=(whisperkit-cli)
if [ ${#need[@]} -gt 0 ]; then
  say "Homebrew で入れます: ${need[*]}"
  brew install "${need[@]}"
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || fail "Node.js 22 以上が必要です（今: $(node -v)）。brew upgrade node を実行してください。"

# 3. サーバーのコードを取得
if [ -d "$APP_DIR/.git" ]; then
  say "既にあるので更新します: $APP_DIR"
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet -B "$BRANCH" FETCH_HEAD
else
  say "取得します: $REPO → $APP_DIR"
  git clone --quiet --branch "$BRANCH" --depth 1 "$REPO" "$APP_DIR"
fi

# 4. 常駐サーバーを登録（サーバーは Node 標準機能だけで動くので pnpm install は不要）
say "サーバーを登録します"
node "$APP_DIR/server/scripts/agent.mjs" install

# 5. 見た目や字幕が同じ画像をまとめる補助コマンド（macOS の Vision で画像比較と文字認識をする小さな Swift プログラム）を先に作っておく。
#    初回の文字起こしで作ると数十秒待たせるのと、失敗するならここで分かるようにするため
say "画像の比較に使う補助コマンドを作ります（数十秒）"
# パスは環境変数で渡す（引用符や # を含むパスでも壊れないように）
LEC_SCRIBE_VISION_SRC="$APP_DIR/server/src/vision.ts" node --experimental-strip-types -e "import(process.env.LEC_SCRIBE_VISION_SRC).then((m) => m.ensureVisionHelper((line) => console.log('  ' + line))).then((bin) => console.log(bin ? '  作りました: ' + bin : '  作れませんでした（見た目の判定なしで動きます）'))" || true

say "✓ LecScribe サーバーの準備ができました"
cat <<MSG
  Chrome のツールバーの LecScribe アイコンを押して「このMacと接続」→ Mac の画面で「許可」を押してください。

  ノート（任意）: いまは文字起こしをそのまま置きます。話し言葉を整えて要点を付けるには:
    bash "$APP_DIR/enable-notes.sh"
  更新するときは:
    bash "$APP_DIR/update.sh"
MSG
