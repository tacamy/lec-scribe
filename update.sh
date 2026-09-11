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
# 画像の比較に使う補助コマンド（imagefp.swift が変わっていれば作り直す）。
# 次の文字起こしの途中でビルドが始まって待たせないように、ここで作っておく
LEC_SCRIBE_VISION_SRC="$APP_DIR/server/src/vision.ts" node --experimental-strip-types -e "import(process.env.LEC_SCRIBE_VISION_SRC).then((m) => m.ensureVisionHelper((line) => console.log('  ' + line)))" || true

node "$APP_DIR/server/scripts/agent.mjs" restart
