#!/bin/sh
# LecScribe Server の起動スクリプト。launchd が ~/Applications/LecScribe Server.app 経由でこれを exec する。
#
# node の探し方と起動フラグはここに置く（#10）。launcher と plist はこのファイルを指すだけなので、
# 起動コマンドを変えるコミットも git の更新（自動更新を含む）だけで効き、利用者が agent.mjs install を
# やり直す必要がない。
#
# 環境変数 LEC_SCRIBE_NODE: 予備の node（登録したときの実体パス）。PATH（plist に書いた登録時の PATH）に
# 使える node が無いときだけ使う。登録時の実体パスは brew upgrade で消えることがあるので予備にしか使わない。
# 引数はそのままサーバーに渡す（--port など。SPEC 付録 A）
set -eu

# server/ の絶対パス。dirname も cd も失敗しうるので、結果は下で確かめる
SERVER_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)" || SERVER_DIR=''
ENTRY="$SERVER_DIR/src/index.ts"
if [ -z "$SERVER_DIR" ] || [ ! -f "$ENTRY" ]; then
  echo "サーバー本体が見つかりません（${0} から見た ${ENTRY}）。リポジトリを置き直したなら agent.mjs install をやり直してください" >&2
  exit 1
fi

# --experimental-strip-types で TypeScript をそのまま動かすので Node 22 以上が要る。
# 古い node が PATH の先にいると（nvm、brew の node@20）「bad option」で起動できず、
# launchd が 10 秒ごとに起動し直し続ける。版を見て、駄目なら予備に落とす
usable() {
  [ -n "${1:-}" ] && [ -x "${1:-}" ] || return 1
  _v="$("$1" --version 2>/dev/null)" || return 1
  _major="${_v#v}"
  _major="${_major%%.*}"
  case "$_major" in '' | *[!0-9]*) return 1 ;; esac
  [ "$_major" -ge 22 ]
}

NODE=''
for _candidate in "$(command -v node 2>/dev/null || true)" "${LEC_SCRIBE_NODE:-}"; do
  if usable "$_candidate"; then
    NODE="$_candidate"
    break
  fi
done
if [ -z "$NODE" ]; then
  # 変数は ${} で囲む。macOS の /bin/sh（bash 3.2）は $PATH の直後に全角の「）」が来ると展開を壊す
  echo "使える node（22 以上）が見つかりません（PATH: ${PATH}）。brew install node のあと agent.mjs install をやり直してください" >&2
  exit 1
fi

exec "${NODE}" --experimental-strip-types "${ENTRY}" "$@"
