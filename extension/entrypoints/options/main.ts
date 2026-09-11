import { bindCopyButton } from '../../src/clipboard';
import { loadConfig, saveConfig, type Config } from '../../src/config';
import { APP_DIR, UPDATE_COMMAND, fetchHealth, outdatedMessage, serverOutdated } from '../../src/health';
import { sendToBackground } from '../../src/messages';

/** 設定画面（SPEC §15.2）。ローカルサーバーとの接続 */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const port = $<HTMLInputElement>('port');
const token = $<HTMLInputElement>('token');
const result = $('result');
const pairStatus = $('pairStatus');
const notesStatus = $('notesStatus');
const notesHint = $('notesHint');
const notesCmd = $('notesCmd');
const NOTES_COMMAND = `bash ${APP_DIR}/enable-notes.sh`;
notesCmd.textContent = NOTES_COMMAND;
bindCopyButton($<HTMLButtonElement>('copyNotesCmd'), NOTES_COMMAND);

let config: Config = await loadConfig();
port.value = String(config.server.port);
token.value = config.server.token;
renderPairStatus();

function show(text: string, ok: boolean | null = null) {
  result.textContent = text;
  result.className = `result${ok === null ? '' : ok ? ' ok' : ' ng'}`;
}

function renderPairStatus() {
  const connected = config.server.paired && config.server.token.length > 0;
  pairStatus.textContent = connected ? '接続済み（この Mac のサーバーが承認済み）' : config.server.token ? 'トークンで接続' : '未接続';
  pairStatus.className = `result${connected ? ' ok' : ''}`;
}

function readForm(): Config {
  const value = token.value.trim();
  // トークンを消したら承認済みの記録も外す（次はポップアップの「このMacと接続」からやり直す）
  return {
    ...config,
    server: { ...config.server, port: Number(port.value) || 47321, token: value, paired: value.length > 0 && config.server.paired },
  };
}

const LLM_LABEL: Record<string, string> = { codex: 'Codex CLI', openai: 'OpenAI API', ollama: 'Ollama' };

/** 遅れて届いた古い /health の結果で、新しい表示を上書きしないための世代番号 */
let notesGeneration = 0;

/**
 * ノート作成の状態を出す。llm を返さないサーバー（この機能より前の版）と、
 * そもそも繋がらない場合は「分からない」扱いにして、有効化の案内は出さない
 * （古いサーバーには enable-notes.sh がまだ無く、実行しても失敗するため）
 */
function renderNotes(llm: string | undefined, reachable = true) {
  const enabled = !!llm && llm !== 'none';
  const unknown = !reachable || llm === undefined;
  notesStatus.textContent = !reachable
    ? 'サーバーに接続できないため分かりません'
    : llm === undefined
      ? `サーバーが古いため分かりません。ターミナルで ${UPDATE_COMMAND} を実行して更新してください`
      : enabled
        ? `有効（${LLM_LABEL[llm] ?? llm}）`
        : '無効（notes.md は文字起こしそのまま）';
  notesStatus.className = `result${enabled ? ' ok' : ''}`;
  notesHint.hidden = enabled || unknown;
}

// 開いた時点のサーバーの状態を出す（接続テストを押さなくても分かるように）
const initialCheck = ++notesGeneration;
void fetchHealth(config.server)
  .then((body) => {
    if (initialCheck === notesGeneration) renderNotes(body.llm);
  })
  .catch(() => {
    if (initialCheck === notesGeneration) renderNotes(undefined, false);
  });

/** 「このMacと接続」: サーバーが Mac にダイアログを出し、「許可」で承認される */
$('pair').addEventListener('click', async () => {
  config = readForm();
  await saveConfig(config);
  show('Mac の画面に確認ダイアログが出ます。「許可」を押してください…');
  try {
    // 承認と保存は service worker が行う（ポップアップからも同じ経路）
    await sendToBackground.pair();
    config = await loadConfig();
    token.value = config.server.token;
    renderPairStatus();
    show('接続しました。', true);
  } catch (e) {
    show(e instanceof Error ? e.message : String(e), false);
  }
});

$('save').addEventListener('click', async () => {
  config = readForm();
  await saveConfig(config);
  show('保存しました', true);
});

$('test').addEventListener('click', async () => {
  const { server } = readForm();
  show('接続中…');
  try {
    const body = await fetchHealth(server);
    const lines = [`サーバー v${body.version ?? '?'} に接続できました${body.commit ? `（${body.commit}）` : ''}`];
    if (serverOutdated(body)) lines.push(outdatedMessage(body));
    lines.push(`承認: ${body.paired ? '済み' : server.token ? (body.authorized ? 'トークンで OK' : 'トークンが一致しません') : '未承認（「このMacと接続」を押してください）'}`);
    lines.push(`whisperkit-cli: ${body.whisperkit ? 'あり' : 'なし'} / ffmpeg: ${body.ffmpeg ? 'あり' : 'なし'}`);
    if (body.model) lines.push(`モデル: ${body.model} / 出力先: ${body.outDir ?? ''}`);
    notesGeneration++; // 進行中の初回チェックの結果で上書きされないようにする
    renderNotes(body.llm);
    // サーバー側の承認状態を設定にも反映する（trusted.json を消したときなど）
    if (body.paired !== undefined && body.paired !== config.server.paired) {
      config = { ...config, server: { ...config.server, paired: body.paired } };
      await saveConfig(config);
      renderPairStatus();
    }
    show(lines.join('\n'), body.authorized === true && body.whisperkit === true && body.ffmpeg === true);
  } catch (e) {
    show(`接続できません（127.0.0.1:${server.port}）。サーバーを起動してください。\n${e instanceof Error ? e.message : String(e)}`, false);
  }
});
