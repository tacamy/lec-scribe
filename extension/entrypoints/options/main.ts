import { bindCopyButton } from '../../src/clipboard';
import { loadConfig, saveConfig, type Config } from '../../src/config';
import { APP_DIR, ForeignServerError, UPDATE_COMMAND, fetchHealth, outdatedMessage, serverOutdated, visionLine, type Health } from '../../src/health';
import { sendToBackground } from '../../src/messages';

/** 設定画面（SPEC §15.2）。ローカルサーバーとの接続。ポートとトークンの欄は置かない（2026-09-18） */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const result = $('result');
const pairStatus = $('pairStatus');
const unpairBtn = $<HTMLButtonElement>('unpair');
const notesStatus = $('notesStatus');
const notesHint = $('notesHint');
const notesCmd = $('notesCmd');
const NOTES_COMMAND = `bash ${APP_DIR}/enable-notes.sh`;
notesCmd.textContent = NOTES_COMMAND;
bindCopyButton($<HTMLButtonElement>('copyNotesCmd'), NOTES_COMMAND);

let config: Config = await loadConfig();
renderPairStatus();

function show(text: string, ok: boolean | null = null) {
  result.textContent = text;
  result.className = `result${ok === null ? '' : ok ? ' ok' : ' ng'}`;
}

function renderPairStatus() {
  const connected = config.server.paired && config.server.token.length > 0;
  // トークンだけあって承認の記録がないのは、手で貼っていた頃（2026-09-09 より前）の設定
  pairStatus.textContent = connected ? '接続済み（この Mac のサーバーが承認済み）' : config.server.token ? 'トークンで接続' : '未接続';
  pairStatus.className = `result${connected ? ' ok' : ''}`;
  unpairBtn.hidden = !config.server.token;
}


const LLM_LABEL: Record<string, string> = { codex: 'Codex CLI', openai: 'OpenAI API', ollama: 'Ollama' };

/** 遅れて届いた古い /health の結果で、新しい表示を上書きしないための世代番号 */
let notesGeneration = 0;

/**
 * ノート作成の状態を出す。llm を返さないサーバー（この機能より前の版）と、
 * そもそも繋がらない場合は「分からない」扱いにして、有効化の案内は出さない
 * （古いサーバーには enable-notes.sh がまだ無く、実行しても失敗するため）
 */
/** ノート作成の状態。health が null なら繋がらなかったとき */
function renderNotes(health: Health | null) {
  const llm = health?.llm;
  const enabled = !!llm && llm !== 'none';
  // 「古いサーバーか」は api で判断する（§12.1c）。llm を返すかどうかで見分けるのはやめた（#7）
  const outdated = !!health && serverOutdated(health);
  const unknown = !health || outdated;
  notesStatus.textContent = !health
    ? 'サーバーに接続できないため分かりません'
    : outdated
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
    if (initialCheck === notesGeneration) renderNotes(body);
  })
  .catch(() => {
    if (initialCheck === notesGeneration) renderNotes(null);
  });

/** 「このMacと接続」: サーバーが Mac にダイアログを出し、「許可」で承認される */
$('pair').addEventListener('click', async () => {
  show('Mac の画面に確認ダイアログが出ます。「許可」を押してください…');
  try {
    // 承認と保存は service worker が行う（パネルからも同じ経路）
    await sendToBackground.pair();
    config = await loadConfig();
    renderPairStatus();
    show('接続しました。', true);
  } catch (e) {
    show(e instanceof Error ? e.message : String(e), false);
  }
});

/** 「接続を解除」: サーバーにこの拡張の承認を取り消させ、保存したトークンを消す。戻すには「このMacと接続」を押し直す */
unpairBtn.addEventListener('click', async () => {
  const ok = confirm(
    'この Mac との接続を解除しますか？\n\n解除すると、録音を送って文字起こしすることができなくなります（録音とスライドの保存は続けます）。文字起こし中の講義は Mac で最後まで処理されますが、進み具合は表示されなくなります。\n\nもう一度「このMacと接続」を押せば戻せます。',
  );
  if (!ok) return;
  try {
    await sendToBackground.unpair();
    config = await loadConfig();
    renderPairStatus();
    show('接続を解除しました。', true);
  } catch (e) {
    show(e instanceof Error ? e.message : String(e), false);
  }
});

$('test').addEventListener('click', async () => {
  // ほかの画面（パネルの接続・解除）で変わっているかもしれないので読み直す
  config = await loadConfig();
  const { server } = config;
  show('接続中…');
  try {
    const body = await fetchHealth(server);
    const lines = [`サーバー v${body.version ?? '?'} に接続できました${body.commit ? `（${body.commit}）` : ''}`];
    if (serverOutdated(body)) lines.push(outdatedMessage(body));
    // トークンを手で直す欄は無いので、通らなければ「このMacと接続」に案内する（サーバーの trusted.json を消したときなど）
    lines.push(`承認: ${body.paired ? '済み' : body.authorized ? 'トークンで OK' : '未承認（「このMacと接続」を押してください）'}`);
    lines.push(`whisperkit-cli: ${body.whisperkit ? 'あり' : 'なし'} / ffmpeg: ${body.ffmpeg ? 'あり' : 'なし'}`);
    // 見た目の判定（同じ場面の画像をまとめる）。無くても動くので「接続できた」の判定には混ぜない（#17）
    const vision = visionLine(body);
    if (vision) lines.push(vision);
    if (body.model) lines.push(`モデル: ${body.model} / 出力先: ${body.outDir ?? ''}`);
    notesGeneration++; // 進行中の初回チェックの結果で上書きされないようにする
    renderNotes(body);
    // サーバー側の承認状態を設定にも反映する（trusted.json を消したときなど）
    if (body.paired !== undefined && body.paired !== config.server.paired) {
      config = { ...config, server: { ...config.server, paired: body.paired } };
      await saveConfig(config);
      renderPairStatus();
    }
    show(lines.join('\n'), body.authorized === true && body.whisperkit === true && body.ffmpeg === true);
  } catch (e) {
    // ほかのアプリがポートを使っているなら、「サーバーを起動してください」は当てはまらない（§12.1d）
    if (e instanceof ForeignServerError) show(e.message, false);
    else show(`接続できません（127.0.0.1:${server.port}）。サーバーを起動してください。\n${e instanceof Error ? e.message : String(e)}`, false);
  }
});
