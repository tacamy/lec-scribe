# LecScribe — 開発メモ（Claude Code 用）

大学講義動画の音声をローカル録音し、スライドが変わったときだけ動画領域を画像保存し、Mac 上の WhisperKit で日本語文字起こしをして統合する Chrome 拡張（MV3）+ Mac ローカルサーバー。すべてローカル処理。動画ファイルの直接取得や DRM / 認証の回避は実装しない。

## 正とする文書

- `docs/SPEC.md` — 仕様（設計判断 D-xx、未決事項 Q-xx、Phase 0〜8 と完了条件）。設計を変えたらここを更新する
- `docs/CHECKS.md` — Phase ごとの Mac 実機での確認手順と記録。Phase を実装したら手順を追記し、結果を記録する
- `README.md` の「状態」表 — Phase の進捗

## 構成

- `extension/` — WXT + TypeScript。`entrypoints/background.ts`（service worker、状態機械）、`entrypoints/offscreen/`（tabCapture のストリームと録音の正本）、`entrypoints/sidepanel/`（同じページをポップアップ `?mode=popup` とサイドパネルで使う）、`entrypoints/detector.ts`（Start 時に動画のある frame へ `chrome.scripting.executeScript` で注入する検知スクリプト。`src/probe.ts` の `probeVideos` は `func` として文字列注入されるので外部参照禁止）、`src/`（config / state / messages / format / probe / opfs）
- `server/` — Node 22 + TypeScript、ランタイム依存なし。Phase 7 で ffmpeg と whisperkit-cli を呼ぶ
- `fixtures/` — video.js 風プレイヤーページと合成スライド動画（Phase 3〜6 の確認用）
- `scripts/smoke-extension.mjs` — headless Chromium に拡張を読み込む統合テスト

## コマンド

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build   # ビルド先は extension/dist/chrome-mv3
node scripts/smoke-extension.mjs           # push 前に必ず通す
pnpm fixtures:make && pnpm fixtures:serve  # http://127.0.0.1:8787/player.html
```

## 進め方の約束

- Phase は順番に。実装 → ビルド → スモークテスト → `docs/CHECKS.md` に手順追記 → Mac 実機で確認 → 記録 → 次へ
- tabCapture は headless では動かないので、Phase 1・2・7・8 相当の確認は Mac 実機で行う
- permission は必要になった Phase で追加する。`<all_urls>` は要求しない
- 拡張の状態の正本は `chrome.storage.session` と offscreen document。service worker はいつ止まってもよい前提で書く
- service worker の状態更新は `serialized()` を通す（並行イベントで書き戻しが競合するため）
- 録音中のデータは OPFS に逐次書き込み、Stop 後に外へ出す。「破棄」は OPFS の分だけ消す
- コミットは英語、ドキュメントと UI 文言は日本語。コードコメントも日本語（Phase 2 以前の英語コメントは触ったときに直す）
- コード変更後は `pnpm lint`（oxlint）と `pnpm typecheck` を通す
- `scripts/smoke-extension.mjs` は fixture サーバーを自前で立てる（`fixtures/slides.webm` がなければ生成する）
