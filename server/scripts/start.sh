#!/bin/sh
# LecScribe Server の起動スクリプト。launchd が ~/Applications/LecScribe Server.app 経由でこれを exec する。
#
# node の探し方と起動フラグはここに置く（#10）。launcher と plist はこのファイルを指すだけなので、
# 起動コマンドを変えるコミットも git の更新（自動更新を含む）だけで効き、利用者が agent.mjs install を
# やり直す必要がない。
#
# 引数: $1 = 予備の node（登録時の process.execPath）。PATH（plist に書いた登録時の PATH）に node が
# 見つからないときだけ使う。登録時の実体パス（Homebrew の Cellar など）は brew upgrade で消えることが
# あるので、予備にしか使わない
# server/ の絶対パス（cd と pwd で .. を含まない形にする）
SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node 2>/dev/null || true)"
[ -x "$NODE" ] || NODE="${1:-}"
if [ ! -x "$NODE" ]; then
  # 変数は ${} で囲む。macOS の /bin/sh（bash 3.2）は $PATH の直後に全角の「）」が来ると展開を壊す
  echo "node が見つかりません（PATH: ${PATH}）。brew install node のあと agent.mjs install をやり直してください" >&2
  exit 1
fi
exec "${NODE}" --experimental-strip-types "${SERVER_DIR}/src/index.ts"
