# 大学講義動画 文字起こし＆スライドキャプチャ Chrome拡張 仕様書

## 1. 目的

大学のWebサイト上に埋め込まれた講義動画を再生しながら、

1. 動画の音声を取得して日本語に文字起こしする
2. MacのAirPods等から通常どおり音声を聞けるようにする
3. 動画プレイヤー部分だけを対象として、画面が大きく変化したときだけスクリーンショットを保存する
4. 音声の文字起こしとスクリーンショットを動画時間に紐付ける
5. 外部クラウドへ音声・画像を送信せず、可能な限りMac上で処理する

ことを目的とする。

---

# 2. 想定利用環境

- macOS
- Apple Silicon Mac
- Chrome
- Chrome Extensions Manifest V3
- 大学Webサイト上のHTML5/Brightcove動画
- 日本語講義
- MacBook内蔵スピーカーまたはAirPods等のBluetoothイヤホン

開発環境としては、Apple Silicon上でWhisperKitを使用する。

---

# 3. 基本方針

## 3.1 動画の直接ダウンロードは行わない

大学サイトの動画URL、blob URL、HLSのm3u8、署名付きURL等を直接取得・解析・保存する方式には依存しない。

ブラウザ上でユーザーが正当に再生しているタブの音声・映像を、Chromeの`tabCapture` APIを利用して取得する。

DRM、認証、アクセス制御、署名URL等を回避する処理は実装しない。

---

# 4. システム構成

```text
┌──────────────────────────────┐
│ Chrome                       │
│                              │
│ 大学Webサイト                 │
│ ┌──────────────────────────┐ │
│ │ Brightcove Video Player  │ │
│ │                          │ │
│ │      講義動画            │ │
│ │                          │ │
│ └──────────────────────────┘ │
│                              │
│        ↓ chrome.tabCapture   │
│                              │
│ ┌──────────────────────────┐ │
│ │ Chrome Extension         │ │
│ │                          │ │
│ │ ・音声取得               │ │
│ │ ・音声をAirPodsへ返す    │ │
│ │ ・動画領域検出           │ │
│ │ ・画面変化検知           │ │
│ │ ・スクリーンショット保存 │ │
│ │ ・タイムスタンプ管理     │ │
│ └──────────┬───────────────┘ │
└─────────────┼────────────────┘
              │ localhost
              ↓
┌──────────────────────────────┐
│ Mac Local Server             │
│                              │
│ WhisperKit / CoreML          │
│                              │
│ 日本語音声 → テキスト        │
└──────────────────────────────┘
```

---

# 5. Chrome Extension

## 5.1 Manifest

Manifest V3を使用する。

想定構成：

```text
extension/
├── manifest.json
├── background/
│   └── service-worker.ts
├── content/
│   └── video-detector.ts
├── offscreen/
│   └── offscreen.html
│   └── offscreen.ts
├── popup/
│   ├── popup.html
│   └── popup.ts
├── screenshot/
│   └── change-detector.ts
└── shared/
    └── types.ts
```

---

# 6. 動画キャプチャ

Chromeの`chrome.tabCapture`を使用する。

必要なストリーム：

```text
audio: true
video: true
```

ユーザーが拡張機能の「開始」ボタンを押したときにキャプチャを開始する。

---

# 7. AirPodsへの音声出力

`tabCapture`で音声を取得すると、そのままでは元のタブ音声がユーザーに聞こえなくなる可能性がある。

そのため、取得したAudioStreamをWeb Audio APIに接続する。

```text
tabCapture AudioStream
       ↓
MediaStreamAudioSourceNode
       ↓
AudioContext
       ↓
AudioContext.destination
       ↓
Macの通常の出力デバイス
       ↓
AirPods
```

これにより、

**講義動画の音声をAirPodsで聞きながら同時にキャプチャ**

できるようにする。

---

# 8. 音声処理

今回はリアルタイム文字起こしを必須としない。

基本仕様は、

```text
講義開始
 ↓
音声をローカル保存
 ↓
講義終了
 ↓
WhisperKitで一括文字起こし
 ↓
タイムスタンプ付きテキスト生成
```

とする。

リアルタイム文字起こしは将来の拡張機能として設計する。

---

# 9. 音声保存

Chrome側では、取得した音声をローカルに保存できる形式で記録する。

第一候補：

```text
WebM / Opus
```

必要に応じてMac側でWhisperKitが扱いやすい形式へ変換する。

長時間講義を想定し、メモリに全音声を保持しない。

必要に応じてチャンク単位で保存する。

---

# 10. 動画プレイヤー領域の検出

