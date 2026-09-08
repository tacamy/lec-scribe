# fixtures

大学サイトなしで Phase 3〜6 を確認するためのローカル素材。

| ファイル | 内容 |
|---|---|
| `player.html` | video.js 風の DOM（`.video-js` > `video.vjs-tech` + `.vjs-control-bar`）で `slides.webm` を再生。再生 / 一時停止 / シーク / 速度変更のボタン付き |
| `make-slides.mjs` | `slides.webm` を生成する。headless Chromium の canvas + MediaRecorder で描画するため ffmpeg 不要（あれば remux して duration / cues を付ける） |
| `serve.mjs` | Range 対応の静的サーバー（`<video>` のシークに必要） |

```sh
pnpm fixtures:make            # 10 枚 × 5 秒、1280×720、ワイプ付き
pnpm fixtures:make -- --slides 6 --seconds 4 --clock
pnpm fixtures:serve           # http://127.0.0.1:8787/player.html
```

`slides.webm` は生成物なので git 管理外。
