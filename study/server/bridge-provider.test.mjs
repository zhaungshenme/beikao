import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudyApi } from './api.mjs';

const questions = Array.from({ length: 2 }, (_, index) => ({
  id: `PROVIDER-${index + 1}`, category: '网络', chapter: '基础', type: 'single', difficulty: '基础',
  stem: `协议理论题${index + 1}`, options: [{ id: 'A', text: '正确项' }, { id: 'B', text: '干扰项' }],
  answer: ['A'], explanation: '已有题库讲解', knowledgePoint: '协议',
}));
const analysis = '本题应根据协议定义和题干限定条件判断。A项符合题目所描述的工作层次和适用范围，是正确选项；B项混淆了另一种协议的功能，不能作为本题答案。复习时应先提取限定词，再按对象、层次、作用逐项核对，不应只凭熟悉程度选择。';

async function harness(t, { initialProvider = 'zhipu', fetchImpl } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yankao-provider-'));
  const dataDir = path.join(directory, 'state');
  const questionsPath = path.join(directory, 'questions.json');
  await mkdir(dataDir);
  await writeFile(questionsPath, JSON.stringify(questions));
  const learningFile = path.join(dataDir, 'learning-state.json');
  await writeFile(learningFile, JSON.stringify({ version: 1, progress: {
    'PROVIDER-1': { attempts: 1, lastAnswer: ['B'], note: '用户自己的笔记', aiNote: '已经保存的个人解析' },
  }, sessions: [] }));
  let currentTime = Date.UTC(2026, 9, 22, 13);
  let server, base;
  async function start(activeProvider) {
    const api = createStudyApi({ allowLegacyWebBridge: true, dataDir, questionsPath, activeProvider, fetchImpl, now: () => currentTime });
    server = createServer(api.handle);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/study-api`;
  }
  async function stop() {
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
  }
  t.after(stop);
  await start(initialProvider);
  async function response(url, body, method = body === undefined ? 'GET' : 'POST') {
    const result = await fetch(base + url, { method,
      headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() };
  }
  return {
    dataDir, questionsPath, get now() { return currentTime; }, advance(amount) { currentTime += amount; },
    saved: name => readFile(path.join(dataDir, name), 'utf8'),
    restart: async activeProvider => { await stop(); await start(activeProvider); }, response,
    async request(url, body, method) { const result = await response(url, body, method); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; },
  };
}
const batchReply = job => JSON.stringify({ batchToken: job.preanalysis.batchToken, items: job.preanalysis.items.map(item => ({
  questionId: item.questionId, ...(job.replyProtocol === 'preanalysis-id-v2' ? {} : { fingerprint: item.fingerprint }), answer: item.answer, analysis,
})) });
async function dispatch(app) {
  await app.request('/preanalysis/control', { action: 'start', batchSize: 1 });
  return (await app.request('/bridge/pending?provider=zhipu')).jobs[0];
}

test('browser-ui batches cannot be dispatched, expired, reconciled or read by the userscript driver', async t => {
  const app = await harness(t);
  const settings = await app.request('/preanalysis/settings', { transport: 'web', webDriver: 'browser-ui' }, 'PUT');
  assert.equal(settings.webDriver, 'browser-ui');
  assert.equal((await app.request('/preanalysis/status')).webDriver, 'browser-ui');
  await app.request('/preanalysis/control', { action: 'start', batchSize: 2 });
  const beforeDispatch = await app.saved('preanalysis-state.json');
  for (const suffix of ['', '&driver=userscript']) {
    assert.deepEqual(await app.request('/bridge/pending?provider=zhipu' + suffix), { provider: 'zhipu', jobs: [] });
    assert.equal(await app.saved('preanalysis-state.json'), beforeDispatch);
  }
  await assert.rejects(app.saved('bridge-jobs.json'), { code: 'ENOENT' });
  assert.equal((await app.response('/bridge/pending?provider=zhipu&driver=unknown')).status, 400);
  assert.deepEqual(await app.request('/bridge/pending?provider=legacy&driver=unknown'), { provider: 'zhipu', jobs: [] }, 'provider is checked before driver');
  const job = (await app.request('/bridge/pending?provider=zhipu&driver=browser-ui')).jobs[0];
  assert.equal(job.kind, 'preanalysis');
  assert.equal(job.webDriver, 'browser-ui');
  assert.doesNotMatch(job.prompt, /我的答案|用户自己的笔记|已经保存的个人解析/);
  const journal = await app.saved('bridge-jobs.json');
  const cache = await app.saved('preanalysis-state.json');
  app.advance(120001);
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs.length, 0);
  assert.equal((await app.request('/bridge/overview')).activeJob, null);
  for (const [url, body] of [
    [`/bridge/jobs/${job.id}`, undefined],
    [`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: batchReply(job) }],
    [`/bridge/jobs/${job.id}/cancel`, {}],
  ]) {
    const rejected = await app.response(url, body);
    assert.equal(rejected.status, 409);
    assert.match(rejected.body.error, /驱动.*不一致/);
    assert.equal(rejected.body.prompt, undefined);
    assert.ok(!JSON.stringify(rejected.body).includes(job.preanalysis.batchToken));
    assert.equal(await app.saved('bridge-jobs.json'), journal);
    assert.equal(await app.saved('preanalysis-state.json'), cache);
  }
  const expired = await app.request(`/bridge/jobs/${job.id}?driver=browser-ui`);
  assert.equal(expired.failureCode, 'no-progress', 'the matching driver still observes the original deadline');
});