## 10.1 ページ全体をスクリーンショットしない

重要。

スクリーンショット対象は、

**講義動画のプレイヤー領域のみ**

とする。

例えば対象となるHTML5 video：

```html
<video
  id="airUplayerId0_html5_api"
  class="vjs-tech"
  ...
>
</video>
```

のような`video`要素を検出する。

---

# 11. 動画領域の取得

content scriptから、

```javascript
const video = document.querySelector('video');
const rect = video.getBoundingClientRect();
```

等を利用して、

```text
x
y
width
height
```

を取得する。

これをスクリーンショット処理側へ送信する。

---

# 12. 動画領域の変化検知

目的は、

**「10秒ごとに撮影」ではなく、「スライド等が変わったときだけ撮影」**

すること。

ただし、動画再生中は教授の顔、カメラ映像、アニメーション等が常に多少動くため、単純なピクセル差分だけには依存しない。

---

# 13. 変化検知アルゴリズム

基本フロー：

```text
動画フレーム取得
      ↓
動画領域だけcrop
      ↓
小さいサイズに縮小
      ↓
グレースケール化
      ↓
前回保存画像と比較
      ↓
変化率を計算
      ↓
閾値以下
 → 何もしない

閾値以上
 ↓
約500ms待機
 ↓
再度フレーム取得
 ↓
画面が安定しているか確認
 ↓
安定している
 ↓
スクリーンショット保存
```

---

# 14. 変化判定

候補として以下を使用する。

- Mean Absolute Difference
- perceptual hash
- SSIM
- 差分ピクセル率

まずは実装が単純な、

**縮小画像＋グレースケール＋差分率**

で実装する。

閾値は固定値ではなく設定値にする。

例：

```text
changeThreshold: 0.05
```

ただし実際の講義動画で調整できるようにする。

---

# 15. 誤検知対策

以下はスクリーンショット保存のトリガーにしない、または影響を小さくする。

- 動画プレイヤーの再生バー
- 再生時間表示
- マウスカーソル
- 小さな人物の動き
- カメラ映像の微細な変化
- 動画内の小さなアニメーション

可能であれば動画下部のコントロール部分を比較対象から除外する。

---

# 16. スライド変更時の安定化

スライド切り替え直後はアニメーションやフェードが発生する可能性がある。

そのため、

```text
大きな変化を検出
 ↓
500ms待つ
 ↓
再チェック
 ↓
まだ大きく変化している
 → 待機
 ↓
画面が安定
 → 保存
```

とする。

必要に応じて最大待機時間を設定する。

---

# 17. 重複スクリーンショット防止

同じスライドが何度も保存されないようにする。

```text
currentFrame
     ↓
lastSavedFrameと比較
     ↓
十分違う
 → 保存

ほぼ同じ
 → 保存しない
```

---

# 18. 初回スクリーンショット

講義開始時には、画面に変化がなくても1枚保存する。

```text
lecture_start
↓
slide_001.png
```

---

# 19. 一時停止中

動画が一時停止している場合は、変化検知を停止してよい。

再生再開時に再び変化検知を開始する。

---

# 20. スクリーンショットの保存情報

画像だけでなく、メタデータも保存する。

例：

```json
{
  "filename": "slide_003.png",
  "videoTime": 1532.42,
  "capturedAt": "2026-09-07T12:34:56.000Z",
  "width": 1280,
  "height": 720
}
```

特に重要なのは`videoTime`。

---

# 21. 動画再生時間の取得

可能であればHTML5 video elementから、

```javascript
video.currentTime
```

を取得する。

これをスクリーンショットのタイムスタンプとして使用する。

取得できない場合は拡張機能側の経過時間をfallbackとして使用する。

---

# 22. スクリーンショットと文字起こしの連携

最終的には、

```text
00:00:00
slide_001.png

00:12:34
slide_002.png

00:25:18
slide_003.png
```

のように管理する。

文字起こし：

```text
00:00:00
今日は○○について説明します。

00:12:34
ここでは△△について説明します。

00:25:18
次に□□について見ていきます。
```

スクリーンショットの時刻と最も近い文字起こしセグメントを対応させる。

---

# 23. ローカル文字起こし

Mac側ではWhisperKitを使用する。

候補モデル：

```text
Whisper large-v3
```

日本語講義なので、日本語認識を優先する。

外部APIは使用しない。

---

# 24. WhisperKit処理

基本フロー：

```text
WebM / audio chunks
        ↓
Local Mac Server
        ↓
WhisperKit
        ↓
Japanese transcription
        ↓
timestamped segments
```

出力例：

