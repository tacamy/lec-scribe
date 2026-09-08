# LecScribe

大学講義動画を Chrome で再生しながら、音声をローカル録音し、スライドが切り替わったときだけ動画領域のスクリーンショットを保存し、講義後に Mac 上の WhisperKit で日本語文字起こしを行って、スライドと文字起こしを時間軸で統合した講義ノートを生成する Chrome 拡張（Manifest V3）と Mac ローカルサーバー。

- 音声・画像・文字起こしはすべて Mac 内で処理し、外部クラウドへ送信しない
- 動画ファイルの直接取得や DRM / 認証 / アクセス制御の回避は行わない。`chrome.tabCapture` でユーザーが正当に再生中のタブを取り込むだけ

## 状態

仕様検討中（実装未着手）。

| ドキュメント | 内容 |
|---|---|
| [docs/SPEC.md](docs/SPEC.md) | 仕様書 v0.2（現行。設計判断 D-xx と未決事項 Q-xx を含む） |
| [docs/spec-v0.1-original.md](docs/spec-v0.1-original.md) | 原案 v0.1 |

## 予定構成

```text
lec-scribe/
├── extension/   Chrome 拡張（WXT + TypeScript）
├── server/      Mac ローカルサーバー（Node.js 22 + TypeScript）
├── fixtures/    動作確認用のローカルプレイヤーページと合成スライド動画
└── docs/        仕様・調整記録
```

## 動作要件（予定）

- macOS 14 以降、Apple Silicon
- Chrome 安定版
- Node.js 22、pnpm
- `brew install whisperkit-cli ffmpeg`

## ライセンス

MIT
