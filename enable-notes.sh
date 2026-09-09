#!/bin/bash
# 文字起こしをそのまま置くのをやめ、話し言葉を整えて要点を付けた notes.md を作れるようにする。
#
#   bash ~/LecScribe-app/enable-notes.sh          # Codex CLI（ChatGPT の定額枠。API キー不要）
#   bash ~/LecScribe-app/enable-notes.sh ollama   # ローカルの Ollama（テキストも Mac の外に出ない）
#   bash ~/LecScribe-app/enable-notes.sh none     # 無効に戻す
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
KIND="${1:-codex}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

if [ -x /opt/homebrew/bin/brew ] && ! command -v brew >/dev/null 2>&1; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi

case "$KIND" in
  codex)
    if ! command -v codex >/dev/null 2>&1; then
      say "Codex CLI を入れます"
      command -v brew >/dev/null 2>&1 || fail "Homebrew が必要です。先に install.sh を実行してください。"
      brew install --cask codex
    fi
    if ! codex login status >/dev/null 2>&1; then
      say "Codex にログインします（ブラウザが開きます）"
      codex login
    fi
    say "ノート作成を有効にします（codex）"
    LEC_SCRIBE_LLM=codex node "$APP_DIR/server/scripts/agent.mjs" install
    ;;
  ollama)
    command -v ollama >/dev/null 2>&1 || fail "Ollama が見つかりません。https://ollama.com から入れて、モデル（例: ollama pull qwen2.5:32b）を用意してください。"
    say "ノート作成を有効にします（ollama）"
    LEC_SCRIBE_LLM=ollama node "$APP_DIR/server/scripts/agent.mjs" install
    ;;
  none)
    say "ノート作成を無効にします（notes.md は文字起こしそのままになります）"
    LEC_SCRIBE_LLM=none node "$APP_DIR/server/scripts/agent.mjs" install
    ;;
  *)
    fail "使い方: bash enable-notes.sh [codex|ollama|none]"
    ;;
esac

say "✓ 設定しました"
echo "  これから文字起こしする分に反映されます。すでにある分は拡張の一覧の「やり直す」で作り直せます（文字起こしは再利用されるので数分）。"