```json
{
  "segments": [
    {
      "start": 0.0,
      "end": 8.5,
      "text": "今日はデザインについて説明します。"
    },
    {
      "start": 8.5,
      "end": 17.2,
      "text": "まず最初に重要なのは..."
    }
  ]
}
```

---

# 25. Mac Local Server

Chrome ExtensionからMac上のWhisperKitへ通信するため、localhostサーバーを使用する。

例：

```text
127.0.0.1:<port>
```

外部ネットワークからアクセスできないよう、

**127.0.0.1のみでlisten**

する。

---

# 26. localhost通信のセキュリティ

拡張機能起動時にランダムなsession tokenを生成する。

```text
Chrome Extension
      ↓
session token
      ↓
localhost server
```

サーバー側ではtokenを検証する。

目的：

他のWebサイトからlocalhostサーバーを勝手に利用されないようにする。

---

# 27. クラウド送信禁止

以下を原則禁止する。

- OpenAI APIへの音声送信
- Google Cloud Speechへの送信
- Azure Speechへの送信
- その他外部STT APIへの送信
- 音声の外部ストレージ保存
- スクリーンショットの外部アップロード

音声・画像・文字起こしは原則としてローカル処理する。

---

# 28. UI

Popup UIはシンプルにする。

```text
┌────────────────────────┐
│ Lecture Capture         │
│                         │
│ ● Ready                 │
│                         │
│ [ Start ]               │
│                         │
│ Audio    ● Capturing    │
│ Slides   ● Detecting    │
│                         │
│ Screenshots: 12         │
│                         │
│ [ Stop ]                │
└────────────────────────┘
```

---

# 29. 状態

以下の状態を持つ。

```text
IDLE
CAPTURING
PROCESSING
COMPLETED
ERROR
```

---

# 30. Start時

Startボタンを押したら：

1. 現在のタブを確認
2. `tabCapture`開始
3. 音声取得
4. AudioContextを通して音声を通常出力へ返す
5. 動画領域を検出
6. 動画フレーム取得開始
7. スライド変化検知開始
8. 音声記録開始
9. 初回スクリーンショット保存
10. UIを`CAPTURING`へ変更

---

# 31. Stop時

Stopボタンを押したら：

1. tabCapture停止
2. 音声記録停止
3. スクリーンショット検知停止
4. 音声データをlocalhostへ送信
5. WhisperKitで文字起こし
6. timestamp付きtranscript生成
7. screenshotとtranscriptを時刻で関連付け
8. TXT/SRT/VTT等を生成
9. 完了状態にする

---

# 32. 出力ファイル

最低限：

```text
lecture/
├── audio.webm
├── transcript.txt
├── transcript.srt
├── transcript.vtt
├── screenshots/
│   ├── slide_001.png
│   ├── slide_002.png
│   └── slide_003.png
└── screenshots.json
```

---

# 33. 将来的な出力

将来的には、

```text
lecture.md
```

を生成する。

例：

```markdown
# 講義タイトル

## 00:00:00

[slide_001.png]

今日は○○について説明します。

## 00:12:34

[slide_002.png]

ここでは△△について説明します。
```

これにより、

**スライド画像＋そのスライドについて話している内容**

をまとめた講義ノートを自動生成できる。

---

# 34. Brightcove対応について

Brightcove固有のAPIを使用する必要はない。

DOM上のHTML5 video elementを優先して検出する。

優先順位：

```text
1. video要素
2. .vjs-tech
3. Brightcove playerのvideo element
4. fallbackとして動画領域をユーザー指定
```

例：

```javascript
document.querySelector('video')
```

または、

```javascript
document.querySelector('.vjs-tech')
```

---

# 35. iframe対応

動画がiframe内にある場合を考慮する。

同一originでアクセス可能ならDOMからvideo elementを取得する。

アクセスできないcross-origin iframeの場合は、

**DOMからvideo elementを取得できないことを前提にfallbackを用意する。**

その場合は動画プレイヤー領域をユーザーが指定できる方式を検討する。

---

# 36. 動画領域の座標更新

ブラウザの、

- ウィンドウサイズ変更
- fullscreen
- zoom
- レスポンシブレイアウト

に対応する。

`ResizeObserver`等を利用して動画領域の座標を更新する。

fullscreen時も動画全体を正しく取得する。

---

# 37. パフォーマンス

変化検知用フレームはフル解像度で比較しない。

例：

```text
1280×720
 ↓
160×90
 ↓
grayscale
 ↓
difference calculation
```

変化を検出して保存するときだけフル解像度画像を保存する。