test('matching browser-ui updates keep strict batch identity and terminal no-overwrite behavior', async t => {
  const app = await harness(t);
  const learning = await app.saved('learning-state.json');
  await app.request('/preanalysis/settings', { webDriver: 'browser-ui' }, 'PUT');
  await app.request('/preanalysis/control', { action: 'start', batchSize: 2 });
  const job = (await app.request('/bridge/pending?provider=zhipu&driver=browser-ui')).jobs[0];
  const journal = await app.saved('bridge-jobs.json');
  assert.equal((await app.request('/bridge/pending?provider=zhipu&driver=browser-ui')).jobs[0].id, job.id, 'polling never creates a second assignment');
  assert.equal((await app.response(`/bridge/jobs/${job.id}/update?driver=browser-ui`, {
    driver: 'userscript', provider: 'zhipu', status: 'sent',
  })).status, 400);
  assert.equal((await app.response(`/bridge/jobs/${job.id}/update?driver=browser-ui&driver=browser-ui`, {
    provider: 'zhipu', status: 'sent',
  })).status, 400);
  assert.equal(await app.saved('bridge-jobs.json'), journal);
  const sent = await app.request(`/bridge/jobs/${job.id}/update`, { driver: 'browser-ui', provider: 'zhipu', status: 'sent' });
  assert.equal(sent.status, 'sent');
  const text = batchReply(job);
  const completed = await app.request(`/bridge/jobs/${job.id}/update?driver=browser-ui`, {
    provider: 'zhipu', status: 'completed', text, sequence: 1,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.text, text);
  const cache = await app.saved('preanalysis-state.json');
  const savedJournal = await app.saved('bridge-jobs.json');
  assert.equal((await app.response(`/bridge/jobs/${job.id}/update`, {
    provider: 'zhipu', status: 'completed', text: 'wrong driver late reply',
  })).status, 409);
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}/update`, {
    driver: 'browser-ui', provider: 'zhipu', status: 'completed', text: 'matching driver late reply',
  }), completed);
  assert.equal(await app.saved('bridge-jobs.json'), savedJournal);
  assert.equal(await app.saved('preanalysis-state.json'), cache);
  assert.equal(await app.saved('learning-state.json'), learning);
  await app.restart('zhipu');
  assert.equal((await app.request(`/bridge/jobs/${job.id}?driver=browser-ui`)).webDriver, 'browser-ui');
  assert.equal((await app.request('/preanalysis/settings')).webDriver, 'browser-ui');
});

test('browser-ui driver cannot bypass invalid token quarantine or change an active batch driver', async t => {
  const app = await harness(t);
  await app.request('/preanalysis/settings', { webDriver: 'browser-ui' }, 'PUT');
  await app.request('/preanalysis/control', { action: 'start', batchSize: 2 });
  const job = (await app.request('/bridge/pending?provider=zhipu&driver=browser-ui')).jobs[0];
  const settings = await app.saved('official-ai-settings.json');
  assert.equal((await app.response('/preanalysis/settings', { webDriver: 'userscript' }, 'PUT')).status, 409);
  assert.equal(await app.saved('official-ai-settings.json'), settings);
  const reply = JSON.parse(batchReply(job));
  reply.batchToken = 'wrong-token';
  const failed = await app.request(`/bridge/jobs/${job.id}/update`, {
    driver: 'browser-ui', provider: 'zhipu', status: 'completed', text: JSON.stringify(reply),
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'preanalysis-validation');
  const stored = JSON.parse(await app.saved('preanalysis-state.json'));
  assert.deepEqual(stored.cache, {});
  assert.equal(stored.quarantine.length, 1);
  assert.equal(JSON.parse(stored.quarantine[0].text).batchToken, 'wrong-token');
  assert.equal((await app.request('/preanalysis/status')).status, 'paused');
});

test('personalized work stays userscript-only while generic work selects browser-ui', async t => {
  const app = await harness(t);
  await app.request('/preanalysis/settings', { webDriver: 'browser-ui' }, 'PUT');
  assert.equal((await app.response('/bridge/jobs?driver=browser-ui', { questionId: 'PROVIDER-1' })).status, 409);
  const personal = await app.request('/bridge/jobs', { questionId: 'PROVIDER-1', answer: ['B'] });
  assert.equal(personal.kind, 'personalized');
  assert.equal(personal.webDriver, 'userscript');
  const journal = await app.saved('bridge-jobs.json');
  app.advance(120001);
  assert.equal((await app.request('/bridge/pending?provider=zhipu&driver=browser-ui')).jobs.length, 0);
  const overview = await app.request('/bridge/overview?driver=browser-ui');
  assert.equal(overview.activeJob, null);
  assert.equal(overview.latestJob, null);
  assert.equal((await app.response(`/bridge/jobs/${personal.id}?driver=browser-ui`)).status, 409);
  assert.equal(await app.saved('bridge-jobs.json'), journal, 'browser-ui does not expire personal work or expose its prompt');
  const expired = await app.request(`/bridge/jobs/${personal.id}`);
  assert.equal(expired.failureCode, 'no-progress');
  const nextPersonal = await app.request('/bridge/jobs', { questionId: 'PROVIDER-2' });
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs[0].id, nextPersonal.id);
  assert.equal((await app.request('/bridge/overview')).activeJob.id, nextPersonal.id);
});

test('legacy web journals default to userscript without rewriting and invalid drivers fail closed', async t => {
  const app = await harness(t);
  const job = await dispatch(app);
  assert.equal(job.webDriver, 'userscript');
  await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: batchReply(job) });
  const legacy = JSON.parse(await app.saved('bridge-jobs.json'));
  delete legacy.jobs[0].webDriver;
  const original = JSON.stringify(legacy);
  await writeFile(path.join(app.dataDir, 'bridge-jobs.json'), original);
  await app.restart('zhipu');
  assert.equal((await app.request(`/bridge/jobs/${job.id}`)).webDriver, 'userscript');
  assert.equal(await app.saved('bridge-jobs.json'), original);
  for (const webDriver of [null, '', 'unknown']) {
    const invalid = structuredClone(legacy);
    invalid.jobs[0].webDriver = webDriver;
    const text = JSON.stringify(invalid);
    await writeFile(path.join(app.dataDir, 'bridge-jobs.json'), text);
    assert.throws(() => createStudyApi({ allowLegacyWebBridge: true, dataDir: app.dataDir, questionsPath: app.questionsPath }), /解析任务记录损坏/);
    assert.equal(await app.saved('bridge-jobs.json'), text);
  }
});

test('legacy and wrong-provider pending polls cannot dispatch, expire or reconcile zhipu tasks', async t => {
  const app = await harness(t);
  await app.request('/preanalysis/control', { action: 'start', batchSize: 1 });
  const beforeDispatch = await app.saved('preanalysis-state.json');
  for (const suffix of ['', '?provider=legacy', '?provider=unknown']) {
    assert.deepEqual(await app.request('/bridge/pending' + suffix), { provider: 'zhipu', jobs: [] });
    assert.equal(await app.saved('preanalysis-state.json'), beforeDispatch);
  }
  const job = (await app.request('/bridge/pending?provider=zhipu')).jobs[0];
  assert.equal(job.provider, 'zhipu');
  assert.doesNotMatch(job.prompt, /我的答案|用户自己的笔记|已经保存的个人解析/);
  const journal = await app.saved('bridge-jobs.json');
  const cache = await app.saved('preanalysis-state.json');
  app.advance(120001);
  assert.equal((await app.request('/bridge/pending')).jobs.length, 0);
  assert.equal(await app.saved('bridge-jobs.json'), journal, 'wrong-provider polling must not expire another provider task');
  assert.equal(await app.saved('preanalysis-state.json'), cache);
  assert.equal((await app.response(`/bridge/jobs/${job.id}/update`, { status: 'failed', error: '旧平台错误' })).status, 409);
  assert.equal(await app.saved('bridge-jobs.json'), journal, 'wrong-provider updates must not expire another provider task either');
});

test('only matching relay and worker identities can update zhipu readiness and observed versions', async t => {
  const app = await harness(t);
  const offline = await app.request('/bridge/status');
  assert.equal(offline.activeProvider, 'zhipu');
  assert.equal(offline.provider, 'zhipu');
  assert.equal(offline.worker.provider, 'zhipu');
  const timestamp = new Date(app.now).toISOString();
  assert.deepEqual(await app.request('/bridge/heartbeat', { version: '1.4.4', worker: {
    connected: true, state: 'idle', lastSeenAt: timestamp,
  } }), offline, 'a relay without an explicit provider has no authorization');
  const matchingRelay = await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.5.0', worker: {
    connected: true, state: 'idle', lastSeenAt: timestamp,
  } });
  assert.equal(matchingRelay.connected, true);
  assert.equal(matchingRelay.worker.connected, false, 'a worker without an explicit provider is not trusted');
  const ready = await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.5.0', worker: {
    provider: 'zhipu', version: '1.5.0', connected: true, state: 'idle', lastSeenAt: timestamp,
  } });
  assert.equal(ready.worker.connected, true);
  assert.equal(ready.worker.provider, 'zhipu');
  assert.equal(ready.worker.version, '1.5.0');
  app.advance(1000);
  const mismatchedWorker = await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.5.0', worker: {
    provider: 'legacy', version: '1.4.4', connected: true, state: 'running', jobId: 'wrong-job', lastSeenAt: new Date(app.now).toISOString(),
  } });
  assert.deepEqual(mismatchedWorker.worker, ready.worker);
  assert.deepEqual(await app.request('/bridge/heartbeat', { provider: 'legacy', version: '1.4.4' }), mismatchedWorker);
});

test('zhipu updates reject missing or mismatched identities, preserve strict validation and keep user data independent', async t => {
  const app = await harness(t);
  const learning = await app.saved('learning-state.json');
  const job = await dispatch(app);
  const journal = await app.saved('bridge-jobs.json');
  for (const provider of [undefined, null, 'legacy', 'unknown']) {
    const rejected = await app.response(`/bridge/jobs/${job.id}/update`, { provider, status: 'completed', text: batchReply(job) });
    assert.equal(rejected.status, 409);
    assert.match(rejected.body.error, /平台.*不一致/);
    assert.equal(await app.saved('bridge-jobs.json'), journal);
    assert.equal((await app.request('/preanalysis/status')).completed, 0);
  }
  const completed = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: batchReply(job), sequence: 1 });
  assert.equal(completed.status, 'completed');
  const result = await app.request('/preanalysis/questions/PROVIDER-1');
  assert.equal(result.source, '智谱清言网页预解析');
  assert.equal(result.fingerprint, job.preanalysis.items[0].fingerprint);
  assert.equal(await app.saved('learning-state.json'), learning);
  const savedJournal = await app.saved('bridge-jobs.json');
  assert.equal((await app.response(`/bridge/jobs/${job.id}/update`, { status: 'completed', text: '缺少平台归属的迟到结果' })).status, 409);
  assert.equal(await app.saved('bridge-jobs.json'), savedJournal);
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '合法平台的迟到结果仍不得覆盖终态' }), completed);
  assert.equal(await app.saved('bridge-jobs.json'), savedJournal);
  assert.equal((await app.request('/preanalysis/questions/PROVIDER-1')).text, analysis);
  await app.restart('zhipu');
  assert.equal((await app.request(`/bridge/jobs/${job.id}`)).provider, 'zhipu');
  assert.equal((await app.request('/preanalysis/questions/PROVIDER-1')).source, '智谱清言网页预解析');
  assert.equal(await app.saved('learning-state.json'), learning);
});

test('retired terminal records and cache stay readable without being relabeled or gaining execution rights', async t => {
  for (const explicitProvider of [false, true]) await t.test(explicitProvider ? 'explicit retired identity' : 'missing historical identity', async t => {
    const app = await harness(t);
    const learning = await app.saved('learning-state.json');
    const oldJob = await dispatch(app);
    await app.request(`/bridge/jobs/${oldJob.id}/update`, { provider: 'zhipu', status: 'completed', text: batchReply(oldJob) });
    const oldResult = await app.request('/preanalysis/questions/PROVIDER-1');
    const cache = JSON.parse(await app.saved('preanalysis-state.json'));
    const journal = JSON.parse(await app.saved('bridge-jobs.json'));
    if (explicitProvider) {
      cache.cache['PROVIDER-1'].source = 'DeepSeek 网页预解析';
      journal.jobs[0].provider = 'deepseek';
    } else {
      delete cache.cache['PROVIDER-1'].source;
      delete journal.jobs[0].provider;
    }
    await writeFile(path.join(app.dataDir, 'preanalysis-state.json'), JSON.stringify(cache, null, 2));
    await writeFile(path.join(app.dataDir, 'bridge-jobs.json'), JSON.stringify(journal, null, 2));
    const savedCache = await app.saved('preanalysis-state.json');
    const savedJournal = await app.saved('bridge-jobs.json');
    await app.restart('zhipu');
    const restored = await app.request('/preanalysis/questions/PROVIDER-1');
    assert.deepEqual(restored, { ...oldResult, source: explicitProvider ? 'DeepSeek 网页预解析' : '来源未记录的历史通用讲解' });
    assert.equal((await app.request(`/bridge/jobs/${oldJob.id}`)).provider, 'deepseek');
    assert.equal(await app.saved('bridge-jobs.json'), savedJournal);
    for (const provider of [undefined, 'deepseek', 'zhipu']) {
      assert.equal((await app.response(`/bridge/jobs/${oldJob.id}/update`, { provider, status: 'completed', text: '历史终态不得被更新' })).status, 409);
      assert.equal(await app.saved('bridge-jobs.json'), savedJournal);
    }
    // Restart may pause the batch configuration; historical cache entries remain exact.
    assert.deepEqual(JSON.parse(await app.saved('preanalysis-state.json')).cache, JSON.parse(savedCache).cache);
    assert.equal((await app.request('/preanalysis/questions/PROVIDER-2')).source, '智谱清言网页预解析');
    app.advance(5001);
    const newJob = await dispatch(app);
    assert.equal(newJob.provider, 'zhipu');
    assert.equal(newJob.preanalysis.items[0].questionId, 'PROVIDER-2');
    await app.request(`/bridge/jobs/${newJob.id}/update`, { provider: 'zhipu', status: 'completed', text: batchReply(newJob) });
    const mixed = JSON.parse(await app.saved('preanalysis-state.json'));
    assert.deepEqual(mixed.cache['PROVIDER-1'], cache.cache['PROVIDER-1']);
    assert.equal(mixed.cache['PROVIDER-2'].source, '智谱清言网页预解析');
    assert.equal(await app.saved('learning-state.json'), learning);
  });
});

test('personalized tasks reject unknown providers and default to configured zhipu', async t => {
  const app = await harness(t);
  assert.equal((await app.response('/bridge/jobs', { questionId: 'PROVIDER-1', answer: ['B'], provider: 'legacy' })).status, 400);
  const job = await app.request('/bridge/jobs', { questionId: 'PROVIDER-1', answer: ['B'] });
  assert.equal(job.provider, 'zhipu');
  assert.equal((await app.request('/bridge/pending')).jobs.length, 0);
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs[0].id, job.id);
  await app.restart('zhipu');
  assert.equal((await app.request(`/bridge/jobs/${job.id}`)).provider, 'zhipu');
  assert.equal((await app.request('/bridge/pending?provider=legacy')).jobs.length, 0);
});

test('active journals with missing, null or unknown providers fail closed without rewriting files', async t => {
  const app = await harness(t);
  await app.request('/bridge/jobs', { questionId: 'PROVIDER-1' });
  const learning = await app.saved('learning-state.json');
  const original = JSON.parse(await app.saved('bridge-jobs.json'));
  for (const provider of [undefined, null, 'unregistered-site']) {
    const journal = structuredClone(original);
    if (provider === undefined) delete journal.jobs[0].provider;
    else journal.jobs[0].provider = provider;
    const text = JSON.stringify(journal);
    await writeFile(path.join(app.dataDir, 'bridge-jobs.json'), text);
    assert.throws(() => createStudyApi({ allowLegacyWebBridge: true, dataDir: app.dataDir, questionsPath: app.questionsPath, activeProvider: 'zhipu' }), /解析任务记录损坏.*未覆盖原文件/);
    assert.equal(await app.saved('bridge-jobs.json'), text);
    assert.equal(await app.saved('learning-state.json'), learning);
  }
});

test('terminal journals still reject null or unknown provider identities without rewriting files', async t => {
  const app = await harness(t);
  const job = await dispatch(app);
  await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: batchReply(job) });
  const learning = await app.saved('learning-state.json');
  const cache = await app.saved('preanalysis-state.json');
  const original = JSON.parse(await app.saved('bridge-jobs.json'));
  for (const provider of [null, 'unregistered-site']) {
    const journal = structuredClone(original);
    journal.jobs[0].provider = provider;
    const text = JSON.stringify(journal);
    await writeFile(path.join(app.dataDir, 'bridge-jobs.json'), text);
    assert.throws(() => createStudyApi({ allowLegacyWebBridge: true, dataDir: app.dataDir, questionsPath: app.questionsPath, activeProvider: 'zhipu' }), /解析任务记录损坏.*未覆盖原文件/);
    assert.equal(await app.saved('bridge-jobs.json'), text);
    assert.equal(await app.saved('preanalysis-state.json'), cache);
    assert.equal(await app.saved('learning-state.json'), learning);
  }
});

test('retired, null or unknown active-provider configurations cannot load or rewrite any persisted data', async t => {
  const app = await harness(t);
  const job = await dispatch(app);
  await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: batchReply(job) });
  const files = ['learning-state.json', 'bridge-jobs.json', 'preanalysis-state.json'];
  const before = await Promise.all(files.map(file => app.saved(file)));
  for (const activeProvider of ['deepseek', null, 'unregistered-site']) {
    assert.throws(() => createStudyApi({ allowLegacyWebBridge: true, dataDir: app.dataDir, questionsPath: app.questionsPath, activeProvider }), /仅支持智谱清言/);
    assert.deepEqual(await Promise.all(files.map(file => app.saved(file))), before);
  }
});

test('public web configuration is fixed to zhipu while saved optional API configuration stays intact', async t => {
  const app = await harness(t);
  const initial = (await app.request('/bootstrap')).ai;
  assert.equal(initial.webProvider, 'zhipu');
  assert.equal(initial.webUrl, 'https://chatglm.cn/main/alltoolsdetail?lang=zh');
  assert.equal(initial.baseUrl, '');
  assert.equal(initial.model, '');
  const legacyConfig = JSON.stringify({ webUrl: 'https://retired.example.invalid', baseUrl: 'https://example.invalid/v1', model: 'saved-api-model', apiKey: 'saved-test-key' });
  await writeFile(path.join(app.dataDir, 'ai-settings.json'), legacyConfig);
  await app.restart('zhipu');
  const migrated = (await app.request('/bootstrap')).ai;
  assert.equal(migrated.webUrl, initial.webUrl);
  assert.equal(migrated.baseUrl, 'https://example.invalid/v1');
  assert.equal(migrated.model, '');
  assert.equal(migrated.configured, false);
  assert.equal(migrated.apiKey, undefined);
  assert.equal(await app.saved('ai-settings.json'), legacyConfig, 'reading a migrated profile must not rewrite API settings');
});

test('retired generation stays disabled for complete, incomplete and legacy provider configurations', async t => {
  let calls = 0;
  const app = await harness(t, { fetchImpl: async () => { calls++; throw new Error('No provider request'); } });
  const learning = await app.saved('learning-state.json');
  for (const settings of [{}, { apiKey: 'test-key' }, { baseUrl: 'https://example.invalid/v1', model: 'custom-model', apiKey: 'test-key' }, { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'official-test-key' }]) {
    const text = JSON.stringify(settings);
    await writeFile(path.join(app.dataDir, 'ai-settings.json'), text);
    await app.restart('zhipu');
    const result = await app.response('/ai/explain', { questionId: 'PROVIDER-1', answer: ['B'] });
    assert.equal(result.status, 410);
    assert.equal(result.body.modelRequested, false);
    assert.equal(await app.saved('ai-settings.json'), text);
    assert.equal(await app.saved('learning-state.json'), learning);
  }
  assert.equal(calls, 0);
});

test('selecting a web provider preserves optional API credentials and survives restart without trusting custom web URLs', async t => {
  let calls = 0;
  const app = await harness(t, { fetchImpl: async () => { calls++; throw new Error('must not request a provider'); } });
  await app.request('/ai/settings', { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'mock-secret-provider-settings' }, 'PUT');
  const before = JSON.parse(await app.saved('ai-settings.json'));
  const selected = await app.request('/ai/settings', { webProvider: 'deepseek' }, 'PUT');
  assert.equal(selected.webProvider, 'deepseek');
  assert.equal(selected.webUrl, 'https://chat.deepseek.com/');
  assert.equal(selected.apiKey, undefined);
  const stored = JSON.parse(await app.saved('ai-settings.json'));
  for (const key of ['baseUrl', 'model', 'apiKey']) assert.equal(stored[key], before[key]);
  assert.equal(calls, 0);
  const unchanged = await app.saved('ai-settings.json');
  for (const webProvider of ['', null, 'other', {}, []]) {
    assert.equal((await app.response('/ai/settings', { webProvider }, 'PUT')).status, 400);
    assert.equal(await app.saved('ai-settings.json'), unchanged);
  }
  await app.restart('zhipu');
  assert.equal((await app.request('/bootstrap')).ai.webProvider, 'deepseek');
  assert.equal((await app.request('/bridge/status')).provider, 'deepseek');
  assert.equal((await app.request('/bridge/status?provider=zhipu')).provider, 'zhipu');
  assert.equal((await app.request('/preanalysis/questions/PROVIDER-2')).source, '智谱清言网页预解析');
  const job = await app.request('/bridge/jobs', { questionId: 'PROVIDER-1' });
  assert.equal(job.provider, 'deepseek');
});

test('Zhipu and DeepSeek relay, worker versions and expiry remain isolated', async t => {
  const app = await harness(t);
  const heartbeat = (provider, version) => app.request('/bridge/heartbeat', { provider, version, worker: {
    provider, version, connected: true, state: 'idle', lastSeenAt: new Date(app.now).toISOString(),
  } });
  assert.deepEqual((await app.request('/bridge/status')).availableProviders, ['zhipu', 'deepseek']);
  const zhipu = await heartbeat('zhipu', 'z-test');
  assert.equal((await app.request('/bridge/status?provider=deepseek')).connected, false);
  const deepseek = await heartbeat('deepseek', 'd-test');
  assert.equal(deepseek.worker.version, 'd-test');
  assert.deepEqual(await app.request('/bridge/status?provider=zhipu'), zhipu);
  const wrongWorker = await app.request('/bridge/heartbeat', { provider: 'deepseek', version: 'd-next', worker: {
    provider: 'zhipu', version: 'crossed', connected: true, state: 'running', lastSeenAt: new Date(app.now).toISOString(),
  } });
  assert.deepEqual(wrongWorker.worker, deepseek.worker);
  app.advance(15001);
  await heartbeat('zhipu', 'z-next');
  assert.equal((await app.request('/bridge/status?provider=zhipu')).worker.connected, true);
  const expired = await app.request('/bridge/status?provider=deepseek');
  assert.equal(expired.connected, false);
  assert.equal(expired.worker.connected, false);
  assert.equal(expired.worker.version, 'd-test');
  for (const route of ['/bridge/status?provider=other', '/bridge/status?provider=zhipu&provider=deepseek', '/bridge/overview?provider=']) {
    assert.equal((await app.response(route)).status, 400);
  }
});

test('DeepSeek personal jobs have fixed routing, global backpressure and provider-bound request identity', async t => {
  const app = await harness(t);
  const payload = { questionId: 'PROVIDER-1', provider: 'deepseek', requestId: 'deepseek-routing-001', answer: ['B'] };
  const job = await app.request('/bridge/jobs', payload);
  assert.equal(job.provider, 'deepseek');
  assert.equal((await app.request('/bridge/pending?provider=deepseek')).jobs[0].id, job.id);
  assert.deepEqual(await app.request('/bridge/pending?provider=zhipu'), { provider: 'zhipu', jobs: [] });
  assert.equal((await app.request('/bridge/overview?provider=zhipu')).activeJob, null);
  assert.equal((await app.request('/bridge/overview?provider=deepseek')).activeJob.id, job.id);
  const journal = await app.saved('bridge-jobs.json');
  for (const [url, body] of [
    [`/bridge/jobs/${job.id}?provider=zhipu`, undefined],
    [`/bridge/jobs/${job.id}/cancel`, { provider: 'zhipu' }],
    [`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: 'crossed response' }],
  ]) {
    assert.equal((await app.response(url, body)).status, 409);
    assert.equal(await app.saved('bridge-jobs.json'), journal);
  }
  const busy = await app.response('/bridge/jobs', { questionId: 'PROVIDER-2', provider: 'zhipu' });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /DeepSeek/);
  assert.equal(busy.body.id, undefined, 'busy does not adopt a different provider task');
  assert.equal((await app.request('/bridge/jobs', payload)).id, job.id);
  assert.equal((await app.response('/bridge/jobs', { ...payload, provider: 'zhipu' })).status, 409);
  await app.request('/ai/settings', { baseUrl: 'https://api.deepseek.com/v1', webProvider: 'zhipu' }, 'PUT');
  assert.equal((await app.request(`/bridge/jobs/${job.id}`)).provider, 'deepseek');
  await app.restart('zhipu');
  assert.equal((await app.request('/bridge/pending?provider=deepseek')).jobs[0].id, job.id);
  assert.equal((await app.request('/bridge/jobs', payload)).id, job.id);
  const completed = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'deepseek', status: 'completed', text: 'DeepSeek完整解析' });
  assert.equal(completed.status, 'completed');
  assert.equal((await app.request('/bootstrap')).progress['PROVIDER-1'].aiNote, 'DeepSeek完整解析');
  assert.equal((await app.response('/bridge/jobs', { ...payload, provider: 'zhipu' })).status, 409, 'terminal request IDs still bind their provider');
});

