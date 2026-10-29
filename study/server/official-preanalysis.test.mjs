import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createStudyApi } from './api.mjs';
import { createPreanalysisStore } from './preanalysis.mjs';
import { writeFileSync } from 'node:fs';

const bank = [{ id: 'OFF-1', type: 'single', category: '基础', chapter: '历史兼容', difficulty: '基础', stem: '合成历史题', options: [{ id: 'A', text: '保留历史' }, { id: 'B', text: '覆盖历史' }], answer: ['A'], explanation: '原题库解释', knowledgePoint: '归档', source: '测试' }];
const analysis = '这是此前已经保存的模型讲解，仅用于确认升级之后历史缓存和原始终态仍然能够完整读取。身份校验不等于事实已经审定，不能因为读取历史记录而重新发起任何模型网络请求。旧数据只作为原始记录保留，不允许被新的检索资料覆盖。';
async function harness(t, { legacy = false, key = true, historicalStatus } = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'beikao-retired-official-'));
  const dataDir = path.join(directory, 'state');
  const questionsPath = path.join(directory, 'questions.json');
  await fs.mkdir(dataDir);
  await fs.writeFile(questionsPath, JSON.stringify(bank));
  const learning = JSON.stringify({ version: 1, progress: { 'OFF-1': { note: '原私人笔记', aiNote: '原个人解析' } }, sessions: [] });
  await fs.writeFile(path.join(dataDir, 'learning-state.json'), learning);
  await fs.writeFile(path.join(dataDir, 'official-ai-settings.json'), JSON.stringify({ version: 1, transport: 'official-api', model: 'glm-4.7-flash' }));
  if (historicalStatus) {
    const store = createPreanalysisStore({ dataDir, getQuestions: () => bank, atomicJson: (file, value) => writeFileSync(file, JSON.stringify(value)) });
    store.control('start', 1, { transport: 'official-api' });
    const batch = store.next({ transport: 'official-api' });
    const timestamp = new Date().toISOString();
    const job = { ...batch, id: 'historical-official-job', provider: 'zhipu', transport: 'official-api', model: 'glm-4.7-flash', status: 'running', createdAt: timestamp, updatedAt: timestamp, lastProgressAt: timestamp };
    store.assigned(job);
    if (historicalStatus === 'completed') {
      const text = JSON.stringify({ batchToken: batch.preanalysis.batchToken, items: batch.preanalysis.items.map(item => ({ questionId: item.questionId, fingerprint: item.fingerprint, answer: item.answer, analysis })) });
      assert.equal(store.complete(job, text).valid, true);
      job.status = 'completed'; job.text = text;
    }
    await fs.writeFile(path.join(dataDir, 'bridge-jobs.json'), JSON.stringify({ version: 1, jobs: [job] }));
  }
  let api, server, base;
  const calls = [];
  async function start() {
    api = createStudyApi({ dataDir, questionsPath, allowLegacyWebBridge: legacy, officialSettingsOptions: { env: key ? { STUDY_ZHIPU_API_KEY: 'synthetic-official-key' } : {} }, fetchImpl: async (...args) => { calls.push(args); throw new Error('Model requests are forbidden'); } });
    server = createServer(api.handle);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port + '/study-api';
  }
  async function stop() { api.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  await start();
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(directory), tmpdir());
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { dataDir, calls, learning, restart: async () => { await stop(); await start(); }, read: file => fs.readFile(path.join(dataDir, file), 'utf8'), async request(route, body) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  } };
}

for (const legacy of [false, true]) for (const key of [false, true]) {
  test('official generation start and retry are disabled regardless of compatibility flag or credentials: ' + JSON.stringify({ legacy, key }), async t => {
    const app = await harness(t, { legacy, key });
    for (const action of ['start', 'retry']) {
      const response = await app.request('/preanalysis/control', { action, batchSize: 1 });
      assert.equal(response.status, 410);
    }
    assert.equal((await app.request('/preanalysis/control', { action: 'pause' })).status, 200);
    assert.equal((await app.request('/preanalysis/status')).body.currentJobId, null);
    await app.request('/bridge/status');
    assert.deepEqual((await app.request('/bridge/pending?provider=zhipu')).body.jobs, []);
    assert.equal(app.calls.length, 0);
    assert.equal(await app.read('learning-state.json'), app.learning);
  });
}

test('historical official cache and terminal journal stay intact without replaying a request', async t => {
  const app = await harness(t, { historicalStatus: 'completed' });
  const beforeCache = await app.read('preanalysis-state.json');
  const beforeJournal = await app.read('bridge-jobs.json');
  assert.equal((await app.request('/preanalysis/questions/OFF-1')).body.text, analysis);
  assert.equal((await app.request('/preanalysis/control', { action: 'start' })).status, 410);
  await app.restart();
  assert.equal((await app.request('/preanalysis/status')).body.completed, 1);
  assert.equal(await app.read('preanalysis-state.json'), beforeCache);
  assert.equal(await app.read('bridge-jobs.json'), beforeJournal);
  assert.equal(await app.read('learning-state.json'), app.learning);
  assert.equal(app.calls.length, 0);
});

test('restoring an unfinished official job pauses it and never replays generation', async t => {
  const app = await harness(t, { legacy: true, historicalStatus: 'running' });
  const journal = JSON.parse(await app.read('bridge-jobs.json'));
  assert.equal(journal.jobs[0].status, 'failed');
  assert.equal(journal.jobs[0].failureCode, 'service-restarted');
  assert.equal((await app.request('/preanalysis/status')).body.status, 'paused');
  assert.equal((await app.request('/preanalysis/control', { action: 'retry' })).status, 410);
  await app.restart();
  assert.deepEqual(JSON.parse(await app.read('bridge-jobs.json')), journal);
  assert.equal(await app.read('learning-state.json'), app.learning);
  assert.equal(app.calls.length, 0);
});
