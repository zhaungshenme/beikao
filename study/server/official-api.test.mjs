import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { OFFICIAL_AI, isOfficialModel, isWebDriver, createOfficialSettingsStore, requestOfficialBatch } from './official-api.mjs';

const KEY = 'fixture-id.fixture-secret-only';
const OTHER_KEY = 'fixture-other.fixture-secret-only';
const ENV_KEY = 'fixture-env.fixture-secret-only';
const protect = value => Buffer.from(`fixture-protected:${value}`).toString('base64');
const unprotect = value => {
  const result = Buffer.from(value, 'base64').toString();
  if (!result.startsWith('fixture-protected:')) throw new Error('fixture protection failure');
  return result.slice('fixture-protected:'.length);
};
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'yankao-official-api-'));
  const dataDir = path.join(directory, 'state');
  const file = path.join(dataDir, 'official-ai-settings.json');
  fs.mkdirSync(dataDir);
  t.after(() => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('yankao-official-api-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const atomicJson = (target, value) => {
    assert.equal(target, file, 'writer is restricted to the independent settings file');
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, target);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  const create = (options = {}) => createOfficialSettingsStore({ dataDir, atomicJson, env: {}, platform: 'win32', protect, unprotect, ...options });
  return { directory, dataDir, file, atomicJson, create, read: () => fs.readFileSync(file, 'utf8') };
}
const good = (content = '{"batchToken":"fixture","items":[]}') => ({ model: OFFICIAL_AI.model,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const noSecrets = value => {
  for (const secret of [KEY, OTHER_KEY, ENV_KEY, protect(KEY)]) assert.ok(!JSON.stringify(value).includes(secret));
};

test('fresh settings keep the web transport and do not touch any files or protection helpers', t => {
  const f = fixture(t);
  const store = f.create({ protect: () => assert.fail('no key to protect'), unprotect: () => assert.fail('no key to decrypt') });
  assert.deepEqual(store.status(), { transport: 'web', webDriver: 'userscript', configured: false, ...OFFICIAL_AI, keyStorage: 'none' });
  assert.equal(store.getKey(), '');
  assert.equal(fs.existsSync(f.file), false);
  assert.ok(Object.isFrozen(OFFICIAL_AI));
  assert.equal(OFFICIAL_AI.model, 'glm-4.7-flash');
  for (const model of ['glm-4.7-flash', 'glm-4-flash-250414']) assert.equal(isOfficialModel(model), true);
  for (const model of [undefined, null, 1, {}, 'glm-4-flash', 'glm-4.5-flash', 'glm-4.7-flashx', 'glm-paid-model']) {
    assert.equal(isOfficialModel(model), false);
  }
});

test('settings save only ciphertext and transport in the independent atomic document', t => {
  const f = fixture(t);
  const personalFile = path.join(f.dataDir, 'learning-state.json');
  const personalBytes = '{"fixture":"personal data must remain byte-identical"}';
  fs.writeFileSync(personalFile, personalBytes);
  const store = f.create();
  const result = store.update({ transport: 'official-api', apiKey: ` ${KEY} ` });
  assert.deepEqual(result, { transport: 'official-api', webDriver: 'userscript', configured: true, ...OFFICIAL_AI, keyStorage: 'windows-dpapi' });
  assert.equal(store.getKey(), KEY);
  noSecrets(result);
  assert.deepEqual(JSON.parse(f.read()), { version: 1, transport: 'official-api', apiKeyCiphertext: protect(KEY) });
  assert.ok(!f.read().includes(KEY));
  assert.equal(fs.readFileSync(personalFile, 'utf8'), personalBytes);
  assert.deepEqual(fs.readdirSync(f.dataDir).sort(), ['learning-state.json', 'official-ai-settings.json']);
  const restarted = f.create();
  assert.equal(restarted.getKey(), KEY);
  assert.deepEqual(restarted.status(), result);
});

test('environment override takes precedence, is never persisted, and clearing only removes the disk key', t => {
  const f = fixture(t);
  f.create().update({ transport: 'web', apiKey: KEY });
  const store = f.create({ env: { STUDY_ZHIPU_API_KEY: ENV_KEY } });
  assert.equal(store.getKey(), ENV_KEY);
  assert.equal(store.status().keyStorage, 'environment');
  noSecrets(store.update({ transport: 'official-api' }));
  assert.ok(!f.read().includes(ENV_KEY));
  const cleared = store.update({ transport: 'web', clearApiKey: true });
  assert.equal(cleared.configured, true);
  assert.equal(cleared.keyStorage, 'environment');
  assert.equal(store.getKey(), ENV_KEY);
  assert.deepEqual(JSON.parse(f.read()), { version: 1, transport: 'web' });
  assert.equal(f.create().getKey(), '');
});

test('legacy version-one settings without a model retain the default without rewriting the document', t => {
  const f = fixture(t);
  const original = JSON.stringify({ version: 1, transport: 'official-api', apiKeyCiphertext: protect(KEY) }, null, 2);
  fs.writeFileSync(f.file, original);
  const store = f.create({ atomicJson: () => assert.fail('reading a legacy model default must not write') });
  assert.deepEqual(store.status(), { transport: 'official-api', webDriver: 'userscript', configured: true, ...OFFICIAL_AI, keyStorage: 'windows-dpapi' });
  assert.equal(store.getKey(), KEY);
  assert.equal(f.read(), original);
});

test('model-only updates preserve ciphertext and in-memory key without decrypting or protecting again', t => {
  const f = fixture(t);
  f.create().update({ transport: 'official-api', apiKey: KEY });
  const originalCipher = JSON.parse(f.read()).apiKeyCiphertext;
  let protectionCalls = 0;
  let decryptionCalls = 0;
  const store = f.create({ protect: value => { protectionCalls++; return protect(value); },
    unprotect: value => { decryptionCalls++; return unprotect(value); } });
  assert.equal(decryptionCalls, 1, 'startup decrypts the existing key once');
  const updated = store.update({ model: 'glm-4-flash-250414' });
  assert.deepEqual(updated, { transport: 'official-api', webDriver: 'userscript', configured: true, ...OFFICIAL_AI,
    model: 'glm-4-flash-250414', keyStorage: 'windows-dpapi' });
  assert.equal(store.getKey(), KEY);
  assert.equal(protectionCalls, 0);
  assert.equal(decryptionCalls, 1);
  assert.deepEqual(JSON.parse(f.read()), { version: 1, transport: 'official-api', model: 'glm-4-flash-250414', apiKeyCiphertext: originalCipher });
  noSecrets(updated);
  const restarted = f.create();
  assert.deepEqual(restarted.status(), updated);
  assert.equal(restarted.getKey(), KEY);
  assert.equal(store.update({ model: OFFICIAL_AI.model }).model, OFFICIAL_AI.model);
  assert.equal(JSON.parse(f.read()).apiKeyCiphertext, originalCipher);
  assert.equal(protectionCalls, 0);
  assert.equal(decryptionCalls, 1);
});

test('key-only updates preserve the current transport and clearApiKey needs no transport', t => {
  const f = fixture(t);
  const store = f.create();
  assert.equal(store.update({ apiKey: KEY }).transport, 'web');
  assert.equal(store.getKey(), KEY);
  store.update({ transport: 'official-api' });
  assert.equal(store.update({ apiKey: OTHER_KEY }).transport, 'official-api');
  assert.equal(store.getKey(), OTHER_KEY);
  assert.equal(store.update({ clearApiKey: true }).transport, 'official-api');
  assert.equal(store.getKey(), '');
  assert.deepEqual(JSON.parse(f.read()), { version: 1, transport: 'official-api' });
});

test('web driver selection defaults to userscript and persists without reprocessing an existing key', t => {
  const f = fixture(t);
  f.create().update({ transport: 'official-api', model: 'glm-4-flash-250414', apiKey: KEY });
  const original = JSON.parse(f.read());
  let protectionCalls = 0;
  let decryptionCalls = 0;
  const store = f.create({ protect: value => { protectionCalls++; return protect(value); },
    unprotect: value => { decryptionCalls++; return unprotect(value); } });
  assert.equal(store.status().webDriver, 'userscript');
  const updated = store.update({ transport: 'web', webDriver: 'browser-ui' });
  assert.equal(updated.webDriver, 'browser-ui');
  assert.equal(updated.model, original.model);
  assert.equal(updated.configured, true);
  assert.equal(store.getKey(), KEY);
  assert.equal(protectionCalls, 0);
  assert.equal(decryptionCalls, 1);
  assert.deepEqual(JSON.parse(f.read()), { ...original, transport: 'web', webDriver: 'browser-ui' });
  assert.deepEqual(f.create().status(), updated);
  assert.equal(store.update({ model: OFFICIAL_AI.model }).webDriver, 'browser-ui');
  assert.equal(store.update({ webDriver: 'userscript' }).webDriver, 'userscript');
  assert.equal(protectionCalls, 0);
  assert.equal(decryptionCalls, 1);
  noSecrets(updated);
  for (const value of ['userscript', 'browser-ui']) assert.equal(isWebDriver(value), true);
  for (const value of [undefined, null, '', 'Browser-UI', 'unknown', 1, {}, []]) assert.equal(isWebDriver(value), false);
});

test('an invalid environment override does not silently select another saved key', t => {
  const f = fixture(t);
  f.create().update({ transport: 'official-api', apiKey: KEY });
  const before = f.read();
  const store = f.create({ env: { STUDY_ZHIPU_API_KEY: 'invalid\nsecret' } });
  assert.equal(store.getKey(), '');
  assert.equal(store.status().configured, false);
  assert.equal(store.status().keyStorage, 'environment');
  assert.match(store.status().message, /格式无效/);
  noSecrets(store.status());
  assert.equal(f.read(), before);
});

test('non-Windows systems support environment keys and refuse any disk-key plaintext fallback', t => {
  const f = fixture(t);
  const store = f.create({ platform: 'linux', env: { STUDY_ZHIPU_API_KEY: ENV_KEY }, protect: () => assert.fail('must not protect') });
  assert.equal(store.getKey(), ENV_KEY);
  assert.throws(() => store.update({ transport: 'official-api', apiKey: KEY }), /无法安全保存/);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(store.status().transport, 'web');
});

test('protection and round-trip verification failures preserve the previous disk and in-memory state', t => {
  const f = fixture(t);
  const initial = f.create();
  initial.update({ transport: 'official-api', apiKey: KEY });
  const before = f.read();
  for (const options of [
    { protect: () => { throw new Error(`sensitive ${OTHER_KEY}`); } },
    { protect: () => OTHER_KEY },
    { protect: value => protect(value), unprotect: value => value === protect(KEY) ? KEY : 'wrong-round-trip' },
  ]) {
    const store = f.create(options);
    const status = store.status();
    assert.throws(() => store.update({ transport: 'web', apiKey: OTHER_KEY }), error => {
      assert.equal(error.message, 'Windows密钥保护不可用，未保存密钥。');
      noSecrets(error.message);
      return true;
    });
    assert.equal(f.read(), before);
    assert.deepEqual(store.status(), status);
    assert.equal(store.getKey(), KEY);
  }
});

test('atomic-write failure never commits the new in-memory key or transport', t => {
  const f = fixture(t);
  f.create().update({ transport: 'web', apiKey: KEY });
  const before = f.read();
  const store = f.create({ atomicJson: () => { throw new Error(`raw failure ${OTHER_KEY}`); } });
  assert.throws(() => store.update({ transport: 'official-api', apiKey: OTHER_KEY }), error => {
    assert.equal(error.message, '官方API配置保存失败，原配置仍保留。');
    noSecrets(error.message);
    return true;
  });
  assert.equal(f.read(), before);
  assert.equal(store.getKey(), KEY);
  assert.equal(store.status().transport, 'web');
});

test('startup DPAPI failure produces a safe readable status without rewriting existing ciphertext', t => {
  const f = fixture(t);
  f.create().update({ transport: 'official-api', apiKey: KEY });
  const before = f.read();
  const store = f.create({ unprotect: () => { throw new Error(`raw helper failure ${KEY}`); } });
  assert.equal(store.getKey(), '');
  assert.equal(store.status().transport, 'official-api');
  assert.equal(store.status().configured, false);
  assert.equal(store.status().keyStorage, 'windows-dpapi');
  assert.match(store.status().message, /无法解密/);
  noSecrets(store.status());
  assert.equal(f.read(), before);
});

test('damaged or legacy plaintext settings are preserved until an explicit reset or new protected key', t => {
  const f = fixture(t);
  for (const original of ['{broken', JSON.stringify({ version: 1, transport: 'official-api', apiKey: KEY }),
    JSON.stringify({ version: 1, transport: 'official-api', model: 'glm-4.7-flashx', apiKeyCiphertext: protect(KEY) }),
    JSON.stringify({ version: 1, transport: 'web', webDriver: 'unknown', apiKeyCiphertext: protect(KEY) })]) {
    fs.writeFileSync(f.file, original);
    const store = f.create();
    assert.equal(store.status().configured, false);
    assert.equal(store.getKey(), '');
    noSecrets(store.status());
    assert.equal(f.read(), original);
    assert.throws(() => store.update({ transport: 'web' }), /原文件未修改/);
    assert.equal(f.read(), original);
    store.update({ transport: 'web', clearApiKey: true });
    assert.deepEqual(JSON.parse(f.read()), { version: 1, transport: 'web' });
  }
});

test('settings reject unknown fields, invalid keys and conflicting mutations before writing', t => {
  const f = fixture(t);
  const store = f.create();
  for (const input of [null, [], {}, { transport: 'other' }, { transport: undefined }, { transport: 'web', model: 'paid-model' },
    { model: 'glm-4-flash' }, { model: 'glm-4.5-flash' }, { model: 'glm-4.7-flashx' }, { model: undefined }, { model: null },
    { webDriver: null }, { webDriver: undefined }, { webDriver: '' }, { webDriver: 'unknown' },
    { transport: 'web', apiKey: '' }, { transport: 'web', apiKey: 'bad\r\nAuthorization:value' },
    { transport: 'web', apiKey: KEY, clearApiKey: true }, { transport: 'web', clearApiKey: 'true' }]) {
    assert.throws(() => store.update(input), /参数无效/);
  }
  assert.equal(fs.existsSync(f.file), false);
});

test('the default DPAPI helper uses only fixed scripts in arguments and passes keys through pipes', t => {
  const f = fixture(t);
  const calls = [];
  const store = f.create({ protect: undefined, unprotect: undefined, env: { STUDY_ZHIPU_API_KEY: ENV_KEY },
    runPowerShell(executable, args, options) {
      calls.push({ executable, args, options });
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.match(script, /DataProtectionScope\]::CurrentUser/);
      assert.ok(!JSON.stringify(args).includes(KEY));
      assert.ok(!JSON.stringify(args).includes(ENV_KEY));
      assert.ok(!JSON.stringify(options.env).includes(ENV_KEY));
      assert.deepEqual(Object.keys(options.env).sort(), ['SystemRoot', 'WINDIR']);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 10000);
      return { status: 0, stdout: script.includes(']::Protect(') ? protect(options.input) : unprotect(options.input) };
    } });
  store.update({ transport: 'official-api', apiKey: KEY });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.input, KEY);
  assert.equal(calls[1].options.input, protect(KEY));
  assert.ok(calls.every(call => call.args.includes('-NoProfile') && call.args.includes('-NonInteractive')));
  assert.ok(!f.read().includes(KEY));
});

