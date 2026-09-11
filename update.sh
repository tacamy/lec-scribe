#!/bin/bash
# LecScribe の Mac 側サーバーを最新にして再起動する:  bash ~/LecScribe-app/update.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
BRANCH="${LEC_SCRIBE_BRANCH:-main}"
if [ -x /opt/homebrew/bin/brew ] && ! command -v node >/dev/null 2>&1; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi

printf '\n\033[1m%s\033[0m\n' "更新します: $APP_DIR"
git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
git -C "$APP_DIR" merge --ff-only FETCH_HEAD

# 文字起こし中なら終わるまで待ってから再起動する（agent restart は処理中だと拒む）
port="${LEC_SCRIBE_PORT:-47321}"
for i in $(seq 1 120); do
  # サーバーが止まっていれば待たずに進む（curl が失敗したら busy=0）
  busy="$(curl -fsS "http://127.0.0.1:$port/health" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).processing||0))}catch{process.stdout.write("0")}})')" || busy=0
  if [ "$busy" = "0" ]; then break; fi
  [ "$i" = "1" ] && echo "文字起こし中です。終わるまで待ちます…（Ctrl+C で中断）"
  sleep 15
done
# install は plist と launcher を作り直しつつ、今の LEC_SCRIBE_* を引き継ぐ（restart では作り直されない）
node "$APP_DIR/server/scripts/agent.mjs" install
