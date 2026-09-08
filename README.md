# LecScribe

大学講義動画を Chrome で再生しながら、音声をローカル録音し、スライドが切り替わったときだけ動画領域のスクリーンショットを保存し、講義後に Mac 上の WhisperKit で日本語文字起こしを行って、スライドと文字起こしを時間軸で統合した講義ノートを生成する Chrome 拡張（Manifest V3）と Mac ローカルサーバー。

- 音声・画像・文字起こしはすべて Mac 内で処理し、外部クラウドへ送信しない
- 動画ファイルの直接取得や DRM / 認証 / アクセス制御の回避は行わない。`chrome.tabCapture` でユーザーが正当に再生中のタブを取り込むだけ

## 状態

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 足場（pnpm workspace、WXT、Vitest、Playwright スモーク、fixture、CI） | 完了 |
| 1 | tabCapture + 音声パススルー | 完了（Mac で確認済み: パススルー動作、二重再生なし） |
| 2 | 録音（OPFS へ逐次保存 → エクスポート） | 完了（Mac で確認済み） |
| 3 | 講義ページの `<video>` 検出と状態追跡 | 完了（Mac で確認済み） |
| 4 | `<video>` からのフレーム取得と画像保存（開始時 1 枚 + 手動） | 完了（Mac で確認済み） |
| 5 | 画面変化の自動検知 | 完了（Mac で確認済み） |
| 6 | 再生イベントのタイムライン記録（録音時刻 ⇄ 動画時刻） | 完了（Mac で確認済み） |
| 7 | Mac ローカルサーバー + ffmpeg + WhisperKit で文字起こし | 完了（Mac で確認済み。131 秒の録音を 2 回目 42 秒で処理） |
| 8 | スライドと文字起こしの統合（`lecture.md`） | 実装済み。Mac 実機での確認待ち（[docs/CHECKS.md](docs/CHECKS.md)） |

| ドキュメント | 内容 |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | 仕様書 v0.3（現行。設計判断 D-xx と未決事項 Q-xx を含む） |
| [docs/CHECKS.md](docs/CHECKS.md) | Phase ごとの手動確認手順と記録 |

## 使い方（開発中）

```sh
pnpm install
pnpm build                       # 拡張を extension/dist/chrome-mv3 にビルド
pnpm typecheck && pnpm test      # 型検査と単体テスト
node scripts/smoke-extension.mjs # headless Chromium で拡張を読み込むスモークテスト
pnpm fixtures:make               # 合成スライド動画を生成（Phase 3 以降で使用）
pnpm fixtures:serve              # http://127.0.0.1:8787/player.html
pnpm --filter @lec-scribe/server start   # ローカルサーバー。初回起動時にトークンを表示するので拡張の設定に貼る
```

ツールバーのアイコンのポップアップから Start すると、サイドパネルが開いて録音中の状態を表示します。Chrome への読み込み方と各 Phase の確認項目は [docs/CHECKS.md](docs/CHECKS.md) を参照。

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

## ライセンス

MIT