test('failed DPAPI subprocess results expose no stderr, exception, input or ciphertext', t => {
  const f = fixture(t);
  const store = f.create({ protect: undefined, unprotect: undefined,
    runPowerShell: () => ({ status: 1, stdout: KEY, stderr: `leaked ${KEY}`, error: new Error(KEY) }) });
  assert.throws(() => store.update({ transport: 'official-api', apiKey: KEY }), error => {
    assert.equal(error.message, 'Windows密钥保护不可用，未保存密钥。');
    noSecrets(error.message);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(fs.existsSync(f.file), false);
});

test('official batch pins system and unchanged user messages, free JSON model and never reads personal data', async t => {
  const controller = new AbortController();
  const requestId = '12345678-1234-4234-9234-123456789abc';
  const content = ' {"batchToken":"fixture","items":[]}\n';
  const prompt = '  完整的测试批次\n保留用户 prompt 原文。\n';
  t.mock.method(fs, 'readFileSync', () => assert.fail('the request transport must not read local study or personal data'));
  let calls = 0;
  const input = { prompt, key: KEY, signal: controller.signal, requestId,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'POST');
      assert.equal(options.signal, controller.signal);
      assert.deepEqual(options.headers, { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
      const { messages, ...parameters } = JSON.parse(options.body);
      assert.deepEqual(parameters, { model: 'glm-4.7-flash', stream: false, temperature: 0.3, max_tokens: 8192,
        thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
        request_id: requestId });
      assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
      assert.equal(messages[1].content, prompt);
      assert.match(messages[0].content, /合法的 JSON/);
      assert.match(messages[0].content, /questionId、fingerprint、answer、analysis/);
      assert.match(messages[0].content, /独立审题/);
      assert.match(messages[0].content, /不.*个人作答、笔记或学习记录/);
      assert.ok(!options.body.includes(KEY));
      return response(good(content));
    } };
  for (const field of ['userAnswer', 'note', 'learningData']) Object.defineProperty(input, field, {
    get: () => assert.fail(`the request transport must not read ${field}`),
  });
  const text = await requestOfficialBatch(input);
  assert.equal(text, content, 'transport does not repair or rewrite the returned text');
  assert.equal(calls, 1);
});

test('the selected free 250414 model sends one standard JSON request without unsupported thinking configuration', async () => {
  const model = 'glm-4-flash-250414';
  const prompt = '  alternate free model fixture\n';
  const controller = new AbortController();
  const requestId = '12345678-1234-4234-9234-123456789abd';
  const content = '{"batchToken":"fixture-other","items":[]}';
  let calls = 0;
  const result = await requestOfficialBatch({ prompt, model, key: KEY, requestId, signal: controller.signal,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.signal, controller.signal);
      const body = JSON.parse(options.body);
      assert.equal(Object.hasOwn(body, 'thinking'), false);
      assert.deepEqual(Object.keys(body).sort(), ['model', 'stream', 'temperature', 'max_tokens', 'response_format', 'messages', 'request_id'].sort());
      assert.equal(body.messages[0].role, 'system');
      assert.match(body.messages[0].content, /顶层只能有 batchToken 和 items/);
      assert.deepEqual(body.messages[1], { role: 'user', content: prompt });
      assert.equal(body.messages.length, 2);
      assert.deepEqual({ ...body, messages: undefined }, { model, stream: false, temperature: 0.3, max_tokens: 8192,
        response_format: { type: 'json_object' }, request_id: requestId, messages: undefined });
      return response({ ...good(content), model });
    } });
  assert.equal(result, content);
  assert.equal(calls, 1);
});

