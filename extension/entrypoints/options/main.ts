import { bindCopyButton } from '../../src/clipboard';
import { loadConfig, saveConfig, type Config } from '../../src/config';
import { APP_DIR, ForeignServerError, UPDATE_COMMAND, fetchHealth, fetchLlmSettings, outdatedMessage, saveLlmSettings, serverOutdated, visionLine, type Health, type LlmSettingsInfo } from '../../src/health';
import { sendToBackground } from '../../src/messages';

/** 設定画面（SPEC §15.2）。ローカルサーバーとの接続。ポートとトークンの欄は置かない（2026-09-18） */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const result = $('result');
const pairStatus = $('pairStatus');
const pairBtn = $<HTMLButtonElement>('pair');
const unpairBtn = $<HTMLButtonElement>('unpair');
const notesStatus = $('notesStatus');
const notesHint = $('notesHint');
const modelBox = $('modelBox');
const modelResult = $('modelResult');
const customModels = $('customModels');
const modelPresetSel = $<HTMLSelectElement>('modelPreset');
const presetDetail = $('presetDetail');
const saveModelsBtn = $<HTMLButtonElement>('saveModels');
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
  // トークンだけあって承認の記録がないのは、手で貼っていた頃（2026-09-09 より前）の設定か、サーバー側の承認が消えた状態
  pairStatus.textContent = connected ? '接続済み（この Mac のサーバーが承認済み）' : config.server.token ? 'トークンで接続' : '未接続';
  pairStatus.className = `result${connected ? ' ok' : ''}`;
  // 状態で出し分ける（2026-10-01 の UI レビュー）: 接続済みなら「接続」は出さない（押す意味がない）。
  // トークンはあるのに承認が確認できないときだけ、復旧用に両方出す
  pairBtn.hidden = connected;
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

/**
 * サーバーの状態（ノート作成・モデル選択・承認）をまとめて取り直す。
 * 開いたとき、「このMacと接続」「接続を解除」のあとに呼ぶ（接続テストは自前の表示があるので別）。
 * 承認状態はサーバーを入れ直して消えていることがあるので、/health の paired を設定にも反映する
 */
async function refreshServerState() {
  const generation = ++notesGeneration;
  try {
    const body = await fetchHealth(config.server);
    if (generation !== notesGeneration) return;
    renderNotes(body);
    void renderModels(body);
    if (body.paired !== undefined && body.paired !== config.server.paired) {
      config = { ...config, server: { ...config.server, paired: body.paired } };
      await saveConfig(config);
      renderPairStatus();
    }
  } catch {
    if (generation !== notesGeneration) return;
    renderNotes(null);
    void renderModels(null);
  }
}

// 開いた時点のサーバーの状態を出す（接続テストを押さなくても分かるように）
void refreshServerState();

