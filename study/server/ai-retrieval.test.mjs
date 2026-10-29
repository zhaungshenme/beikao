import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStudyApi } from './api.mjs';

const bank = [{ id: 'retrieval-single', type: 'single', category: '基础', chapter: '归档', difficulty: '基础', knowledgePoint: '公开资料', stem: '合成检索测试', options: [{ id: 'A', text: '资料' }, { id: 'B', text: '模型' }], answer: ['A'], explanation: '历史资料应保留。', source: '测试' }];
const id = bank[0].id;
const secret = 'test-only-retrieval-key';
const completion = () => { throw new Error('Generation is forbidden'); };
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
async function harness(t, fetchImpl = async () => { throw new Error('Unexpected external request in retrieval integration test'); }, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'beikao-ai-retrieval-'));
  const dataDir = join(directory, 'state');
  const questionsPath = join(directory, 'questions.json');
  await mkdir(dataDir);
  await writeFile(questionsPath, JSON.stringify(bank));
  let api, server, base;
  async function start(runtimeOptions = {}) {
    api = createStudyApi({ dataDir, questionsPath, fetchImpl, ...runtimeOptions });
    server = createServer((req, res) => api.handle(req, res));
    await new Promise(accept => server.listen(0, '127.0.0.1', accept));
    base = `http://127.0.0.1:${server.address().port}/study-api`;
  }
  async function stop() {
    const closed = new Promise(accept => server.close(accept));
    server.closeAllConnections();
    await closed;
    api.close();
  }
  await start(options);
  t.after(async () => {
    await stop();
    const owned = resolve(directory);
    assert.ok(owned.startsWith(resolve(tmpdir()) + sep) && owned.split(sep).at(-1).startsWith('beikao-ai-retrieval-'));
    await rm(owned, { recursive: true, force: true });
  });
  return {
    async request(path, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async restart(runtimeOptions = {}) { await stop(); await start(runtimeOptions); },
    savedState: async () => JSON.parse(await readFile(join(dataDir, 'learning-state.json'), 'utf8')),
    async savedDocuments() {
      return Object.fromEntries(await Promise.all(['learning-state.json', 'bridge-jobs.json', 'preanalysis-state.json'].map(async name => {
        try { return [name, await readFile(join(dataDir, name), 'utf8')]; }
        catch (error) { if (error.code === 'ENOENT') return [name, null]; throw error; }
      })));
    },
  };
}

const note = (app, text, expected = '') => app.request(`/questions/${id}`, { aiNote: text, expected: { aiNote: expected } }, 'PATCH');
const history = async app => ok(await app.request(`/questions/${id}/history`)).entries;

test('settings expose retrieval-only mode, ignore legacy generation switches and never reveal the key', async t => {
  let calls = 0;
  const app = await harness(t, async () => { calls++; throw new Error('Settings must not make requests'); });
  const settings = ok(await app.request('/ai/settings', { baseUrl: 'https://api.deepseek.com/v1', apiKey: secret, model: 'obsolete-model', retrievalEnabled: false }, 'PUT'));
  assert.equal(settings.mode, 'web-retrieval-only');
  assert.equal(settings.model, '');
  assert.equal(settings.retrievalEnabled, true);
  assert.equal(settings.retrievalAvailable, true);
  assert.equal(settings.configured, true);
  assert.doesNotMatch(JSON.stringify(settings), new RegExp(secret));
  const before = await app.savedDocuments();
  for (const body of [{}, { questionId: id }, { questionId: id, retrievalEnabled: true }, { questionId: id, retrievalEnabled: 'invalid', question: 'do not generate' }]) {
    const result = await app.request('/ai/explain', body);
    assert.equal(result.status, 410);
    assert.equal(result.body.modelRequested, false);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await app.savedDocuments(), before);
});

test('settings reject every non-official endpoint before accepting credentials or making requests', async t => {
  let calls = 0;
  const app = await harness(t, async () => { calls++; throw new Error('No network'); });
  for (const baseUrl of ['https://example.invalid/v1', 'https://api.deepseek.com.example.invalid/v1', 'https://api.deepseek.com/v1/other', 'https://api.deepseek.com:8443/v1', 'http://api.deepseek.com/v1', 'https://user:password@api.deepseek.com/v1', 'https://api.deepseek.com/v1?target=other', 'https://api.deepseek.com/v1#other']) {
    assert.equal((await app.request('/ai/settings', { baseUrl, apiKey: secret }, 'PUT')).status, 400, baseUrl);
  }
  assert.equal(calls, 0);
});