test('DeepSeek cannot dispatch, expire, reconcile or heartbeat a Zhipu batch', async t => {
  const app = await harness(t);
  const job = await dispatch(app);
  const journal = await app.saved('bridge-jobs.json');
  const prepared = await app.saved('preanalysis-state.json');
  app.advance(120001);
  assert.deepEqual(await app.request('/bridge/pending?provider=deepseek'), { provider: 'deepseek', jobs: [] });
  assert.equal((await app.request('/bridge/overview?provider=deepseek')).activeJob, null);
  assert.equal((await app.response('/bridge/heartbeat', { provider: 'deepseek', worker: {
    provider: 'deepseek', jobId: job.id, connected: true, state: 'running', lastSeenAt: new Date(app.now).toISOString(),
  } })).status, 409);
  assert.equal((await app.request('/bridge/status?provider=deepseek')).connected, false);
  assert.equal(await app.saved('bridge-jobs.json'), journal);
  assert.equal(await app.saved('preanalysis-state.json'), prepared);
});

test('DeepSeek retains driver, sequence, cancellation and personal-note conflict guards', async t => {
  const app = await harness(t);
  const job = await app.request('/bridge/jobs', { questionId: 'PROVIDER-1', provider: 'deepseek' });
  const before = await app.saved('learning-state.json');
  assert.equal((await app.response(`/bridge/jobs/${job.id}/update`, { provider: 'deepseek', driver: 'browser-ui', status: 'sent' })).status, 409);
  assert.equal((await app.response(`/bridge/jobs/${job.id}/update`, { provider: 'deepseek', replyProtocol: 'preanalysis-id-v2', status: 'sent' })).status, 409);
  const streaming = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'deepseek', status: 'streaming', text: 'newest draft', sequence: 2 });
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'deepseek', status: 'completed', text: 'stale final', sequence: 1 }), streaming);
  assert.equal(await app.saved('learning-state.json'), before);
  await app.request('/questions/PROVIDER-1', { aiNote: '期间保存的新解析', expected: { aiNote: '已经保存的个人解析' } }, 'PATCH');
  const conflict = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'deepseek', status: 'completed', text: '较早任务生成的完整解析', sequence: 3 });
  assert.equal(conflict.failureCode, 'save-conflict');
  assert.equal((await app.request('/bootstrap')).progress['PROVIDER-1'].aiNote, '期间保存的新解析');
  const next = await app.request('/bridge/jobs', { questionId: 'PROVIDER-1', provider: 'deepseek' });
  const cancelled = await app.request(`/bridge/jobs/${next.id}/cancel`, {});
  assert.equal(cancelled.failureCode, 'cancelled');
  assert.deepEqual(await app.request(`/bridge/jobs/${next.id}/update`, { provider: 'deepseek', status: 'completed', text: 'late result', sequence: 4 }), cancelled);
});

