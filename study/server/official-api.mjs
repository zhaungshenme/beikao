import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OFFICIAL_AI = Object.freeze({
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4.7-flash',
});
const OFFICIAL_MODELS = Object.freeze(['glm-4.7-flash', 'glm-4-flash-250414']);
export const isOfficialModel = value => typeof value === 'string' && OFFICIAL_MODELS.includes(value);
export const isWebDriver = value => value === 'userscript' || value === 'browser-ui';
const ENDPOINT = `${OFFICIAL_AI.baseUrl}/chat/completions`;
const SETTINGS_NAME = 'official-ai-settings.json';
const MAX_REPLY_CHARS = 20000;
const MAX_RESPONSE_BYTES = 131072;
const OFFICIAL_SYSTEM_PROMPT = [
  '你是备考题库通用讲解的答题与审校助手。仅依据用户消息中的本批题目、选项和标准要求作答，不读取、推断或要求个人作答、笔记或学习记录。',
  '只返回一个原始且合法的 JSON 对象，不要 Markdown 代码围栏、前后说明或思维过程。顶层只能有 batchToken 和 items；items 中每项只能有 questionId、fingerprint、answer、analysis。',
  '依照用户消息中的本批完整输出骨架，逐字精确复制 batchToken、每题 questionId 和 fingerprint，不改写、缩写或截断身份字段；完整覆盖全部题目，每题恰好一次。answer 必须独立审题并核对现行标准，analysis 必须逐题独立讲解，不为通过校验编造论证。',
  '不要复述输入 JSON 中的 type、category 等元数据，不增加任何字段。不得使用省略条目、replaceplaceholder、待补充或模板变量等占位内容；一次完成整批每题讲解并闭合 JSON，不以任何占位结束。',
  '事实审校须区分读与写、每进程文件描述符表与共享的 open file description、数学空和为 0 与 SQL SUM 对空输入返回 NULL，不能混用概念。仅陈述有依据的结论，不补写缺乏依据的因果关系。',
].join('\n');
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const validKey = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 4096 && /^[\x21-\x7e]+$/.test(value.trim());
const validCipher = value => typeof value === 'string' && value.length > 0 && value.length <= 65536 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
const safeError = message => new Error(message);

// Only these fixed scripts appear on the command line. Plaintext travels over
// stdin/stdout pipes, never an argument, environment variable or temporary file.
const DPAPI_SCRIPTS = Object.freeze({
  protect: `$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; [Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $bytes=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); try { $sealed=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($sealed)) } finally { [Array]::Clear($bytes,0,$bytes.Length) } } catch { [Console]::Error.Write('DPAPI unavailable'); exit 1 }`,
  unprotect: `$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; [Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $sealed=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $bytes=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); try { [Console]::Write([Text.Encoding]::UTF8.GetString($bytes)) } finally { [Array]::Clear($bytes,0,$bytes.Length) } } catch { [Console]::Error.Write('DPAPI unavailable'); exit 1 }`,
});