test('production defaults retire personal web jobs and web batch dispatch without changing saved records', async t => {
  let calls = 0;
  const app = await harness(t, async () => { calls++; return completion(); });
  ok(await note(app, '旧链路退役前已保存的解析，必须完整保留。'));
  const beforeStatus = ok(await app.request('/preanalysis/status'));
  const beforeBridge = ok(await app.request('/bridge/status'));
  const beforeHistory = await history(app);
  const beforeFiles = await app.savedDocuments();
  assert.equal(beforeStatus.transport, 'web');
  for (const provider of ['zhipu', 'deepseek']) {
    const retired = await app.request('/bridge/jobs', { questionId: id, answer: ['B'], provider });
    assert.equal(retired.status, 410);
    assert.match(retired.body.error, /停用|退役/);
  }
  for (const action of ['start', 'retry']) {
    assert.equal((await app.request('/preanalysis/control', { action, batchSize: 1 })).status, 410);
  }
  // This GET targets only this test's ephemeral loopback server and synthetic bank.
  assert.deepEqual(ok(await app.request('/bridge/pending?provider=zhipu&driver=browser-ui')).jobs, []);
  assert.deepEqual(ok(await app.request('/preanalysis/status')), beforeStatus);
  assert.deepEqual(ok(await app.request('/bridge/status')), beforeBridge);
  assert.equal(ok(await app.request('/bridge/overview')).activeJob, null);
  assert.deepEqual(await history(app), beforeHistory);
  assert.deepEqual(await app.savedDocuments(), beforeFiles);
  assert.equal(calls, 0);
});

test('reopening legacy personal web jobs retires only unfinished work and never rewrites terminal history or learning text', async t => {
  let calls = 0;
  const app = await harness(t, async () => { calls++; return completion(); }, { allowLegacyWebBridge: true });
  const completed = ok(await app.request('/bridge/jobs', { questionId: id, answer: ['B'], provider: 'zhipu' }));
  ok(await app.request(`/bridge/jobs/${completed.id}/update`, { provider: 'zhipu', status: 'completed', text: '历史网页解析原文，终态必须逐项保留。' }));
  const queued = ok(await app.request('/bridge/jobs', { questionId: id, answer: ['B'], provider: 'zhipu', question: '仅存在于旧排队任务的原始追问。' }));
  assert.equal(queued.status, 'queued');
  const before = await app.savedDocuments();
  const previousJobs = JSON.parse(before['bridge-jobs.json']).jobs;
  const previousCompleted = previousJobs.find(job => job.id === completed.id);
  const previousQueued = previousJobs.find(job => job.id === queued.id);
  assert.equal(previousCompleted.status, 'completed');
  assert.equal(previousQueued.status, 'queued');

  await app.restart();
  const migrated = await app.savedDocuments();
  const migratedJobs = JSON.parse(migrated['bridge-jobs.json']).jobs;
  assert.equal(migratedJobs.length, previousJobs.length);
  assert.deepEqual(migratedJobs.find(job => job.id === completed.id), previousCompleted);
  const retired = migratedJobs.find(job => job.id === queued.id);
  assert.equal(retired.status, 'failed');
  assert.equal(retired.failureCode, 'web-retired');
  const immutablePayload = job => Object.fromEntries(Object.entries(job).filter(([key]) => !['status', 'updatedAt', 'failureCode', 'error'].includes(key)));
  assert.deepEqual(immutablePayload(retired), immutablePayload(previousQueued));
  assert.equal(migrated['learning-state.json'], before['learning-state.json']);
  assert.equal(migrated['preanalysis-state.json'], before['preanalysis-state.json']);
  assert.equal(ok(await app.request('/bridge/overview?provider=zhipu')).activeJob, null);

  const lateRetired = ok(await app.request(`/bridge/jobs/${queued.id}/update`, { provider: 'zhipu', status: 'completed', text: '禁止追写的迟到网页回复。' }));
  assert.equal(lateRetired.status, 'failed');
  assert.equal(lateRetired.failureCode, 'web-retired');
  const lateCompleted = ok(await app.request(`/bridge/jobs/${completed.id}/update`, { provider: 'zhipu', status: 'completed', text: '禁止覆盖历史完成原文。' }));
  assert.equal(lateCompleted.status, 'completed');
  assert.equal(lateCompleted.text, previousCompleted.text);
  assert.deepEqual(await app.savedDocuments(), migrated);
  assert.equal(calls, 0);
});


test('clearing retrieval credentials disables retrieval without enabling the retired generator', async t => {
  let calls = 0;
  const app = await harness(t, async () => { calls++; throw new Error('No request expected'); });
  ok(await app.request('/ai/settings', { baseUrl: 'https://api.deepseek.com/v1', apiKey: secret }, 'PUT'));
  const cleared = ok(await app.request('/ai/settings', { clearApiKey: true }, 'PUT'));
  assert.equal(cleared.configured, false);
  assert.equal((await app.request('/ai/retrieve', { questionId: id, expectedQuestionRevision: 0, requestId: 'disabled-test-request' })).status, 503);
  assert.equal((await app.request('/ai/explain', { questionId: id })).status, 410);
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(ok(await app.request('/bootstrap')).ai), new RegExp(secret));
});
