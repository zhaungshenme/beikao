import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createStudyApi } from './api.mjs';
import { createPreanalysisStore, questionFingerprint, PREANALYSIS_PROMPT_VERSION, PREANALYSIS_REPLY_V1, PREANALYSIS_REPLY_V2 } from './preanalysis.mjs';

const bank = Array.from({ length: 3 }, (_, index) => ({ id: `PROTOCOL-${index + 1}`, type: 'single', category: '基础', chapter: '协议', difficulty: '基础',
  stem: `协议身份测试${index + 1}`, options: [{ id: 'A', text: '定义符合' }, { id: 'B', text: '定义不符' }],
  answer: ['A'], explanation: `原始标准解释${index + 1}`, knowledgePoint: '适用条件', source: '测试' }));
const analysis = '本题应先依据题干限定条件确认对象，再逐项核对概念的定义和适用范围。A项符合当前条件，是正确选项；B项混淆了对象所处的层次和作用，不能据此判断。复习时应保留结论的适用条件，并比较各选项的关键差异。不能把特定对象或特定实现的能力推广到所有对象，也不应增加缺乏题干依据的额外结论。';

async function harness(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'yankao-protocol-v2-'));
  const dataDir = path.join(directory, 'state');
  const questionsPath = path.join(directory, 'questions.json');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(questionsPath, JSON.stringify(bank));
  fs.writeFileSync(path.join(dataDir, 'learning-state.json'), JSON.stringify({ version: 1, progress: {
    'PROTOCOL-1': { attempts: 2, lastAnswer: ['B'], note: '协议测试私人笔记', aiNote: '协议测试个人解析' },
  }, sessions: [] }));
  let now = Date.UTC(2026, 9, 23), api, server, base;
  const start = async () => {
    api = createStudyApi({ allowLegacyWebBridge: true, dataDir, questionsPath, now: () => now });
    server = createServer(api.handle);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/study-api`;
  };
  const stop = async () => {
    api.close();
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
  };
  await start();
  t.after(stop);
  const request = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (...args) => { const result = await request(...args); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  return { dataDir, questionsPath, request, ok, advance: value => { now += value; }, restart: async () => { await stop(); await start(); },
    bytes: name => fs.readFileSync(path.join(dataDir, name), 'utf8'),
    read: name => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')),
    async dispatch(driver = 'browser-ui', action = 'start') {
      await ok('/preanalysis/settings', { transport: 'web', webDriver: driver }, 'PUT');
      await ok('/preanalysis/control', { action, batchSize: 3, replyProtocol: 'untrusted-client-value' });
      return (await ok(`/bridge/pending?provider=zhipu&driver=${driver}&replyProtocol=untrusted-client-value`)).jobs[0];
    },
  };
}

const reply = job => ({ batchToken: job.preanalysis.batchToken,
  items: job.preanalysis.items.map(item => ({ questionId: item.questionId, answer: item.answer, analysis })) });
const complete = (app, job, text = JSON.stringify(reply(job))) => app.ok(`/bridge/jobs/${job.id}/update`, {
  provider: 'zhipu', driver: 'browser-ui', status: 'completed', text,
});

test('browser-ui v2 keeps local fingerprints, requests only IDs in one fenced output skeleton, and persists the raw code text across restart', async t => {
  const app = await harness(t);
  const learning = app.bytes('learning-state.json');
  const questions = fs.readFileSync(app.questionsPath, 'utf8');
  const job = await app.dispatch();
  assert.equal(PREANALYSIS_PROMPT_VERSION, 1);
  assert.equal(job.replyProtocol, PREANALYSIS_REPLY_V2);
  assert.equal(job.webDriver, 'browser-ui');
  assert.deepEqual(job.preanalysis.items, bank.map(question => ({ questionId: question.id,
    fingerprint: questionFingerprint(question), answer: question.answer })));
  assert.match(job.prompt, /只输出一个标记为 json 的 Markdown 围栏代码块/);
  assert.match(job.prompt, /每题独立核验答案/);
  assert.match(job.prompt, /按选项原顺序逐项书写，每项格式为“选项号（正确\/错误）：一个必要直接依据”/);
  assert.match(job.prompt, /每个事实句必须对应原选项判定所需的必要前提；不能对应就删去/);
  assert.match(job.prompt, /按适用标准、版本、对象状态和具体操作核验其保证、条件与不确定性/);
  assert.match(job.prompt, /只对已确定的语义作断言，不用可能的运行表现判定行为性质，不从局部结论推出更强的通用规则、充分条件或安全保证/);
  assert.match(job.prompt, /80—160 字仅为篇幅预计，不是配额，不凑字且不得超过 400 字/);
  assert.match(job.prompt, /80 字符下限，不足时只补完整已有选项的直接依据，不引入题外事实/);
  assert.doesNotMatch(job.prompt, /180—300|SQL 自身定义|未定义行为|malloc|calloc|Python 可哈希性/);
  assert.doesNotMatch(job.prompt, /fingerprint|协议测试私人笔记|协议测试个人解析|lastAnswer|我的答案/);
  for (const item of job.preanalysis.items) assert.ok(!job.prompt.includes(item.fingerprint));
  assert.equal(job.prompt.split(job.preanalysis.batchToken).length - 1, 1);
  const data = JSON.parse(job.prompt.split('题目数据：\n')[1].split('\n')[0]);
  assert.deepEqual(data, bank.map(item => ({ questionId: item.id, type: item.type, category: item.category,
    knowledgePoint: item.knowledgePoint, stem: item.stem, options: item.options,
    referenceAnswer: item.answer, referenceExplanation: item.explanation })));
  const template = job.prompt.split('输出格式：\n')[1];
  assert.ok(template.startsWith('```json\n') && template.endsWith('\n```'));
  assert.deepEqual(JSON.parse(template.slice(8, -4)), { batchToken: job.preanalysis.batchToken,
    items: job.preanalysis.items.map(item => ({ questionId: item.questionId, answer: [], analysis: '' })) });
  const response = reply(job);
  response.items.reverse();
  response.items[0].analysis += '\nCOUNT(*)、row_level_security 与双引号 "quoted"、反斜杠 C:\\logs 均保持原样。';
  const raw = ' \n' + JSON.stringify(response, null, 2) + '\n';
  const completed = await complete(app, job, raw);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.text, raw, 'no wrapper removal, repair or reserialization of the submitted code text');
  for (const item of job.preanalysis.items) {
    const cached = app.read('preanalysis-state.json').cache[item.questionId];
    assert.equal(cached.fingerprint, item.fingerprint);
    assert.equal(cached.promptVersion, 1);
    assert.deepEqual(cached.answer, item.answer);
  }
  const cache = app.bytes('preanalysis-state.json');
  const journal = app.bytes('bridge-jobs.json');
  await app.restart();
  const restored = await app.ok(`/bridge/jobs/${job.id}?driver=browser-ui`);
  assert.equal(restored.replyProtocol, PREANALYSIS_REPLY_V2);
  assert.equal(restored.text, raw);
  assert.equal(app.bytes('bridge-jobs.json'), journal);
  assert.equal(app.bytes('preanalysis-state.json'), cache);
  assert.equal(app.bytes('learning-state.json'), learning);
  assert.equal(fs.readFileSync(app.questionsPath, 'utf8'), questions);
  assert.deepEqual(await complete(app, job, 'late replacement'), restored);
  assert.equal(app.bytes('bridge-jobs.json'), journal);
});

for (const [name, alter] of [
  ['wrong token', value => { value.batchToken = 'different-batch'; }],
  ['missing ID', value => { value.items.pop(); }],
  ['additional ID', value => { value.items.push({ ...value.items[0], questionId: 'PROTOCOL-EXTRA' }); }],
  ['duplicate ID', value => { value.items[1].questionId = value.items[0].questionId; }],
  ['unknown ID', value => { value.items[0].questionId = 'PROTOCOL-UNKNOWN'; }],
  ['answer conflict', value => { value.items[1].answer = ['B']; }],
  ['unexpected fingerprint', value => { value.items[0].fingerprint = 'a'.repeat(64); }],
  ['unexpected item field', value => { value.items[0].extra = 'untrusted'; }],
  ['unexpected top-level field', value => { value.replyProtocol = PREANALYSIS_REPLY_V2; }],
]) test(`v2 rejects ${name} atomically and quarantines the unchanged source without touching personal learning`, async t => {
  const app = await harness(t);
  const learning = app.bytes('learning-state.json');
  const job = await app.dispatch();
  const value = reply(job); alter(value);
  const raw = JSON.stringify(value);
  const result = await complete(app, job, raw);
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'preanalysis-validation');
  const state = app.read('preanalysis-state.json');
  assert.deepEqual(state.cache, {});
  assert.equal(state.status, 'paused');
  assert.equal(Object.keys(state.failures).length, 3);
  assert.equal(state.quarantine.length, 1);
  assert.equal(state.quarantine[0].text, raw);
  assert.equal(state.quarantine[0].replyProtocol, PREANALYSIS_REPLY_V2);
  assert.deepEqual(state.quarantine[0].expected, job.preanalysis.items);
  assert.equal(app.bytes('learning-state.json'), learning);
  const journal = app.bytes('bridge-jobs.json');
  assert.equal((await complete(app, job)).status, 'failed');
  assert.equal(app.bytes('bridge-jobs.json'), journal, 'a corrected late reply cannot bless the terminal failed batch');
});

for (const [name, change] of [
  ['question text', questions => { questions[0].stem += '已变更'; }],
  ['option text', questions => { questions[0].options[0].text += '已变更'; }],
  ['standard answer', questions => { questions[0].answer = ['B']; }],
  ['standard explanation', questions => { questions[0].explanation += '已更正'; }],
  ['standard revision', questions => { questions[0].answerRevision = 1; }],
]) test(`v2 without a response fingerprint still rejects a changed ${name} before saving any item`, () => {
  const dataDir = fs.mkdtempSync(path.join(tmpdir(), 'yankao-protocol-change-'));
  const questions = structuredClone(bank);
  const store = createPreanalysisStore({ dataDir, getQuestions: () => questions,
    atomicJson: (file, data) => fs.writeFileSync(file, JSON.stringify(data)) });
  store.control('start', 3);
  const job = { ...store.next({ replyProtocol: PREANALYSIS_REPLY_V2 }), id: 'changed-local-batch', provider: 'zhipu', webDriver: 'browser-ui' };
  store.assigned(job);
  const raw = JSON.stringify(reply(job));
  change(questions);
  assert.equal(store.complete(job, raw).valid, false);
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'preanalysis-state.json'), 'utf8'));
  assert.deepEqual(state.cache, {});
  assert.match(state.message, /题目或标准答案已变更/);
  assert.equal(state.quarantine[0].text, raw);
});

test('v2 parses only raw code JSON and rejects wrapped, truncated or expression payloads without repair', async t => {
  for (const wrap of [raw => '```json\n' + raw + '\n```', raw => raw.slice(0, -1), raw => raw + '.replace("x", "y")']) {
    const app = await harness(t);
    const job = await app.dispatch();
    const raw = wrap(JSON.stringify(reply(job)));
    assert.equal((await complete(app, job, raw)).status, 'failed');
    const state = app.read('preanalysis-state.json');
    assert.deepEqual(state.cache, {});
    assert.equal(state.quarantine[0].text, raw);
  }
});

test('driver and protocol mutation rejections precede timeout refresh, and legacy v1 cannot omit its fingerprint', async t => {
  const app = await harness(t);
  const job = await app.dispatch();
  const journal = app.bytes('bridge-jobs.json');
  const state = app.bytes('preanalysis-state.json');
  app.advance(120001);
  for (const body of [
    { provider: 'zhipu', status: 'completed', text: JSON.stringify(reply(job)) },
    { provider: 'zhipu', driver: 'browser-ui', status: 'completed', replyProtocol: PREANALYSIS_REPLY_V1, text: JSON.stringify(reply(job)) },
    { provider: 'zhipu', driver: 'browser-ui', status: 'completed', replyProtocol: PREANALYSIS_REPLY_V2, text: JSON.stringify(reply(job)) },
  ]) {
    assert.equal((await app.request(`/bridge/jobs/${job.id}/update`, body)).status, 409);
    assert.equal(app.bytes('bridge-jobs.json'), journal);
    assert.equal(app.bytes('preanalysis-state.json'), state);
  }
  assert.equal((await app.ok('/bridge/pending?provider=zhipu')).jobs.length, 0);
  assert.equal((await app.request(`/bridge/jobs/${job.id}`)).status, 409);
  assert.equal(app.bytes('bridge-jobs.json'), journal);
  assert.equal(app.bytes('preanalysis-state.json'), state);
  await app.ok('/preanalysis/control', { action: 'pause' });
  const v1 = await app.dispatch('userscript', 'retry');
  assert.equal(v1.replyProtocol, PREANALYSIS_REPLY_V1);
  assert.ok(v1.preanalysis.items.every(item => v1.prompt.includes(item.fingerprint)));
  const missing = await app.ok(`/bridge/jobs/${v1.id}/update`, { provider: 'zhipu', status: 'completed', text: JSON.stringify(reply(v1)) });
  assert.equal(missing.status, 'failed');
  assert.match(missing.error, /内容指纹不匹配/);
});

test('legacy journal missing replyProtocol stays v1; unknown or misplaced protocols fail closed without rewriting', async t => {
  const app = await harness(t);
  const v1 = await app.dispatch('userscript');
  await app.ok(`/bridge/jobs/${v1.id}/cancel`, {});
  const journal = app.read('bridge-jobs.json');
  delete journal.jobs[0].replyProtocol;
  journal.jobs[0].webDriver = 'browser-ui';
  const legacy = JSON.stringify(journal);
  fs.writeFileSync(path.join(app.dataDir, 'bridge-jobs.json'), legacy);
  await app.restart();
  assert.equal((await app.ok(`/bridge/jobs/${v1.id}?driver=browser-ui`)).replyProtocol, PREANALYSIS_REPLY_V1);
  assert.equal(app.bytes('bridge-jobs.json'), legacy);
  for (const replyProtocol of [null, '', 'unknown-v3']) {
    journal.jobs[0].replyProtocol = replyProtocol;
    const invalid = JSON.stringify(journal);
    fs.writeFileSync(path.join(app.dataDir, 'bridge-jobs.json'), invalid);
    const state = app.bytes('preanalysis-state.json');
    assert.throws(() => createStudyApi({ allowLegacyWebBridge: true, dataDir: app.dataDir, questionsPath: app.questionsPath }), /解析任务记录损坏/);
    assert.equal(app.bytes('bridge-jobs.json'), invalid);
    assert.equal(app.bytes('preanalysis-state.json'), state);
  }
  journal.jobs[0].replyProtocol = PREANALYSIS_REPLY_V2;
  journal.jobs[0].webDriver = 'userscript';
  fs.writeFileSync(path.join(app.dataDir, 'bridge-jobs.json'), JSON.stringify(journal));
  assert.throws(() => createStudyApi({ allowLegacyWebBridge: true, dataDir: app.dataDir, questionsPath: app.questionsPath }), /解析任务记录损坏/);
});

test('restarting an active v2 batch pauses without replay, and only a new token may save a new batch', async t => {
  const app = await harness(t);
  const learning = app.bytes('learning-state.json');
  const old = await app.dispatch();
  const oldText = JSON.stringify(reply(old));
  await app.restart();
  const stopped = await app.ok(`/bridge/jobs/${old.id}?driver=browser-ui`);
  assert.equal(stopped.replyProtocol, PREANALYSIS_REPLY_V2);
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.failureCode, 'service-restarted');
  assert.equal((await app.ok('/bridge/pending?provider=zhipu&driver=browser-ui')).jobs.length, 0);
  assert.deepEqual(await complete(app, old, oldText), stopped);
  assert.deepEqual(app.read('preanalysis-state.json').cache, {});
  const next = await app.dispatch('browser-ui', 'retry');
  assert.notEqual(next.id, old.id);
  assert.notEqual(next.preanalysis.batchToken, old.preanalysis.batchToken);
  assert.equal(next.replyProtocol, PREANALYSIS_REPLY_V2);
  assert.equal((await complete(app, next, oldText)).status, 'failed', 'a previous raw response is not reassigned to a new protocol task');
  const quarantine = app.read('preanalysis-state.json').quarantine;
  assert.equal(quarantine.at(-1).text, oldText);
  assert.deepEqual(app.read('preanalysis-state.json').cache, {});
  assert.equal(app.bytes('learning-state.json'), learning);
});

test('the store rejects unknown protocol selection and official v2 without changing durable state', () => {
  const dataDir = fs.mkdtempSync(path.join(tmpdir(), 'yankao-protocol-invalid-'));
  const store = createPreanalysisStore({ dataDir, getQuestions: () => structuredClone(bank),
    atomicJson: (file, data) => fs.writeFileSync(file, JSON.stringify(data)) });
  store.control('start', 3);
  const before = fs.readFileSync(path.join(dataDir, 'preanalysis-state.json'), 'utf8');
  assert.throws(() => store.next({ replyProtocol: 'unknown-v3' }), /协议无效/);
  assert.throws(() => store.next({ transport: 'official-api', replyProtocol: PREANALYSIS_REPLY_V2 }), /协议无效/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'preanalysis-state.json'), 'utf8'), before);
});

for (const replyProtocol of [PREANALYSIS_REPLY_V1, PREANALYSIS_REPLY_V2]) {
  for (const [name, change] of [
    ['question text', questions => { questions[0].stem += '已变化'; }],
    ['standard answer', questions => { questions[0].answer = ['B']; }],
    ['missing question', questions => { questions.shift(); }],
  ]) test(`${replyProtocol} idempotent retry succeeds only while current ${name} still matches the saved fingerprint`, () => {
    const dataDir = fs.mkdtempSync(path.join(tmpdir(), 'yankao-protocol-idempotent-'));
    const questions = structuredClone(bank);
    const store = createPreanalysisStore({ dataDir, getQuestions: () => questions,
      atomicJson: (file, data) => fs.writeFileSync(file, JSON.stringify(data)) });
    store.control('start', 3);
    const job = { ...store.next({ replyProtocol }), id: 'journal-write-retry-batch', provider: 'zhipu', webDriver: 'browser-ui' };
    store.assigned(job);
    const value = reply(job);
    if (replyProtocol === PREANALYSIS_REPLY_V1) {
      for (const [index, item] of value.items.entries()) item.fingerprint = job.preanalysis.items[index].fingerprint;
    }
    const first = JSON.stringify(value);
    assert.equal(store.complete(job, first).valid, true);
    const file = path.join(dataDir, 'preanalysis-state.json');
    const savedBytes = fs.readFileSync(file, 'utf8');
    const savedCache = JSON.parse(savedBytes).cache;
    assert.equal(store.complete(job, first).valid, true, 'a journal acknowledgement retry remains idempotent before any question change');
    assert.equal(fs.readFileSync(file, 'utf8'), savedBytes);
    change(questions);
    value.items[0].analysis += '这段重试正文不得覆盖已保存的旧缓存。';
    const retryText = JSON.stringify(value);
    assert.equal(store.complete(job, retryText).valid, false, 'saved job identity cannot bypass the current-question fingerprint check');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.status, 'paused');
    assert.deepEqual(after.cache, savedCache, 'all previously saved cache entries remain exact evidence');
    assert.match(after.message, /题目或标准答案已变更/);
    assert.equal(after.quarantine.at(-1).text, retryText);
    if (name !== 'missing question') {
      assert.equal(store.question('PROTOCOL-1').state, 'stale');
      assert.equal(store.question('PROTOCOL-1').text, '');
    }
  });
}