/** Synchronous factory; protection and writer seams keep tests away from real keys. */
export function createOfficialSettingsStore({ dataDir, atomicJson, env = process.env, platform = process.platform,
  protect, unprotect, runPowerShell = spawnSync, systemRoot = process.env.SystemRoot || 'C:\\Windows' }) {
  if (typeof dataDir !== 'string' || !dataDir || typeof atomicJson !== 'function') throw safeError('官方API配置存储不可用。');
  const file = path.join(dataDir, SETTINGS_NAME);
  const dpapi = (operation, input) => {
    if (platform !== 'win32') throw safeError('当前系统无法安全保存官方API密钥，请使用环境变量。');
    try {
      const script = Buffer.from(DPAPI_SCRIPTS[operation], 'utf16le').toString('base64');
      const result = runPowerShell(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script],
        { input, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536,
          // Do not inherit API keys (including the environment override) into the helper.
          env: { SystemRoot: systemRoot, WINDIR: systemRoot } });
      if (!result || result.error || result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout) throw safeError('DPAPI unavailable');
      return result.stdout.replace(/^\uFEFF/, '');
    } catch { throw safeError('Windows密钥保护不可用，未保存密钥。'); }
  };
  const protectValue = protect || (value => dpapi('protect', value));
  const unprotectValue = unprotect || (value => dpapi('unprotect', value));
  let state = { version: 1, transport: 'web' };
  let localKey = '';
  let loadIssue = '';
  let damagedFile = false;
  try {
    if (fs.existsSync(file)) {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (!isRecord(stored) || stored.version !== 1 || !['web', 'official-api'].includes(stored.transport) ||
          Object.keys(stored).some(key => !['version', 'transport', 'model', 'webDriver', 'apiKeyCiphertext'].includes(key)) ||
          (own(stored, 'model') && !isOfficialModel(stored.model)) ||
          (own(stored, 'webDriver') && !isWebDriver(stored.webDriver)) ||
          (own(stored, 'apiKeyCiphertext') && !validCipher(stored.apiKeyCiphertext))) throw safeError('invalid settings');
      state = { version: 1, transport: stored.transport, ...(own(stored, 'model') ? { model: stored.model } : {}),
        ...(own(stored, 'webDriver') ? { webDriver: stored.webDriver } : {}),
        ...(stored.apiKeyCiphertext ? { apiKeyCiphertext: stored.apiKeyCiphertext } : {}) };
      if (state.apiKeyCiphertext) {
        try {
          if (platform !== 'win32') throw safeError('DPAPI unavailable');
          const value = unprotectValue(state.apiKeyCiphertext);
          if (!validKey(value)) throw safeError('invalid key');
          localKey = value.trim();
        } catch { loadIssue = '本地官方API密钥无法解密，请重新设置密钥或使用环境变量。'; }
      }
    }
  } catch {
    damagedFile = true;
    loadIssue = '官方API配置无法读取，原文件未修改；请重新设置或清除密钥。';
  }
  const environmentKey = () => {
    const value = env?.STUDY_ZHIPU_API_KEY;
    if (value === undefined || value === '') return { present: false, key: '' };
    return { present: true, key: validKey(value) ? value.trim() : '' };
  };
  const status = () => {
    const environment = environmentKey();
    const configured = environment.present ? !!environment.key : !!localKey;
    const keyStorage = environment.present ? 'environment' : state.apiKeyCiphertext ? 'windows-dpapi' : 'none';
    const message = environment.present && !environment.key ? '环境变量中的官方API密钥格式无效。' : loadIssue;
    return { transport: state.transport, webDriver: state.webDriver ?? 'userscript', configured, ...OFFICIAL_AI, model: state.model ?? OFFICIAL_AI.model,
      keyStorage, ...(message ? { message } : {}) };
  };
  const getKey = () => {
    const environment = environmentKey();
    return environment.present ? environment.key : localKey;
  };
  const update = input => {
    if (!isRecord(input) || Object.keys(input).length === 0 || Object.keys(input).some(key => !['transport', 'model', 'webDriver', 'apiKey', 'clearApiKey'].includes(key)) ||
        (own(input, 'transport') && !['web', 'official-api'].includes(input.transport)) ||
        (own(input, 'model') && !isOfficialModel(input.model)) ||
        (own(input, 'webDriver') && !isWebDriver(input.webDriver)) ||
        (own(input, 'clearApiKey') && typeof input.clearApiKey !== 'boolean') ||
        (own(input, 'apiKey') && !validKey(input.apiKey)) || (input.clearApiKey && own(input, 'apiKey'))) throw safeError('官方API配置参数无效。');
    if (damagedFile && !input.clearApiKey && !own(input, 'apiKey')) throw safeError('官方API配置无法读取，原文件未修改；请重新设置或清除密钥。');
    const next = { ...state, transport: own(input, 'transport') ? input.transport : state.transport,
      ...(own(input, 'model') ? { model: input.model } : {}),
      ...(own(input, 'webDriver') ? { webDriver: input.webDriver } : {}) };
    let nextKey = localKey;
    let nextIssue = loadIssue;
    if (input.clearApiKey) {
      delete next.apiKeyCiphertext;
      nextKey = '';
      nextIssue = '';
    } else if (own(input, 'apiKey')) {
      if (platform !== 'win32') throw safeError('当前系统无法安全保存官方API密钥，请使用环境变量。');
      try {
        const value = input.apiKey.trim();
        const ciphertext = protectValue(value);
        if (!validCipher(ciphertext) || ciphertext === value || unprotectValue(ciphertext) !== value) throw safeError('invalid protection');
        next.apiKeyCiphertext = ciphertext;
        nextKey = value;
        nextIssue = '';
      } catch { throw safeError('Windows密钥保护不可用，未保存密钥。'); }
    }
    // Commit memory only after the synchronous atomic writer has succeeded.
    try { atomicJson(file, next); }
    catch { throw safeError('官方API配置保存失败，原配置仍保留。'); }
    state = next;
    localKey = nextKey;
    loadIssue = nextIssue;
    damagedFile = false;
    return status();
  };
  return { status, update, getKey };
}

class OfficialApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OfficialApiError';
    this.safeMessage = message;
  }
}
const requestError = message => new OfficialApiError(message);
const invalidReply = () => requestError('官方API回复不完整或格式不符合要求，本批已停止。');
const rateLimitError = data => {
  const code = data?.error?.code;
  if (code === 1302 || code === '1302') return requestError('官方API限流（1302），本批已停止。');
  if (code === 1305 || code === '1305') return requestError('官方模型暂时过载（1305），本批已停止；请稍后再试。');
  return null;
};

// Read both success and error envelopes with a hard bound before JSON parsing.
// fetchImpl adapters must provide the standard Fetch Response body stream.
async function readBoundedJson(response) {
  if (typeof response?.body?.getReader !== 'function') throw invalidReply();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > MAX_RESPONSE_BYTES) throw invalidReply();
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch { throw invalidReply(); }
  finally {
    if (!complete) { try { await reader.cancel(); } catch {} }
    reader.releaseLock();
  }
}

/** One request only: no redirects, alternate model, private endpoint or retry. */
export async function requestOfficialBatch({ prompt, key, signal, model = OFFICIAL_AI.model, fetchImpl = globalThis.fetch, requestId } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 250000 || !isOfficialModel(model) || !validKey(key) || typeof fetchImpl !== 'function' ||
      (requestId !== undefined && (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)))) {
    throw requestError('官方API请求参数无效。');
  }
  if (signal?.aborted) throw requestError('官方API请求已取消，本批未接收回复。');
  try {
    const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, temperature: 0.3, max_tokens: 8192,
        ...(model === OFFICIAL_AI.model ? { thinking: { type: 'disabled' } } : {}), response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: OFFICIAL_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
        ...(requestId ? { request_id: requestId } : {}) }), signal });
    if (!response?.ok) {
      if ([401, 403].includes(response?.status)) throw requestError('官方API认证失败，请检查密钥。');
      let errorData;
      try { errorData = await readBoundedJson(response); } catch {}
      const limited = rateLimitError(errorData);
      if (limited) throw limited;
      if (response?.status === 429) throw requestError('官方API额度或速率受限，本批已停止。');
      throw requestError('官方API请求未成功，请检查网络或配置。');
    }
    let data;
    try { data = await readBoundedJson(response); }
    catch { throw invalidReply(); }
    const limited = rateLimitError(data);
    if (limited) throw limited;
    const choice = data?.choices?.[0];
    const message = choice?.message;
    if (!isRecord(data) || (own(data, 'model') && data.model !== model) || data.error ||
        !Array.isArray(data.choices) || data.choices.length !== 1 || !isRecord(choice) ||
        (own(choice, 'index') && choice.index !== 0) || choice.finish_reason !== 'stop' || !isRecord(message) ||
        (own(message, 'role') && message.role !== 'assistant') || message.tool_calls != null || message.function_call != null || message.refusal ||
        typeof message.content !== 'string' || !message.content.trim() || message.content.length > MAX_REPLY_CHARS) {
      throw invalidReply();
    }
    if (signal?.aborted) throw requestError('官方API请求已取消，本批未接收回复。');
    return message.content;
  } catch (error) {
    if (signal?.aborted) throw requestError('官方API请求已取消，本批未接收回复。');
    if (error instanceof OfficialApiError) throw error;
    throw requestError('官方API请求未成功，请检查网络或配置。');
  }
}