test('a reply claiming any different model is rejected for either selected free model without fallback', async () => {
  for (const [model, receivedModel] of [
    ['glm-4.7-flash', 'glm-4-flash-250414'],
    ['glm-4-flash-250414', 'glm-4.7-flash'],
    ['glm-4-flash-250414', 'glm-4.7-flashx'],
  ]) {
    let calls = 0;
    await assert.rejects(requestOfficialBatch({ prompt: 'fixture', model, key: KEY, fetchImpl: async () => {
      calls++;
      return response({ ...good(), model: receivedModel });
    } }), /回复不完整或格式不符合要求/);
    assert.equal(calls, 1);
  }
});

test('HTTP failures only expose fixed safe messages and never retry', async () => {
  for (const status of [301, 401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(requestOfficialBatch({ prompt: 'fixture', key: KEY, fetchImpl: async () => {
      calls++;
      return response({ error: { code: 'unknown', message: KEY } }, status);
    } }), error => {
      noSecrets(error.message);
      assert.match(error.message, /^官方API/);
      assert.equal(error.safeMessage, error.message);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('known rate-limit codes are mapped safely on failed or nominally successful responses', async () => {
  for (const status of [200, 400, 429]) {
    for (const code of [1302, '1302', 1305, '1305']) {
      let calls = 0;
      await assert.rejects(requestOfficialBatch({ prompt: 'fixture', key: KEY, fetchImpl: async () => {
        calls++;
        return response({ error: { code, message: KEY, detail: { secret: OTHER_KEY } } }, status);
      } }), error => {
        assert.equal(error.safeMessage, String(code) === '1305'
          ? '官方模型暂时过载（1305），本批已停止；请稍后再试。'
          : '官方API限流（1302），本批已停止。');
        assert.equal(error.message, error.safeMessage);
        noSecrets(error);
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test('response content is capped at the journal limit without rewriting accepted text', async () => {
  const content = '测'.repeat(20000);
  assert.equal(await requestOfficialBatch({ prompt: 'fixture', key: KEY, fetchImpl: async () => response(good(content)) }), content);
  await assert.rejects(requestOfficialBatch({ prompt: 'fixture', key: KEY,
    fetchImpl: async () => response(good(`${content}测`)) }), /回复不完整或格式不符合要求/);
});

test('success and error envelopes are bounded before JSON parsing and oversized streams are cancelled', async () => {
  for (const status of [200, 400]) {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(131073).fill(120));
      },
      cancel() { cancelled = true; },
    });
    await assert.rejects(requestOfficialBatch({ prompt: 'fixture', key: KEY,
      fetchImpl: async () => new Response(body, { status }) }), error => {
      assert.match(error.safeMessage, /^官方API/);
      noSecrets(error);
      return true;
    });
    assert.equal(cancelled, true);
    assert.ok(pulls <= 2, 'the stream is not drained after the size limit');
  }
});

test('only one complete text choice with the pinned model is accepted', async () => {
  const invalid = [null, {}, { ...good(), model: 'glm-paid-model' }, { ...good(), model: null }, { ...good(), error: { secret: KEY } },
    { choices: [] }, { choices: [good().choices[0], good().choices[0]] },
    { choices: [{ ...good().choices[0], finish_reason: 'length' }] },
    { choices: [{ ...good().choices[0], finish_reason: 'tool_calls' }] },
    { choices: [{ ...good().choices[0], index: 1 }] },
    ...['', ' ', ['text'], null, 3].map(content => ({ choices: [{ ...good().choices[0], message: { content } }] })),
    { choices: [{ ...good().choices[0], message: { content: 'text', tool_calls: [] } }] },
    { choices: [{ ...good().choices[0], message: { content: 'text', function_call: {} } }] },
    { choices: [{ ...good().choices[0], message: { role: 'user', content: 'text' } }] },
    { choices: [{ ...good().choices[0], message: { content: 'text', refusal: 'refused' } }] }];
  for (const value of invalid) {
    let calls = 0;
    await assert.rejects(requestOfficialBatch({ prompt: 'fixture', key: KEY, fetchImpl: async () => { calls++; return response(value); } }),
      error => { assert.equal(error.message, '官方API回复不完整或格式不符合要求，本批已停止。'); noSecrets(error.message); return true; });
    assert.equal(calls, 1);
  }
  const withoutModel = good(); delete withoutModel.model;
  assert.equal(await requestOfficialBatch({ prompt: 'fixture', key: KEY, fetchImpl: async () => response(withoutModel) }), withoutModel.choices[0].message.content);
});

test('network and malformed JSON exceptions are replaced with fixed safe errors', async () => {
  for (const fetchImpl of [async () => { throw new Error(`network secret ${KEY}`); },
    async () => new Response(`invalid body ${KEY}`),
    async () => ({ ok: true, json: async () => { throw new Error(`invalid body ${KEY}`); } })]) {
    await assert.rejects(requestOfficialBatch({ prompt: 'fixture', key: KEY, fetchImpl }), error => {
      noSecrets(error.message);
      assert.match(error.message, /^官方API/);
      assert.equal(error.safeMessage, error.message);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('cancellation before sending or after receiving prevents returning a reply', async () => {
  const cancelled = new AbortController(); cancelled.abort(new Error(KEY));
  await assert.rejects(requestOfficialBatch({ prompt: 'fixture', key: KEY, signal: cancelled.signal,
    fetchImpl: async () => assert.fail('already cancelled') }), /请求已取消/);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(requestOfficialBatch({ prompt: 'fixture', key: KEY, signal: controller.signal, fetchImpl: async () => {
    calls++;
    const body = new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode(JSON.stringify(good())));
      controller.abort(new Error(KEY));
      stream.close();
    } });
    return new Response(body);
  } }), error => { assert.match(error.message, /请求已取消/); noSecrets(error.message); return true; });
  assert.equal(calls, 1);
});

test('invalid prompts, keys and tracing IDs are rejected without a network call', async () => {
  for (const input of [{}, { prompt: '', key: KEY }, { prompt: 'fixture', key: '' },
    ...['glm-4-flash', 'glm-4.5-flash', 'glm-4.7-flashx', 'paid-model', null].map(model => ({ prompt: 'fixture', key: KEY, model })),
    { prompt: 'fixture', key: 'bad\nkey' }, { prompt: 'fixture', key: KEY, requestId: 'not-a-uuid' },
    { prompt: 'x'.repeat(250001), key: KEY }]) {
    await assert.rejects(requestOfficialBatch({ ...input, fetchImpl: async () => assert.fail('invalid input must not send') }), /参数无效/);
  }
});
