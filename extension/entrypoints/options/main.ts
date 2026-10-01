import { bindCopyButton } from '../../src/clipboard';
import { loadConfig, saveConfig, type Config } from '../../src/config';
import { APP_DIR, ForeignServerError, UPDATE_COMMAND, fetchHealth, fetchLlmSettings, outdatedMessage, saveLlmSettings, serverOutdated, visionLine, type Health } from '../../src/health';
import { sendToBackground } from '../../src/messages';

/** 設定画面（SPEC §15.2）。ローカルサーバーとの接続。ポートとトークンの欄は置かない（2026-09-18） */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const result = $('result');
const pairStatus = $('pairStatus');
const unpairBtn = $<HTMLButtonElement>('unpair');
const notesStatus = $('notesStatus');
const notesHint = $('notesHint');
const modelBox = $('modelBox');
const modelResult = $('modelResult');
const modelMain = $<HTMLInputElement>('modelMain');
const modelCheck = $<HTMLInputElement>('modelCheck');
const customModels = $('customModels');
const resetModelsBtn = $<HTMLButtonElement>('resetModels');
const modelPresetSel = $<HTMLSelectElement>('modelPreset');
const presetDetail = $('presetDetail');
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
    if (initialCheck === notesGeneration) {
      renderNotes(body);
      void renderModels(body);
    }
  })
  .catch(() => {
    if (initialCheck === notesGeneration) {
      renderNotes(null);
      void renderModels(null);
    }
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
    void renderModels(body);
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


/**
 * ノート作成のモデルの選択（SPEC §15.2、api 5。2026-10-01）。
 * codex のときだけ出す（プリセットのモデル名が ChatGPT のプランのもののため。openai / ollama は従来どおり環境変数で指定する）。
 * 保存はサーバーの settings.json に入り、再起動なしで次のノート作成から効く。
 * どのプリセットでも校正は付ける（校正は別の呼び出しに分けたほうが誤変換に強い。§13.5 の実測）。
 * 校正なしにできるのは、カスタムで校正の欄を空にしたときだけ
 */
const MODEL_PRESETS: Record<string, { llmModel: string; llmCheckModel: string }> = {
  recommended: { llmModel: 'gpt-5.6-terra', llmCheckModel: 'gpt-6-astra' },
  quality: { llmModel: 'gpt-6-astra', llmCheckModel: 'gpt-6-astra' },
  economy: { llmModel: 'gpt-5.6-terra', llmCheckModel: 'gpt-5.6-terra' },
};

const PRESET_DETAIL: Record<string, string> = {
  recommended: 'gpt-5.6-terraが本文を整えて要点を作り、gpt-6-astraが誤変換だけを校正します。',
  quality: '整え・要点も校正も、すべてgpt-6-astraで行います。',
  economy: '整え・要点も校正も、すべてgpt-5.6-terraで行います。',
  custom: 'モデル名を直接指定します。校正の欄を空にすると校正なしになります。',
};

function presetOf(llmModel: string, llmCheckModel: string): string {
  for (const [key, v] of Object.entries(MODEL_PRESETS)) {
    if (v.llmModel === llmModel && v.llmCheckModel === llmCheckModel) return key;
  }
  return 'custom';
}

function renderPresetDetail() {
  const preset = modelPresetSel.value;
  presetDetail.textContent = PRESET_DETAIL[preset] ?? '';
  customModels.hidden = preset !== 'custom';
}

function renderModelChoice(llmModel: string, llmCheckModel: string, overridden: boolean) {
  modelPresetSel.value = presetOf(llmModel, llmCheckModel);
  modelMain.value = llmModel;
  modelCheck.value = llmCheckModel;
  resetModelsBtn.hidden = !overridden;
  renderPresetDetail();
}

/** モデルの選択を出す。古いサーバー（api 5 未満）・codex 以外・未承認のときは出さない */
async function renderModels(health: Health | null) {
  const usable = !!health && (health.api ?? 0) >= 5 && health.llm === 'codex' && health.authorized === true;
  modelBox.hidden = !usable;
  if (!usable) return;
  try {
    const current = await fetchLlmSettings(config.server);
    renderModelChoice(current.llmModel ?? '', current.llmCheckModel ?? '', current.overridden === true);
    modelResult.textContent = '';
    modelResult.className = 'result';
  } catch {
    modelBox.hidden = true;
  }
}

modelPresetSel.addEventListener('change', () => {
  const values = MODEL_PRESETS[modelPresetSel.value];
  if (values) {
    modelMain.value = values.llmModel;
    modelCheck.value = values.llmCheckModel;
  }
  renderPresetDetail();
});

function showModelResult(text: string, ok: boolean) {
  modelResult.textContent = text;
  modelResult.className = `result${ok ? ' ok' : ' ng'}`;
}

$('saveModels').addEventListener('click', async () => {
  const preset = modelPresetSel.value;
  const values = MODEL_PRESETS[preset] ?? { llmModel: modelMain.value.trim(), llmCheckModel: modelCheck.value.trim() };
  try {
    const saved = await saveLlmSettings(config.server, values);
    renderModelChoice(saved.llmModel ?? '', saved.llmCheckModel ?? '', saved.overridden === true);
    showModelResult('保存しました。次のノート作成（または「やり直す」）から使われます。', true);
  } catch (e) {
    showModelResult(e instanceof Error ? e.message : String(e), false);
  }
});

resetModelsBtn.addEventListener('click', async () => {
  try {
    const saved = await saveLlmSettings(config.server, { reset: true });
    renderModelChoice(saved.llmModel ?? '', saved.llmCheckModel ?? '', saved.overridden === true);
    showModelResult('サーバー起動時の設定に戻しました。', true);
  } catch (e) {
    showModelResult(e instanceof Error ? e.message : String(e), false);
  }
});
