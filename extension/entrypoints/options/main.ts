import { loadConfig, saveConfig, type Config } from '../../src/config';

/** 設定画面（SPEC §15.2）。ローカルサーバーの接続情報と音声のパススルー */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const port = $<HTMLInputElement>('port');
const token = $<HTMLInputElement>('token');
const passthrough = $<HTMLInputElement>('passthrough');
const result = $('result');

let config: Config = await loadConfig();
port.value = String(config.server.port);
token.value = config.server.token;
passthrough.checked = config.audio.passthrough;

function show(text: string, ok: boolean | null = null) {
  result.textContent = text;
  result.className = `result${ok === null ? '' : ok ? ' ok' : ' ng'}`;
}

function readForm(): Config {
  return {
    ...config,
    server: { port: Number(port.value) || 47321, token: token.value.trim() },
    audio: { ...config.audio, passthrough: passthrough.checked },
  };
}

$('save').addEventListener('click', async () => {
  config = readForm();
  await saveConfig(config);
  show('保存しました', true);
});

$('test').addEventListener('click', async () => {
  const { server } = readForm();
  show('接続中…');
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`, {
      headers: server.token ? { authorization: `Bearer ${server.token}` } : {},
    });
    const body = (await res.json()) as { version?: string; whisperkit?: boolean; ffmpeg?: boolean; authorized?: boolean; model?: string; outDir?: string };
    const lines = [`サーバー v${body.version ?? '?'} に接続できました`];
    lines.push(`トークン: ${body.authorized ? 'OK' : '不一致（サーバー起動時に表示されたものを貼り付けてください）'}`);
    lines.push(`whisperkit-cli: ${body.whisperkit ? 'あり' : 'なし'} / ffmpeg: ${body.ffmpeg ? 'あり' : 'なし'}`);
    if (body.model) lines.push(`モデル: ${body.model} / 出力先: ${body.outDir ?? ''}`);
    show(lines.join('\n'), body.authorized === true && body.whisperkit === true && body.ffmpeg === true);
  } catch (e) {
    show(`接続できません（127.0.0.1:${server.port}）。サーバーを起動してください。\n${e instanceof Error ? e.message : String(e)}`, false);
  }
});