test('legacy personalized request fingerprints recover only under their fixed provider without rewriting the journal', async t => {
  const app = await harness(t);
  const payload = { questionId: 'PROVIDER-1', answer: ['B'], question: '原请求追问', provider: 'zhipu', requestId: 'legacy-personal-request' };
  const job = await app.request('/bridge/jobs', payload);
  const journal = JSON.parse(await app.saved('bridge-jobs.json'));
  journal.jobs[0].requestFingerprint = createHash('sha256').update(JSON.stringify([payload.questionId, payload.answer, payload.question])).digest('hex');
  const oldText = JSON.stringify(journal);
  await writeFile(path.join(app.dataDir, 'bridge-jobs.json'), oldText);
  await app.restart('zhipu');
  assert.equal((await app.request('/bridge/jobs', payload)).id, job.id);
  assert.equal((await app.response('/bridge/jobs', { ...payload, provider: 'deepseek' })).status, 409);
  assert.equal(await app.saved('bridge-jobs.json'), oldText);
});

test('DeepSeek completion under a superseded standard is quarantined to history after restart', async t => {
  const app = await harness(t);
  const job = await app.request('/bridge/jobs', { questionId: 'PROVIDER-1', provider: 'deepseek' });
  await app.request('/questions/PROVIDER-1/answer', { expectedRevision: 0, answer: ['B'], explanation: '测试用新标准依据', note: '测试纠正' }, 'PUT');
  await app.restart('zhipu');
  const completed = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'deepseek', status: 'completed', text: '基于旧标准的完整候选', sequence: 1 });
  assert.equal(completed.failureCode, 'answer-standard-conflict');
  assert.equal((await app.request('/bootstrap')).progress['PROVIDER-1'].aiNote, '已经保存的个人解析');
  const history = await app.request('/questions/PROVIDER-1/history');
  assert.equal(history.entries.find(entry => entry.id === completed.historyId).source, 'answer-standard-conflict');
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'deepseek', status: 'completed', text: 'late rewrite', sequence: 2 }), completed);
});

