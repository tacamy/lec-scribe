# 動作確認手順

tabCapture を伴う確認は Mac 実機でしかできないため、Phase ごとの手動確認手順をここにまとめる。結果は本ファイル末尾の「記録」に追記する。

## 共通: 拡張の読み込み

```sh
pnpm install
pnpm build            # extension/.output/chrome-mv3 が生成される
```

1. Chrome で `chrome://extensions` を開き、右上の「デベロッパーモード」を ON
2. 「パッケージ化されていない拡張機能を読み込む」→ `extension/.output/chrome-mv3` を選択
3. ツールバーの拡張アイコンから LecScribe をピン留め
4. コードを変更したら `pnpm build` → `chrome://extensions` の更新ボタン（↻）

エラーは `chrome://extensions` の LecScribe カード内「エラー」と、service worker の DevTools（カード内の「Service Worker」リンク）、popup の DevTools（popup を右クリック →「検証」）で確認する。

## Phase 1: tabCapture + AirPods パススルー

目的: 講義動画を再生中に Start しても、AirPods から音が途切れず、二重にも聞こえないこと（SPEC D-02、Q-12）。

準備: AirPods 等を接続し、macOS の出力デバイスに選ぶ。大学サイトの講義ページを開き、動画を再生する。

| # | 操作 | 期待 |
|---|---|---|
| 1 | 拡張アイコン → popup | 状態が `● Ready`、`Start` ボタンが表示される |
| 2 | `Start` | 状態が `● Capturing`、経過時間が進む。`Audio` 行が「録音中」になり、レベルメーターが音声に合わせて動く（「無音」表示にならない） |
| 3 | 聞く | AirPods から講義音声がそのまま聞こえる。エコー / リバーブのような二重再生になっていない。音量が変わっていない |
| 4 | タブを見る | タブに「共有中」のインジケータ（録画アイコン）が出る |
| 5 | popup を閉じて開き直す | `● Capturing` のまま、経過時間が継続している |
| 6 | 動画を一時停止 → 再開 | メーターが止まり、再開で動く |
| 7 | `Stop` | 状態が `● Ready` に戻り、フッターに「前回: HH:MM:SS キャプチャ（user）」。動画の音は引き続き AirPods から聞こえる |
| 8 | もう一度 `Start` → `Stop` | 2 回目も同じ挙動 |

異常系:

| # | 操作 | 期待 |
|---|---|---|
| A | `chrome://extensions` など Chrome 内部ページで `Start` | 赤いメッセージ「このページはキャプチャできません…」、状態 `● Error`。`Start` で再試行できる |
| B | キャプチャ中に講義タブを閉じる | popup を開くと `● Ready`、前回の理由が `tab closed` |
| C | キャプチャ中に `chrome://extensions` で拡張を更新（↻） | popup を開くと `● Ready`、前回の理由が `extension restarted` |

二重に聞こえる場合（パススルー不要な環境）:

popup を右クリック →「検証」→ Console で次を実行してから `Start` し直す。

```js
chrome.storage.local.set({ config: { audio: { passthrough: false } } });
```

戻すときは `passthrough: true`。この結果は SPEC D-02 の既定値に反映する。

## Phase 2 以降

各 Phase の実装時に追記する。

## 記録

| 日付 | Phase | 環境 | 結果 | メモ |
|---|---|---|---|---|
| | 1 | | 未実施 | |
