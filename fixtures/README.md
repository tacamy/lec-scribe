# fixtures

実サイトなしで Phase 3〜6 を確認するためのローカル素材。

| ファイル | 内容 |
|---|---|
| `player.html` | video.js 風の DOM（`.video-js` > `video.vjs-tech` + `.vjs-control-bar`）で `slides.webm` を再生。再生 / 一時停止 / シーク / 速度変更のボタン付き |
| `make-slides.mjs` | `slides.webm` を生成する。headless Chromium の canvas + MediaRecorder で描画するため ffmpeg 不要（あれば remux して duration / cues を付ける） |
| `serve.mjs` | Range 対応の静的サーバー（`<video>` のシークに必要） |

```sh
pnpm fixtures:make            # 10 枚 × 5 秒、1280×720、ワイプ付き
pnpm fixtures:make -- --slides 6 --seconds 4 --clock
pnpm fixtures:make -- --out other.webm   # 別の名前で作る（player.html?video=other.webm で再生）
pnpm fixtures:serve           # http://127.0.0.1:8787/player.html
```

`slides.webm` は生成物なので git 管理外。

スモークテスト（`scripts/smoke-extension.mjs`）は自分用の `slides.smoke.webm`（3 枚 × 3 秒、640×360）を `--out` で作り、`player.html?video=slides.smoke.webm` で再生する。手作業の確認に使う `slides.webm` とは別のファイルなので、互いに上書きしない。