これによりCPU/GPU負荷とメモリ使用量を抑える。

---

# 38. 長時間講義への対応

90分〜180分程度の講義を想定する。

以下を避ける：

- 全音声をRAMに保持
- 全フレームをRAMに保持
- 1秒ごとの画像保存
- 数千枚の不要なスクリーンショット

スクリーンショットはスライド変更時のみ保存する。

---

# 39. エラー処理

以下の場合はUIに明確なエラーを表示する。

```text
tabCapture開始失敗
video elementが見つからない
動画領域取得失敗
音声取得失敗
localhost server接続失敗
WhisperKit処理失敗
ディスク容量不足
```

---

# 40. MVP開発順序

いきなり全部作らない。

## Phase 1

**tabCapture + AirPods音声出力**

目的：

```text
講義動画を再生
↓
tabCapture
↓
AirPodsから普通に聞こえる
```

ここを最初に確認。

---

## Phase 2

**音声録音**

```text
tabCapture
↓
audio capture
↓
audio.webm保存
```

---

## Phase 3

**動画領域検出**

```text
video element
↓
getBoundingClientRect()
↓
動画領域を取得
```

---

## Phase 4

**動画領域だけのフレーム取得**

動画部分だけをcropできることを確認。

ページ全体を保存しない。

---

## Phase 5

**変化検知**

```text
frame
↓
resize
↓
grayscale
↓
difference
↓
threshold
```

---

## Phase 6

**スライド保存**

画面変化時だけ、

```text
slide_001.png
slide_002.png
...
```

を保存。

---

## Phase 7

**WhisperKit**

音声ファイルをMac Local Serverへ渡し、

```text
Japanese speech
↓
WhisperKit
↓
timestamped transcript
```

を実装。

---

## Phase 8

**統合**

```text
Audio
+
Slide screenshots
+
Video timestamps
+
Transcript
```

を1つの講義データとして管理。

---

# 41. 最終的なユーザー体験

ユーザーは大学の講義ページをChromeで開き、動画を再生する。

その後、

```text
Lecture Capture
[ Start ]
```

を押す。

すると、

```text
講義音声
  ↓
AirPodsで普通に聞こえる

同時に

音声
  ↓
ローカル保存

動画プレイヤー
  ↓
画面変化を監視
  ↓
スライド変更時だけ保存
```

となる。

講義終了後にStopを押す。

その後Mac上で、

```text
WhisperKit
↓
日本語文字起こし
```

を実行し、

```text
講義音声
＋
スライド画像
＋
動画時間
＋
文字起こし
```

を統合した講義資料を生成する。

---

# 42. 実装上の重要な制約

以下は実装しない。

- Brightcoveのm3u8を直接取得する処理
- blob URLから動画ファイルを抽出する処理
- Fastly tokenを解析・再利用する処理
- AES-128等の暗号化ストリームを復号する処理
- DRM回避
- 大学サイトの認証回避
- アクセス制御回避

あくまで、

**ユーザーがChrome上で正当に再生しているタブを`chrome.tabCapture`でキャプチャする**

方式とする。

---

# 43. 最重要要件まとめ

### 必須

- Chrome Extension Manifest V3
- `chrome.tabCapture`
- タブ音声キャプチャ
- AirPods等への音声再出力
- 動画プレイヤー領域のみキャプチャ
- スライド変化検知
- 変化時のみスクリーンショット保存
- 動画時間との紐付け
- ローカル音声保存
- WhisperKitによる日本語文字起こし
- タイムスタンプ付き文字起こし
- 長時間講義対応
- クラウドへの音声・画像送信なし

### 非必須・将来拡張

- リアルタイム文字起こし
- 自動要約
- 講義ノートMarkdown生成
- スライドごとの文字起こし整理
- キーワード抽出
- 講義内容検索

---

# 44. Claude Codeへの実装指示

まずPhase 1だけを実装する。

**Phase 1を完成・動作確認してから次のPhaseへ進むこと。**

特に、

```text
tabCapture
↓
AudioContext
↓
destination
↓
AirPods
```

が正常に動作することを確認する。

その後、Phase 2以降を段階的に実装する。

各Phaseで、

1. 実装
2. ビルド
3. Chrome Extensionとしてロード可能か確認
4. エラー確認
5. 次のPhaseへ進む

という順番で進める。

最終的に、

**「大学講義動画をChromeで再生 → Start → AirPodsで視聴しながら音声をローカル録音 → スライドが変わったときだけ動画プレイヤー部分を画像保存 → Stop → WhisperKitで日本語文字起こし → スライドと文字起こしを時間軸で統合」**

が完成形。