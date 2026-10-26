import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createStudyApi } from './api.mjs';

const analysis = '本题需要先明确题干限定条件，再依据概念的正式定义逐项判断。A项符合当前场景的适用范围和工作原理。B项把对象的作用和实现层次混淆，不满足本题要求。复习时应比较对象、层次和条件三个维度，用具体的边界情况验证结论，不能仅凭术语熟悉程度作答。';
const bank = Array.from({ length: 6 }, (_, i) => ({ id: `OFF-${i + 1}`, type: 'single', category: '基础', chapter: '协议', difficulty: '基础',
  stem: `理论测试${i}`, options: [{ id: 'A', text: '定义一致' }, { id: 'B', text: '定义不同' }], answer: ['A'], explanation: '原题库解释', knowledgePoint: '条件', source: '测试' }));
const deferred = () => { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; };
async function until(read, accept, message = 'background task did not settle') {
  const start = Date.now();
  while (Date.now() - start < 4500) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(message);
}
const responseFor = (request, alter = () => {}) => {
  const prompt = JSON.parse(request.body).messages.find(message => message.role === 'user').content;
  const items = JSON.parse(prompt.split('题目数据：\n')[1].split('\n')[0]);
  const skeleton = JSON.parse(prompt.split('输出格式：\n')[1]);
  const questionById = new Map(items.map(item => [item.questionId, item]));
  const value = { batchToken: skeleton.batchToken, items: skeleton.items.map(item => ({ ...item,
    answer: questionById.get(item.questionId).referenceAnswer, analysis })) };
  alter(value);
  return Response.json({ model: JSON.parse(request.body).model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });
};
async function harness(t, { count = 5, key = 'fixture-official-key', respond = request => responseFor(request) } = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'yankao-official-runner-'));
  const dataDir = path.join(directory, 'state');
  const questionsPath = path.join(directory, 'questions.json');
  await fs.mkdir(dataDir);
  await fs.writeFile(questionsPath, JSON.stringify(bank.slice(0, count)));
  const originalLearning = JSON.stringify({ version: 1, progress: { 'OFF-1': { lastAnswer: ['B'], attempts: 2, note: '私人笔记测试哨兵', aiNote: '原个性化解析哨兵' } }, sessions: [] });
  await fs.writeFile(path.join(dataDir, 'learning-state.json'), originalLearning);
  let api, server, base, clock = Date.UTC(2026, 9, 23);
  const calls = [];
  const start = async () => {
    api = createStudyApi({ allowLegacyWebBridge: true, dataDir, questionsPath, now: () => clock, officialSettingsOptions: { env: key ? { STUDY_ZHIPU_API_KEY: key } : {} },
      fetchImpl: async (url, request) => { calls.push({ url, request }); return respond(request, calls.length); } });
    server = createServer(api.handle);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/study-api`;
  };
  const stop = async () => {
    api.close();
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  };
  t.after(stop);
  await start();
  const request = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { code: response.status, body: await response.json() };
  };
  const ok = async (...args) => { const result = await request(...args); assert.equal(result.code, 200, JSON.stringify(result.body)); return result.body; };
  return { dataDir, calls, request, ok, advance: n => { clock += n; }, stop,
    restart: async () => { await stop(); await start(); },
    read: async file => JSON.parse(await fs.readFile(path.join(dataDir, file), 'utf8')),
    verifyLearning: async () => assert.equal(await fs.readFile(path.join(dataDir, 'learning-state.json'), 'utf8'), originalLearning),
    configure: () => ok('/preanalysis/settings', { transport: 'official-api' }, 'PUT'),
    start: () => ok('/preanalysis/control', { action: 'start', batchSize: 5 }),
    status: () => ok('/preanalysis/status'),
  };
}

test('official batch cannot start without a key; read-only status never schedules', async t => {
  const app = await harness(t, { key: '' });
  await app.configure();
  assert.equal((await app.request('/preanalysis/control', { action: 'start', batchSize: 5 })).code, 503);
  await app.status(); await app.ok('/bridge/status');
  assert.equal(app.calls.length, 0);
  assert.equal((await app.status()).currentJobId, null);
  await assert.rejects(app.read('bridge-jobs.json'), { code: 'ENOENT' });
  await app.verifyLearning();
});

test('official runner completes two independent batches without a browser or personal data', async t => {
  const app = await harness(t, { count: 6 });
  await app.configure();
  await app.start();
  await until(app.status, value => value.completed === 5);
  assert.equal(app.calls.length, 1);
  const firstRequest = JSON.parse(app.calls[0].request.body);
  assert.equal(firstRequest.model, 'glm-4.7-flash');
  assert.match(app.calls[0].url, /^https:\/\/open\.bigmodel\.cn\/api\/paas\/v4\/chat\/completions$/);
  assert.doesNotMatch(JSON.stringify(firstRequest.messages), /私人笔记测试哨兵|原个性化解析哨兵|我的答案|lastAnswer/);
  const firstPrompt = firstRequest.messages.find(message => message.role === 'user').content;
  assert.match(firstPrompt, /不要使用 Markdown 代码块/);
  assert.ok(firstPrompt.indexOf('输出格式：\n') > firstPrompt.indexOf('题目数据：\n'));
  const data = JSON.parse(firstPrompt.split('题目数据：\n')[1].split('\n')[0]);
  assert.deepEqual(data, bank.slice(0, 5).map(item => ({ questionId: item.id, type: item.type, category: item.category,
    knowledgePoint: item.knowledgePoint, stem: item.stem, options: item.options,
    referenceAnswer: item.answer, referenceExplanation: item.explanation })));
  const outputTemplate = JSON.parse(firstPrompt.split('输出格式：\n')[1]);
  const firstJournal = await app.read('bridge-jobs.json');
  assert.equal(firstJournal.jobs[0].replyProtocol, 'preanalysis-fingerprint-v1', 'official API retains the fingerprint reply protocol');
  assert.equal(outputTemplate.batchToken, firstJournal.jobs[0].preanalysis.batchToken);
  assert.deepEqual(outputTemplate.items.map(({ questionId, fingerprint }) => ({ questionId, fingerprint })),
    firstJournal.jobs[0].preanalysis.items.map(({ questionId, fingerprint }) => ({ questionId, fingerprint })));
  assert.ok(outputTemplate.items.every(item => Object.keys(item).length === 4 && item.analysis === '' && item.answer.length === 0));
  for (const identity of [outputTemplate.batchToken, ...outputTemplate.items.map(item => item.fingerprint)]) {
    assert.equal(firstPrompt.split(identity).length - 1, 1);
  }
  assert.match(firstPrompt, /64 位 fingerprint 仅作机械复制，不得重算、删字符/);
  assert.match(firstPrompt, /每题独立核验答案/);
  assert.match(firstPrompt, /按选项原顺序逐项书写，每项格式为“选项号（正确\/错误）：一个必要直接依据”/);
  assert.match(firstPrompt, /每个事实句必须对应原选项判定所需的必要前提；不能对应就删去/);
  assert.match(firstPrompt, /按适用标准、版本、对象状态和具体操作核验其保证、条件与不确定性/);
  assert.match(firstPrompt, /只对已确定的语义作断言，不用可能的运行表现判定行为性质，不从局部结论推出更强的通用规则、充分条件或安全保证/);
  assert.match(firstPrompt, /80—160 字仅为篇幅预计，不是配额，不凑字且不得超过 400 字/);
  assert.match(firstPrompt, /80 字符下限，不足时只补完整已有选项的直接依据，不引入题外事实/);
  assert.doesNotMatch(firstPrompt, /180—300|SQL 自身定义|未定义行为|malloc|calloc|Python 可哈希性/);
  await app.verifyLearning();
  app.advance(5001);
  await until(app.status, value => value.status === 'completed');
  assert.equal(app.calls.length, 2);
  const journal = await app.read('bridge-jobs.json');
  assert.equal(journal.jobs.length, 2);
  assert.notEqual(journal.jobs[0].preanalysis.batchToken, journal.jobs[1].preanalysis.batchToken);
  assert.ok(journal.jobs.every(job => job.transport === 'official-api' && job.status === 'completed'));
  assert.match((await app.ok('/preanalysis/questions/OFF-1')).source, /智谱官方 API.*glm-4.7-flash/);
  await app.restart();
  assert.equal((await app.status()).completed, 6);
  await app.verifyLearning();
});

test('pause aborts a request that ignores abort, retry uses a new job, and late reply never writes', async t => {
  const late = deferred();
  let firstRequest;
  const app = await harness(t, { respond: (request, number) => {
    if (number === 1) { firstRequest = request; return late.promise; }
    return responseFor(request);
  } });
  await app.configure(); await app.start();
  await until(async () => app.calls.length, value => value === 1);
  const oldId = (await app.status()).currentJobId;
  await app.ok('/preanalysis/control', { action: 'pause' });
  assert.equal(firstRequest.signal.aborted, true);
  await app.ok('/preanalysis/settings', { model: 'glm-4-flash-250414' }, 'PUT');
  await app.ok('/preanalysis/control', { action: 'retry', batchSize: 5 });
  await until(app.status, value => value.completed === 5);
  assert.equal(JSON.parse(app.calls[1].request.body).model, 'glm-4-flash-250414');
  const before = JSON.stringify(await app.read('preanalysis-state.json'));
  late.resolve(responseFor(firstRequest));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(JSON.stringify(await app.read('preanalysis-state.json')), before);
  const jobs = (await app.read('bridge-jobs.json')).jobs;
  assert.equal(jobs.find(job => job.id === oldId).failureCode, 'batch-paused');
  assert.equal(jobs.length, 2);
  assert.equal(app.calls.length, 2);
  await app.verifyLearning();
});

test('explicit free-model change preserves earlier source and mixed-model journal across restart', async t => {
  const app = await harness(t, { count: 6 });
  await app.configure(); await app.start();
  await until(app.status, value => value.completed === 5);
  await app.ok('/preanalysis/control', { action: 'pause' });
  const prior = (await app.read('preanalysis-state.json')).cache['OFF-1'];
  assert.equal((await app.request('/preanalysis/settings', { model: 'glm-4.7-flashx' }, 'PUT')).code, 400);
  const settings = await app.ok('/preanalysis/settings', { model: 'glm-4-flash-250414' }, 'PUT');
  assert.equal(settings.configured, true);
  assert.equal(settings.transport, 'official-api');
  assert.equal(app.calls.length, 1, 'saving the model never submits a request');
  app.advance(5001);
  await app.start();
  await until(app.status, value => value.status === 'completed');
  const second = JSON.parse(app.calls[1].request.body);
  assert.equal(second.model, 'glm-4-flash-250414');
  assert.equal(Object.hasOwn(second, 'thinking'), false, 'pre-4.5 model has no thinking parameter');
  await app.restart();
  const jobs = (await app.read('bridge-jobs.json')).jobs;
  assert.deepEqual(jobs.map(job => job.model), ['glm-4.7-flash', 'glm-4-flash-250414']);
  assert.ok(jobs.every(job => job.status === 'completed'));
  assert.deepEqual((await app.read('preanalysis-state.json')).cache['OFF-1'], prior);
  assert.match((await app.ok('/preanalysis/questions/OFF-6')).source, /glm-4-flash-250414/);
  assert.equal((await app.status()).completed, 6);
  await app.verifyLearning();
});

test('parallel start does not resubmit; web polling and updates cannot claim official jobs', async t => {
  const wait = deferred();
  const app = await harness(t, { respond: () => wait.promise });
  await app.configure();
  await Promise.all([app.start(), app.start(), app.start()]);
  await until(async () => app.calls.length, value => value === 1);
  const id = (await app.status()).currentJobId;
  assert.deepEqual((await app.ok('/bridge/pending?provider=zhipu')).jobs, []);
  assert.equal((await app.request(`/bridge/jobs/${id}/update`, { provider: 'zhipu', status: 'completed', text: 'forged' })).code, 409);
  assert.equal((await app.request('/preanalysis/settings', { transport: 'web' }, 'PUT')).code, 409);
  assert.equal(app.calls.length, 1);
  await app.stop();
});

test('official answer disagreement quarantines the full batch and pauses without repairing', async t => {
  const app = await harness(t, { respond: request => responseFor(request, value => { value.items[4].answer = ['B']; }) });
  await app.configure(); await app.start();
  await until(app.status, value => value.failed === 5 && value.status === 'paused');
  const stored = await app.read('preanalysis-state.json');
  assert.deepEqual(stored.cache, {});
  assert.equal(stored.quarantine.length, 1);
  assert.deepEqual(JSON.parse(stored.quarantine[0].text).items[4].answer, ['B']);
  await app.verifyLearning();
});

test('official rate limit pauses once without falling back or resending', async t => {
  const app = await harness(t, { respond: () => Response.json({ error: { message: 'secret-fixture-must-not-echo' } }, { status: 429 }) });
  await app.configure(); await app.start();
  const status = await until(app.status, value => value.status === 'paused' && value.failed === 5);
  assert.match(status.message, /额度|速率/);
  assert.doesNotMatch(JSON.stringify(status), /secret-fixture-must-not-echo/);
  await app.ok('/bridge/pending?provider=zhipu'); await app.status();
  assert.equal(app.calls.length, 1);
  assert.equal((await app.ok('/preanalysis/settings')).transport, 'official-api');
  await app.verifyLearning();
});

test('malformed official analysis field is quarantined verbatim without saving earlier valid items', async t => {
  let malformed;
  const app = await harness(t, { respond: async request => {
    const envelope = await responseFor(request).json();
    const content = envelope.choices[0].message.content;
    const at = content.lastIndexOf('"analysis":');
    malformed = content.slice(0, at) + content.slice(at).replace('"analysis":"', '"analysis">');
    envelope.choices[0].message.content = malformed;
    return Response.json(envelope);
  } });
  await app.configure(); await app.start();
  await until(app.status, value => value.status === 'paused' && value.failed === 5);
  const stored = await app.read('preanalysis-state.json');
  assert.deepEqual(stored.cache, {});
  assert.equal(stored.quarantine[0].text, malformed);
  assert.equal(app.calls.length, 1);
  await app.verifyLearning();
});

test('timeout becomes terminal and restart pauses without replaying the request', async t => {
  const late = deferred();
  const app = await harness(t, { respond: () => late.promise });
  await app.configure(); await app.start();
  await until(async () => app.calls.length, value => value === 1);
  app.advance(120001);
  const expired = await app.status();
  assert.equal(expired.status, 'paused');
  assert.match(expired.message, /官方 API.*超时/);
  assert.equal(app.calls[0].request.signal.aborted, true);
  late.resolve(responseFor(app.calls[0].request));
  await app.restart();
  assert.equal((await app.status()).completed, 0);
  assert.equal((await app.status()).status, 'paused');
  assert.equal(app.calls.length, 1);
  assert.equal((await app.read('bridge-jobs.json')).jobs[0].failureCode, 'no-progress');
  await app.verifyLearning();
});

test('close prevents late response persistence and restart requires explicit resume', async t => {
  const late = deferred();
  const app = await harness(t, { respond: () => late.promise });
  await app.configure(); await app.start();
  await until(async () => app.calls.length, value => value === 1);
  await app.stop();
  late.resolve(responseFor(app.calls[0].request));
  await app.restart();
  assert.equal((await app.status()).status, 'paused');
  assert.equal((await app.status()).completed, 0);
  assert.equal(app.calls.length, 1);
  assert.equal((await app.read('bridge-jobs.json')).jobs[0].failureCode, 'service-stopped');
  await app.verifyLearning();
});