test('saved generic explanations enter personal prompts only as independently unverified references', async t => {
  const app = await harness(t);
  const batch = await dispatch(app);
  await app.request(`/bridge/jobs/${batch.id}/update`, { provider: 'zhipu', status: 'completed', text: batchReply(batch) });
  const job = await app.request('/bridge/jobs', { questionId: batch.questionId, provider: 'deepseek', answer: ['B'] });
  assert.match(job.prompt, /已保存的通用讲解/);
  assert.match(job.prompt, /待独立核验的参考/);
  assert.match(job.prompt, /不等于事实审定/);
  assert.match(job.prompt, /不要盲从原稿/);
});

test('invalid rendered revisions reject legacy web work while generation returns a fixed retirement response', async t => {
  let calls = 0;
  const app = await harness(t, { fetchImpl: async () => { calls++; throw new Error('No model work'); } });
  const learning = await app.saved('learning-state.json');
  for (const expectedQuestionRevision of [-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1, 1]) {
    for (const provider of ['zhipu', 'deepseek']) {
      const result = await app.response('/bridge/jobs', { questionId: 'PROVIDER-1', provider, expectedQuestionRevision });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'QUESTION_UPDATED');
      assert.equal(result.body.current.answerRevision, 0);
    }
    const result = await app.response('/ai/explain', { questionId: 'PROVIDER-1', expectedQuestionRevision });
    assert.equal(result.status, 410);
    assert.equal(result.body.modelRequested, false);
  }
  assert.equal(calls, 0);
  await assert.rejects(app.saved('bridge-jobs.json'), { code: 'ENOENT' });
  assert.equal(await app.saved('learning-state.json'), learning);
});

