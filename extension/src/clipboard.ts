/**
 * ターミナルに貼る 1 行をコピーするボタン（サイドパネルの未接続画面と設定画面で共用）。
 * クリップボードが使えない環境（権限が無い等）ではラベルで手動コピーを促す。
 */
export function bindCopyButton(button: HTMLButtonElement, text: string) {
  const label = button.textContent ?? 'コピー';
  let timer = 0;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'コピーしました';
    } catch {
      button.textContent = '選択してコピーしてください';
    }
    // 連打しても、最後のクリックから 2 秒たってから戻す
    window.clearTimeout(timer);
    timer = window.setTimeout(() => (button.textContent = label), 2000);
  });
}
