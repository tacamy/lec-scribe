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
const modelCatalog = $('modelCatalog');
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
 * 校正なしにできるのは、カスタムで校正の欄を空にしたときだけ
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

/** 系統の表示名 */
const TIER_LABEL: Record<string, string> = { terra: 'Terra', astra: 'Astra', sol: 'Sol', luna: 'Luna' };

/** 設定の値を、説明に出す名前にする。latest:terra → 「最新のTerra（今はgpt-6.1-terra）」 */
function modelLabel(value: string, resolved: string | undefined): string {
  if (!value.startsWith('latest:')) return value || '既定のモデル';
  const tier = value.slice('latest:'.length);
  const label = `最新の${TIER_LABEL[tier] ?? tier}`;
  return resolved ? `${label}（今は${resolved}）` : label;
}

/** 系統ごとの、今の一覧でいちばん新しい版（サーバーが返す latest。api 7）。古いサーバーなら空 */
let latestByTier: Record<string, string> = {};

function presetDetailText(preset: string): string {
  const values = presets()[preset];
  if (!values) {
    // 前の版のプリセットを保存したまま（モデル名で固定）なら、選び直すと新しいモデルに追従することを知らせる
    const legacy = tiersSupported ? presetIn(LEGACY_PRESETS, fieldValue(mainField), fieldValue(checkField)) : 'custom';
    if (legacy !== 'custom') {
      const name = PRESET_NAME[legacy];
      return `前の版の「${name}」（モデル名で固定）のままです。「${name}」を選び直して保存すると、新しいモデルに自動で切り替わるようになります。`;
    }
    return tiersSupported
      ? '整え・要点と校正のモデルを選びます。「最新の〜」はその系統のいちばん新しいモデルに自動で切り替わり、版を選ぶとそのモデルに固定します。一覧にないモデルは「その他」で名前を入れます。'
      : '整え・要点と校正のモデルを選びます。一覧にないモデルは「その他」で名前を入れます。';
  }
  const now = (value: string) => latestByTier[value.slice('latest:'.length)];
  const main = modelLabel(values.llmModel, now(values.llmModel));
  const check = modelLabel(values.llmCheckModel, now(values.llmCheckModel));
  return values.llmModel === values.llmCheckModel
    ? `整え・要点も校正も、すべて${main}で行います。`
    : `${main}が本文を整えて要点を作り、${check}が誤変換だけを校正します。`;
}

/** カスタムの「その他（モデル名を入力）」の値。モデル名に使われない文字列にする */
const OTHER_MODEL = '__other__';

/** カスタムの 1 欄（候補の select と、「その他」のときだけ出す名前の欄） */
type ModelField = { select: HTMLSelectElement; input: HTMLInputElement; emptyLabel: string };
const mainField: ModelField = { select: $<HTMLSelectElement>('modelMainSel'), input: $<HTMLInputElement>('modelMain'), emptyLabel: '既定のモデル（指定なし）' };
const checkField: ModelField = { select: $<HTMLSelectElement>('modelCheckSel'), input: $<HTMLInputElement>('modelCheck'), emptyLabel: '校正なし' };

function fieldValue(field: ModelField): string {
  return field.select.value === OTHER_MODEL ? field.input.value.trim() : field.select.value;
}

/** 候補にある値ならそれを選び、ない値（一覧にないモデル名）なら「その他」にして名前の欄に入れる */
function setFieldValue(field: ModelField, value: string) {
  const listed = [...field.select.options].some((o) => o.value === value && o.value !== OTHER_MODEL);
  field.select.value = listed ? value : OTHER_MODEL;
  field.input.value = listed ? '' : value;
  field.input.hidden = listed;
}

/**
 * カスタムの欄の候補（「最新の〜」と、Codex で今使えるモデル）を作る。最初は input ＋ datalist だったが、
 * Chrome は欄に入っている文字で候補を絞り込むので、保存した値が入っていると候補が 1 つしか出なかった（2026-11-09）
 */
function fillModelField(field: ModelField, models: ReadonlyArray<{ slug: string }>) {
  const option = (value: string, label: string) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  };
  const group = (label: string, options: HTMLOptionElement[]) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...options);
    return g;
  };
  const groups: HTMLOptGroupElement[] = [];
  if (tiersSupported) {
    const tiers = ['terra', 'astra', 'sol', 'luna'].map((t) => option(`latest:${t}`, modelLabel(`latest:${t}`, latestByTier[t])));
    groups.push(group('系統で指定（新しい版に自動で切り替わる）', tiers));
  }
  if (models.length) groups.push(group('版を固定', models.map((m) => option(m.slug, m.slug))));
  field.select.replaceChildren(...groups, option('', field.emptyLabel), option(OTHER_MODEL, 'その他（モデル名を入力）'));
}

/** カスタムの欄の候補と、使えるモデルの一覧を出す */
function renderCatalog(info: LlmSettingsInfo) {
  const models = info.models ?? [];
  latestByTier = info.latest ?? {};
  fillModelField(mainField, models);
  fillModelField(checkField, models);
  modelCatalog.hidden = models.length === 0;
  modelCatalog.textContent = models.length ? `いまCodex${info.codexVersion ? ` ${info.codexVersion}` : ''}で使えるモデル: ${models.map((m) => m.slug).join('、')}` : '';
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
  renderCatalog(info);
  setFieldValue(mainField, llmModel);
  setFieldValue(checkField, llmCheckModel);
  renderPresetDetail();
}

/** 遅れて届いた古い /settings の応答で、保存直後の表示を巻き戻さないための世代番号 */
let modelsGeneration = 0;
/** 保存していない編集（カスタムのモデル名など）があるか。あるときは取り直しで欄を上書きしない */
let modelsDirty = false;

/** モデルの選択を出す。古いサーバー（api 5 未満）・codex 以外・未承認のときは出さない */
async function renderModels(health: Health | null) {
  const usable = !!health && (health.api ?? 0) >= 5 && health.llm === 'codex' && health.authorized === true;
  modelBox.hidden = !usable;
  if (!usable) return;
  tiersSupported = (health.api ?? 0) >= 7;
  const generation = ++modelsGeneration;
  try {
    const current = await fetchLlmSettings(config.server);
    if (generation !== modelsGeneration || modelsDirty) return;
    renderModelChoice(current);
    modelResult.textContent = '';
    modelResult.className = 'result';
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
  if (values) {
    setFieldValue(mainField, values.llmModel);
    setFieldValue(checkField, values.llmCheckModel);
  }
  renderPresetDetail();
});
for (const field of [mainField, checkField]) {
  field.select.addEventListener('change', () => {
    editModels();
    field.input.hidden = field.select.value !== OTHER_MODEL;
    if (!field.input.hidden) field.input.focus();
    renderPresetDetail();
  });
  field.input.addEventListener('input', () => {
    editModels();
    renderPresetDetail();
  });
}

function showModelResult(text: string, ok: boolean) {
  modelResult.textContent = text;
  modelResult.className = text ? `result${ok ? ' ok' : ' ng'}` : 'result';
}

$('saveModels').addEventListener('click', async () => {
  const preset = modelPresetSel.value;
  const values = presets()[preset] ?? { llmModel: fieldValue(mainField), llmCheckModel: fieldValue(checkField) };
  try {
    const saved = await saveLlmSettings(config.server, values);
    modelsDirty = false;
    renderModelChoice(saved);
    showModelResult('保存しました。次のノート作成（または「やり直す」）から使われます。', true);
  } catch (e) {
    showModelResult(e instanceof Error ? e.message : String(e), false);
  }
});