/** 「このMacと接続」: サーバーが Mac にダイアログを出し、「許可」で承認される */
pairBtn.addEventListener('click', async () => {
  show('Mac の画面に確認ダイアログが出ます。「許可」を押してください…');
  try {
    // 承認と保存は service worker が行う（パネルからも同じ経路）
    await sendToBackground.pair();
    config = await loadConfig();
    renderPairStatus();
    show('接続しました。', true);
    // 承認できたのでモデルの選択などを出し直す
    void refreshServerState();
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
    // 未承認になったのでモデルの選択を消す
    void refreshServerState();
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
 * 校正なしにできるのは、カスタムで校正の欄に「校正なし」を選んだときだけ
 */
/**
 * プリセットはモデル名ではなく系統で決める（2026-11-05）。`latest:terra` は Codex の一覧で Terra の系統のいちばん新しい版で、
 * サーバーがノートを作るたびに解決する。ChatGPT に新しいモデルが出ても（Codex を新しくすれば）自動で切り替わる
 */
const MODEL_PRESETS: Record<string, { llmModel: string; llmCheckModel: string }> = {
  recommended: { llmModel: 'latest:terra', llmCheckModel: 'latest:astra' },
  quality: { llmModel: 'latest:astra', llmCheckModel: 'latest:astra' },
  economy: { llmModel: 'latest:terra', llmCheckModel: 'latest:terra' },
};

/**
 * 前の版（2026-11-05 まで）のプリセット。api 7 未満のサーバーは latest: を知らず、そのままモデル名として codex に渡してしまうので、
 * そのサーバーにはこちらを使う。新しいサーバーで設定がこの組のままなら、選び直すよう案内する（2026-11-05 のレビュー）
 */
const LEGACY_PRESETS: Record<string, { llmModel: string; llmCheckModel: string }> = {
  recommended: { llmModel: 'gpt-5.6-terra', llmCheckModel: 'gpt-6-astra' },
  quality: { llmModel: 'gpt-6-astra', llmCheckModel: 'gpt-6-astra' },
  economy: { llmModel: 'gpt-5.6-terra', llmCheckModel: 'gpt-5.6-terra' },
};

const PRESET_NAME: Record<string, string> = { recommended: '推奨', quality: '高品質', economy: '節約' };

/** サーバーが latest: を解決できるか（api 7 以上）。できなければモデル名のプリセットを使う */
let tiersSupported = true;

function presets(): Record<string, { llmModel: string; llmCheckModel: string }> {
  return tiersSupported ? MODEL_PRESETS : LEGACY_PRESETS;
}

/** 系統の表示名。キーの順がカスタムの欄の並び */
const TIER_LABEL: Record<string, string> = { terra: 'Terra', astra: 'Astra', sol: 'Sol', luna: 'Luna' };

/** 系統ごとの、今の一覧でいちばん新しい版（サーバーが返す latest。api 7）。古いサーバーなら空 */
let latestByTier: Record<string, string> = {};

/** 設定の値を、画面に出す名前にする。latest:terra → 「最新のTerra（今はgpt-6.1-terra）」、空 → 「既定のモデル」 */
function modelLabel(value: string): string {
  if (!value.startsWith('latest:')) return value || '既定のモデル';
  const tier = value.slice('latest:'.length);
  const label = `最新の${TIER_LABEL[tier] ?? tier.charAt(0).toUpperCase() + tier.slice(1)}`;
  const resolved = latestByTier[tier];
  return resolved ? `${label}（今は${resolved}）` : label;
}

/**
 * カスタムの欄に出す系統。Codex の一覧（latest）にある系統だけを、TIER_LABEL の順に並べ、知らない新しい系統は後ろに足す。
 * 一覧に無い系統を選ぶと、ノート作成のたびに代わりのモデルになるだけなので出さない。一覧が取れないとき（Codex が古い・応答しない）は 4 つとも出す
 */
function tierChoices(): string[] {
  const known = Object.keys(latestByTier);
  const order = Object.keys(TIER_LABEL);
  if (known.length === 0) return order;
  return [...order.filter((t) => known.includes(t)), ...known.filter((t) => !order.includes(t)).sort()];
}

function presetDetailText(preset: string): string {
  const values = presets()[preset];
  if (!values) {
    // 前の版のプリセットを保存したまま（モデル名で固定）なら、選び直すと新しいモデルに追従することを知らせる
    const main = mainField.select.value;
    const check = checkField.select.value;
    const legacy = tiersSupported ? presetIn(LEGACY_PRESETS, main, check) : 'custom';
    if (legacy !== 'custom') {
      const name = PRESET_NAME[legacy];
      return `前の版の「${name}」（モデル名で固定）のままです。「${name}」を選び直して保存すると、新しいモデルに自動で切り替わるようになります。`;
    }
    // 系統で選んでいない欄（今の設定のモデル名・既定のモデル）があるなら、「自動で切り替わる」とは言わない（2026-11-09 のレビュー）
    const notTier = [main, ...(check ? [check] : [])].filter((v) => !v.startsWith('latest:'));
    if (tiersSupported && notTier.length) {
      return `${[...new Set(notTier)].map((v) => `「${modelLabel(v)}」`).join('と')}は系統で選んでいないので、新しいモデルが出ても自動では切り替わりません。系統を選び直して保存すると、自動で切り替わるようになります。`;
    }
    return tiersSupported
      ? '整え・要点と校正のモデルを系統で選びます。どれもその系統のいちばん新しいモデルを使い、Codexを新しくすると自動で切り替わります。校正の欄で「校正なし」を選ぶと校正しません。'
      : '整え・要点と校正のモデルを選びます。校正の欄で「校正なし」を選ぶと校正しません。';
  }
  const main = modelLabel(values.llmModel);
  const check = modelLabel(values.llmCheckModel);
  return values.llmModel === values.llmCheckModel
    ? `整え・要点も校正も、すべて${main}で行います。`
    : `${main}が本文を整えて要点を作り、${check}が誤変換だけを校正します。`;
}

/** カスタムの 1 欄。noneLabel があれば空（校正なし）も選べる */
type ModelField = { select: HTMLSelectElement; noneLabel?: string };
const mainField: ModelField = { select: $<HTMLSelectElement>('modelMainSel') };
const checkField: ModelField = { select: $<HTMLSelectElement>('modelCheckSel'), noneLabel: '校正なし' };

/** サーバーが返した今の設定（settings.json か起動時の設定）。候補にない値でも、カスタムの欄で選び直せるように残す */
let currentModels = { llmModel: '', llmCheckModel: '' };

/** api 7 未満のサーバー（系統を解決できない）の候補。前の版のプリセットのモデル名 */
const LEGACY_CHOICES = [...new Set(Object.values(LEGACY_PRESETS).flatMap((v) => [v.llmModel, v.llmCheckModel]))];

/**
 * カスタムの欄に候補を並べて value を選ぶ。候補は系統（最新の Terra・Astra・Sol・Luna など）だけで、版の固定や任意の名前は出さない
 * （2026-11-09。常に最新を使う道具なので、選ぶのは系統だけでよい）。api 7 未満のサーバーは系統を解決できないので、前の版のプリセットのモデル名を出す。
 * 候補にない今の設定（前の版のモデル名、起動時の設定の名前）は「（今の設定）」として足し、勝手に書き換えない。
 * プリセットを選んでからカスタムに戻しても選び直せるよう、欄の値に関係なく足す（2026-11-09 のレビュー）。
 * 最初は名前の欄＋datalist だったが、Chrome は欄に入っている文字で候補を絞り込むので、保存した値が入っていると候補が 1 つしか出なかった
 */
function fillModelField(field: ModelField, value: string, current: string) {
  const option = (v: string, label: string) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    return o;
  };
  const options = (tiersSupported ? tierChoices().map((t) => `latest:${t}`) : LEGACY_CHOICES).map((v) => option(v, modelLabel(v)));
  if (field.noneLabel !== undefined) options.push(option('', field.noneLabel));
  const listed = (v: string) => options.some((o) => o.value === v);
  if (!listed(current)) options.unshift(option(current, `${modelLabel(current)}（今の設定）`));
  // プリセットの系統が一覧に無いときだけ起きる（選んだプリセットの値を欄に出す）
  if (!listed(value)) options.unshift(option(value, modelLabel(value)));
  field.select.replaceChildren(...options);
  field.select.value = value;
}

function showModelFields(llmModel: string, llmCheckModel: string) {
  fillModelField(mainField, llmModel, currentModels.llmModel);
  fillModelField(checkField, llmCheckModel, currentModels.llmCheckModel);
}

function presetIn(table: Record<string, { llmModel: string; llmCheckModel: string }>, llmModel: string, llmCheckModel: string): string {
  for (const [key, v] of Object.entries(table)) {
    if (v.llmModel === llmModel && v.llmCheckModel === llmCheckModel) return key;
  }
  return 'custom';
}

function presetOf(llmModel: string, llmCheckModel: string): string {
  return presetIn(presets(), llmModel, llmCheckModel);
}

function renderPresetDetail() {
  const preset = modelPresetSel.value;
  presetDetail.textContent = presetDetailText(preset);
  customModels.hidden = preset !== 'custom';
}

function renderModelChoice(info: LlmSettingsInfo) {
  const llmModel = info.llmModel ?? '';
  const llmCheckModel = info.llmCheckModel ?? '';
  modelPresetSel.value = presetOf(llmModel, llmCheckModel);
  latestByTier = info.latest ?? {};
  currentModels = { llmModel, llmCheckModel };
  showModelFields(llmModel, llmCheckModel);
  renderPresetDetail();
}

/** 遅れて届いた古い /settings の応答で、保存直後の表示を巻き戻さないための世代番号 */
let modelsGeneration = 0;
/** 保存していない編集（カスタムのモデル名など）があるか。あるときは取り直しで欄を上書きしない */
let modelsDirty = false;
/** 保存の応答を待っているか。待っている間は取り直しで欄を上書きしない（応答のほうが新しい） */
let modelsSaving = false;

/** モデルの選択を出す。古いサーバー（api 5 未満）・codex 以外・未承認のときは出さない */
async function renderModels(health: Health | null) {
  const usable = !!health && (health.api ?? 0) >= 5 && health.llm === 'codex' && health.authorized === true;
  modelBox.hidden = !usable;
  if (!usable) return;
  const tiers = (health.api ?? 0) >= 7;
  // サーバーの版が変わったら、前のサーバー向けの編集（系統かモデル名か）は捨てて取り直す。古いサーバーに latest: を送らないため
  if (tiers !== tiersSupported) modelsDirty = false;
  tiersSupported = tiers;
  const generation = ++modelsGeneration;
  try {
    const current = await fetchLlmSettings(config.server);
    if (generation !== modelsGeneration || modelsDirty || modelsSaving) return;
    renderModelChoice(current);
    showModelResult('', true);
  } catch {
    if (generation === modelsGeneration) modelBox.hidden = true;
  }
}

/**
 * 選び直したら「保存しました」を消す。残っていると、今の選択が保存済みなのか分からなくなる（2026-11-09）。
 * 表示があれば、画面の選択は保存したものと同じ
 */
function editModels() {
  modelsDirty = true;
  showModelResult('', true);
}

modelPresetSel.addEventListener('change', () => {
  editModels();
  const values = presets()[modelPresetSel.value];
  if (values) showModelFields(values.llmModel, values.llmCheckModel);
  renderPresetDetail();
});
for (const field of [mainField, checkField]) {
  field.select.addEventListener('change', () => {
    editModels();
    renderPresetDetail();
  });
}

function showModelResult(text: string, ok: boolean) {
  modelResult.textContent = text;
  modelResult.className = text ? `result${ok ? ' ok' : ' ng'}` : 'result';
}

/** 保存の応答を待つ間は選択を止める。待つ間に選び直すと、応答で画面が保存した値に戻り、選び直した分も保存したように見えたため（2026-11-09 のレビュー） */
function setModelsBusy(busy: boolean) {
  modelsSaving = busy;
  for (const el of [modelPresetSel, mainField.select, checkField.select, saveModelsBtn]) el.disabled = busy;
}

saveModelsBtn.addEventListener('click', async () => {
  const preset = modelPresetSel.value;
  const values = presets()[preset] ?? { llmModel: mainField.select.value, llmCheckModel: checkField.select.value };
  // 保存より前に始まった取り直しの応答が、あとから届いて保存前の値で上書きしないように
  modelsGeneration++;
  setModelsBusy(true);
  try {
    const saved = await saveLlmSettings(config.server, values);
    modelsDirty = false;
    renderModelChoice(saved);
    showModelResult('保存しました。次のノート作成（または「やり直す」）から使われます。', true);
  } catch (e) {
    showModelResult(e instanceof Error ? e.message : String(e), false);
  } finally {
    setModelsBusy(false);
  }
});