test('a stale legacy web request cannot preempt a batch and retired API requests cannot generate at any revision', async t => {
  let calls = 0;
  const app = await harness(t, { fetchImpl: async () => { calls++; throw new Error('Generation forbidden'); } });
  const batch = await dispatch(app);
  await app.request('/questions/PROVIDER-1/answer', { expectedRevision: 0, answer: ['B'], explanation: '修订后的标准依据', note: '测试纠正' }, 'PUT');
  const files = ['bridge-jobs.json', 'preanalysis-state.json', 'learning-state.json'];
  const before = await Promise.all(files.map(file => app.saved(file)));
  for (const provider of ['zhipu', 'deepseek']) {
    const rejected = await app.response('/bridge/jobs', { questionId: 'PROVIDER-1', provider, expectedQuestionRevision: 0 });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.current.answerRevision, 1);
  }
  for (const expectedQuestionRevision of [0, 1]) assert.equal((await app.response('/ai/explain', { questionId: 'PROVIDER-1', expectedQuestionRevision })).status, 410);
  assert.deepEqual(await Promise.all(files.map(file => app.saved(file))), before);
  assert.equal(calls, 0);
  const current = await app.request('/bridge/jobs', { questionId: 'PROVIDER-1', provider: 'deepseek', answer: ['A'], expectedQuestionRevision: 1 });
  assert.equal(current.questionRevision, 1);
  assert.match(current.prompt, /题库标准答案：B/);
  assert.equal((await app.request(`/bridge/jobs/${batch.id}`)).failureCode, 'preempted');
});

