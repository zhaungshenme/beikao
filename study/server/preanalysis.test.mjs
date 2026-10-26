import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudyApi } from './api.mjs';

const bank = Array.from({ length: 4 }, (_, index) => ({ id: `PRE-${index + 1}`, type: 'single', category: '网络', chapter: '基础', difficulty: '基础',
  stem: `理论题目${index + 1}`, options: [{ id: 'A', text: '正确项' }, { id: 'B', text: '干扰项' }], answer: ['A'], explanation: '原始题库讲解', knowledgePoint: '协议', source: '测试' }));
const analysis = '本题需要根据协议定义确认正确选项。A项符合题干限定条件，可以由协议的适用范围和工作方式验证。B项混淆了相关概念，不满足本题条件。复习时先提取题干限定词，再比较每个选项对应的对象、层次和目的，避免仅凭熟悉程度作答。';
async function harness(t, count = 4) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yankao-preanalysis-'));
  const dataDir = path.join(directory, 'state');
  const questionsPath = path.join(directory, 'questions.json');
  await mkdir(dataDir);
  await writeFile(questionsPath, JSON.stringify(bank.slice(0, count)));
  // A real pre-existing profile makes byte-preservation meaningful.
  await writeFile(path.join(dataDir, 'learning-state.json'), JSON.stringify({ version: 1, progress: { 'PRE-1': { attempts: 2, lastAnswer: ['B'], note: '自己的笔记', aiNote: '原先的个性化解析' } }, sessions: [] }));
  let server, base, currentTime = Date.UTC(2026, 9, 22);
  async function start() {
    const api = createStudyApi({ allowLegacyWebBridge: true, dataDir, questionsPath, now: () => currentTime });
    server = createServer(api.handle);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/study-api`;
  }
  async function stop() { if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }); }
  t.after(stop);
  await start();
  return { dataDir, questionsPath, advance: amount => { currentTime += amount; }, restart: async () => { await stop(); await start(); },
    saved: () => readFile(path.join(dataDir, 'learning-state.json'), 'utf8'),
    async request(url, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    },
  };
}
const reply = job => ({ batchToken: job.preanalysis.batchToken, items: job.preanalysis.items.map(item => ({ questionId: item.questionId, fingerprint: item.fingerprint, answer: item.answer, analysis })) });
async function dispatch(app, batchSize = 3) {
  await app.request('/preanalysis/control', { action: 'start', batchSize });
  return (await app.request('/bridge/pending?provider=zhipu')).jobs[0];
}
const finish = (app, job, value = reply(job)) => app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: typeof value === 'string' ? value : JSON.stringify(value) });
const correct = app => app.request('/questions/PRE-1/answer', { answer: ['B'], explanation: '经核验的新标准', note: '修订', expectedRevision: 0 }, 'PUT');

test('web batch prompt keeps each real token and fingerprint once in the final output skeleton after complete question data', async t => {
  const app = await harness(t);
  const learning = await app.saved();
  const job = await dispatch(app, 4);
  const dataMarker = '题目数据：\n';
  const outputMarker = '输出格式：\n';
  const dataStart = job.prompt.indexOf(dataMarker) + dataMarker.length;
  const dataEnd = job.prompt.indexOf('\n', dataStart);
  const outputStart = job.prompt.indexOf(outputMarker);
  assert.ok(dataStart >= dataMarker.length && dataEnd > dataStart && outputStart > dataEnd);
  const data = JSON.parse(job.prompt.slice(dataStart, dataEnd));
  assert.deepEqual(data, bank.map(item => ({ questionId: item.id, type: item.type, category: item.category,
    knowledgePoint: item.knowledgePoint, stem: item.stem, options: item.options,
    referenceAnswer: item.answer, referenceExplanation: item.explanation })));
  assert.ok(data.every(item => !Object.hasOwn(item, 'fingerprint')));
  const fencedSkeleton = job.prompt.slice(outputStart + outputMarker.length);
  assert.ok(fencedSkeleton.startsWith('```json\n'));
  assert.ok(fencedSkeleton.endsWith('\n```'), 'the output skeleton is the last prompt content');
  const skeleton = JSON.parse(fencedSkeleton.slice('```json\n'.length, -'\n```'.length));
  assert.deepEqual(skeleton, { batchToken: job.preanalysis.batchToken,
    items: job.preanalysis.items.map(item => ({ questionId: item.questionId, fingerprint: item.fingerprint, answer: [], analysis: '' })) });
  for (const identity of [job.preanalysis.batchToken, ...job.preanalysis.items.map(item => item.fingerprint)]) {
    assert.equal(job.prompt.split(identity).length - 1, 1, 'each complete identity has one copy close to the output');
  }
  assert.ok(job.preanalysis.items.every(item => /^[a-f0-9]{64}$/.test(item.fingerprint)));
  assert.match(job.prompt.slice(dataEnd, outputStart), /64 位 fingerprint 仅作机械复制，不得重算、删字符/);
  assert.match(job.prompt, /每题独立核验答案/);
  assert.match(job.prompt, /按选项原顺序逐项书写，每项格式为“选项号（正确\/错误）：一个必要直接依据”/);
  assert.match(job.prompt, /必要适用条件融入对应项/);
  assert.match(job.prompt, /analysis 只含这些项，不写总论、小结、示例、代码、口诀、防御扩展、修复建议或无关属性比较/);
  assert.match(job.prompt, /每个事实句必须对应原选项判定所需的必要前提；不能对应就删去/);
  assert.match(job.prompt, /按适用标准、版本、对象状态和具体操作核验其保证、条件与不确定性/);
  assert.match(job.prompt, /只对已确定的语义作断言，不用可能的运行表现判定行为性质，不从局部结论推出更强的通用规则、充分条件或安全保证/);
  assert.match(job.prompt, /80—160 字仅为篇幅预计，不是配额，不凑字且不得超过 400 字/);
  assert.match(job.prompt, /80 字符下限，不足时只补完整已有选项的直接依据，不引入题外事实/);
  assert.match(job.prompt, /通用讲解不使用个人作答、笔记或学习记录/);
  assert.match(job.prompt, /answer 填你独立核验的答案并在 analysis 对应项明确说明，系统会隔离待核验，绝不自动更改标准/);
  assert.doesNotMatch(job.prompt, /180—300|300—500|600 字|默认约 350 字|SQL 自身定义|未定义行为|malloc|calloc|Python 可哈希性/);
  assert.doesNotMatch(job.prompt, /我的答案|lastAnswer|自己的笔记|原先的个性化解析|SYS0?53|SYS0?60|SYS0?61|COUNT\(\*\).*NULL|NOT DEFERRABLE/);
  assert.equal(await app.saved(), learning);
});

test('public status updates retired-platform retry guidance without rewriting saved failure evidence', async t => {
  const app = await harness(t, 1);
  const learning = await app.saved();
  const job = await dispatch(app, 1);
  await finish(app, job, '历史不完整正文');
  const file = path.join(app.dataDir, 'preanalysis-state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  const oldMessage = '本轮已隔离，未写入题目讲解：回复任务编号不匹配。请检查 DeepSeek 回复后重试。';
  state.message = oldMessage;
  state.failures['PRE-1'].message = oldMessage;
  state.quarantine[0].message = oldMessage;
  const evidence = JSON.stringify(state, null, 2);
  await writeFile(file, evidence);
  await app.restart();
  const status = await app.request('/preanalysis/status');
  assert.equal(status.status, 'paused');
  assert.equal(status.failed, 1);
  assert.match(status.message, /回复任务编号不匹配/);
  assert.match(status.message, /请检查原轮次证据；当前使用智谱清言重试/);
  assert.doesNotMatch(status.message, /DeepSeek/);
  assert.equal(await readFile(file, 'utf8'), evidence);
  assert.equal(await app.saved(), learning);
});

test('batch cache is independent, maps reversed replies by ID, never reads user answers or writes learning progress', async t => {
  const app = await harness(t);
  const before = await app.saved();
  const job = await dispatch(app);
  assert.equal(job.kind, 'preanalysis');
  assert.equal(job.preanalysis.items.length, 3);
  assert.ok(!job.prompt.includes('我的答案') && !job.prompt.includes('lastAnswer') && !job.prompt.includes('自己的笔记') && !job.prompt.includes('原先的个性化解析'));
  assert.deepEqual((await app.request('/bridge/overview')).activeJob, null);
  const result = reply(job); result.items.reverse();
  result.items[0].analysis += '这是第三题的独立尾注。';
  assert.equal((await finish(app, job, result)).status, 'completed');
  assert.equal((await app.request('/preanalysis/questions/PRE-1')).state, 'ready');
  assert.match((await app.request('/preanalysis/questions/PRE-3')).text, /第三题的独立尾注/);
  assert.equal(await app.saved(), before);
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs.length, 0, 'next conversation waits for cooldown');
  app.advance(5001);
  const next = (await app.request('/bridge/pending?provider=zhipu')).jobs[0];
  assert.deepEqual(next.preanalysis.items.map(item => item.questionId), ['PRE-4']);
  assert.notEqual(next.preanalysis.batchToken, job.preanalysis.batchToken);
  assert.equal(await app.saved(), before);
});

test('fenced JSON transport preserves literal analysis symbols without changing question identity or learning records', async t => {
  const app = await harness(t, 1);
  const before = await app.saved();
  const job = await dispatch(app, 1);
  assert.match(job.prompt, /只输出一个标记为 json 的 Markdown 围栏代码块/);
  assert.match(job.prompt, /```json\n/);
  assert.match(job.prompt, /代码块外不得附加任何文字、链接、引用编号/);
  assert.match(job.prompt, /不要插入搜索引用标记/);
  assert.doesNotMatch(job.prompt, /不要使用 Markdown 代码块/);
  const value = reply(job);
  value.items[0].analysis += '\nCOUNT(*) 与 row_level_security 保持原样；双引号："quoted"；反斜杠：C:\\logs\\data；反引号：`SELECT`；符号：* _ < > &。';
  const expected = value.items[0].analysis;
  const result = await finish(app, job, '```json\n' + JSON.stringify(value, null, 2) + '\n```');
  assert.equal(result.status, 'completed');
  const saved = await app.request('/preanalysis/questions/PRE-1');
  assert.equal(saved.state, 'ready');
  assert.equal(saved.fingerprint, job.preanalysis.items[0].fingerprint);
  assert.equal(saved.text, expected);
  assert.equal(await app.saved(), before);
  await app.restart();
  assert.equal((await app.request('/preanalysis/questions/PRE-1')).text, expected);
});

for (const [name, contaminate] of [
  ['citation before the code block', raw => '[17]\n```json\n' + raw + '\n```'],
  ['citation after the code block', raw => '```json\n' + raw + '\n```\n[17]'],
  ['non-JSON citation inside the code block', (raw, value) => '```json\n' + raw.replace(JSON.stringify(value.items[0].analysis), JSON.stringify(value.items[0].analysis) + '-\n17') + '\n```'],
]) test(`fenced transport rejects ${name} without repairing or partially saving the batch`, async t => {
  const app = await harness(t);
  const before = await app.saved();
  const job = await dispatch(app);
  const value = reply(job);
  const text = contaminate(JSON.stringify(value), value);
  const result = await finish(app, job, text);
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'preanalysis-validation');
  const status = await app.request('/preanalysis/status');
  assert.equal(status.status, 'paused');
  assert.equal(status.completed, 0);
  assert.equal(status.failed, job.preanalysis.items.length);
  const stored = JSON.parse(await readFile(path.join(app.dataDir, 'preanalysis-state.json'), 'utf8'));
  assert.deepEqual(stored.cache, {});
  assert.equal(stored.quarantine.length, 1);
  assert.equal(stored.quarantine[0].text, text);
  assert.equal(await app.saved(), before);
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs.length, 0);
});

for (const [name, alter] of [
  ['wrong batch token', value => { value.batchToken = 'another-task'; }],
  ['swapped fingerprints', value => { value.items[0].fingerprint = value.items[1].fingerprint; }],
  ['duplicate question ID', value => { value.items[1].questionId = value.items[0].questionId; }],
  ['unknown question ID', value => { value.items[0].questionId = 'PRE-UNKNOWN'; }],
  ['missing question', value => { value.items.pop(); }],
  ['answer disagreement', value => { value.items[0].answer = ['B']; }],
  ['too short analysis', value => { value.items[0].analysis = '短'; }],
]) test(`batch rejects ${name} atomically and quarantines without assigning any reply`, async t => {
  const app = await harness(t);
  const before = await app.saved();
  const job = await dispatch(app);
  const value = reply(job); alter(value);
  const result = await finish(app, job, value);
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'preanalysis-validation');
  const status = await app.request('/preanalysis/status');
  assert.equal(status.status, 'paused'); assert.equal(status.completed, 0); assert.equal(status.failed, 3);
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs.length, 0);
  const stored = JSON.parse(await readFile(path.join(app.dataDir, 'preanalysis-state.json'), 'utf8'));
  assert.equal(stored.quarantine.length, 1); assert.equal(Object.keys(stored.cache).length, 0);
  assert.equal(await app.saved(), before);
  await app.restart();
  assert.equal((await app.request('/preanalysis/status')).failed, 3);
  await app.request('/preanalysis/control', { action: 'retry' });
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs[0].preanalysis.items[0].questionId, 'PRE-1');
});

test('foreground click preempts background, ignores its late completion and resumes uncompleted questions', async t => {
  const app = await harness(t);
  const background = await dispatch(app);
  const personal = await app.request('/bridge/jobs', { questionId: 'PRE-4', answer: ['B'] });
  assert.equal(personal.kind, 'personalized'); assert.deepEqual(personal.userAnswer, ['B']);
  assert.equal((await app.request('/bridge/overview')).activeJob.id, personal.id);
  assert.equal((await finish(app, background)).failureCode, 'preempted');
  assert.equal((await app.request('/preanalysis/status')).completed, 0);
  await app.request(`/bridge/jobs/${personal.id}/update`, { provider: 'zhipu', status: 'completed', text: '用户点击后的个性化解析' });
  const resumed = (await app.request('/bridge/pending?provider=zhipu')).jobs[0];
  assert.equal(resumed.kind, 'preanalysis'); assert.equal(resumed.preanalysis.items[0].questionId, 'PRE-1');
  assert.notEqual(resumed.preanalysis.batchToken, background.preanalysis.batchToken);
});

test('pause and service restart preserve cache, cancel incomplete batches and require explicit resume', async t => {
  const app = await harness(t);
  const first = await dispatch(app, 2);
  await finish(app, first);
  app.advance(5001);
  const active = (await app.request('/bridge/pending?provider=zhipu')).jobs[0];
  await app.request(`/bridge/jobs/${active.id}/update`, { provider: 'zhipu', status: 'streaming', text: '未完成JSON' });
  const before = await app.saved();
  await app.restart();
  assert.equal((await app.request('/preanalysis/status')).status, 'paused');
  assert.equal((await app.request('/preanalysis/status')).completed, 2);
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs.length, 0);
  assert.equal((await finish(app, active)).failureCode, 'service-restarted');
  assert.equal(await app.saved(), before);
  const resumed = await dispatch(app, 2);
  assert.deepEqual(resumed.preanalysis.items.map(item => item.questionId), ['PRE-3', 'PRE-4']);
  await app.request('/preanalysis/control', { action: 'pause' });
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs.length, 0);
  assert.equal((await finish(app, resumed)).failureCode, 'batch-paused');
  assert.equal((await app.request('/preanalysis/status')).completed, 2);
});

test('login failure and timeout stop the batch with no automatic retry loop', async t => {
  const app = await harness(t);
  const first = await dispatch(app);
  await app.request(`/bridge/jobs/${first.id}/update`, { provider: 'zhipu', status: 'failed', error: '请先登录 智谱清言', failureCode: 'login-required' });
  for (let iteration = 0; iteration < 3; iteration++) { app.advance(10000); assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs.length, 0); }
  await app.request('/preanalysis/control', { action: 'retry' });
  const second = (await app.request('/bridge/pending?provider=zhipu')).jobs[0];
  app.advance(240001);
  assert.equal((await app.request(`/bridge/jobs/${second.id}`)).status, 'failed');
  assert.equal((await app.request('/preanalysis/status')).status, 'paused');
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs.length, 0);
});

test('standard changes during generation quarantine late replies; completed-cache changes are resumable and never shown stale', async t => {
  const app = await harness(t, 1);
  const first = await dispatch(app, 1);
  await finish(app, first);
  assert.equal((await app.request('/preanalysis/status')).status, 'completed');
  const initial = await app.request('/preanalysis/questions/PRE-1');
  assert.equal(initial.state, 'ready');
  assert.equal(initial.questionRevision, 0);
  assert.equal(initial.contentVersion, JSON.stringify([bank[0].id, bank[0].type, bank[0].stem, bank[0].options.map(option => [option.id, option.text]), bank[0].answer, bank[0].explanation, 0]));
  await correct(app);
  const changed = await app.request('/preanalysis/status');
  assert.equal(changed.status, 'paused'); assert.equal(changed.completed, 0); assert.equal(changed.stale, 1);
  const stale = await app.request('/preanalysis/questions/PRE-1'); assert.equal(stale.state, 'stale'); assert.equal(stale.text, '');
  assert.equal(stale.questionRevision, 1);
  assert.notEqual(stale.contentVersion, initial.contentVersion);
  assert.notEqual(stale.fingerprint, initial.fingerprint);
  assert.deepEqual(JSON.parse(stale.contentVersion).slice(-3), [['B'], '经核验的新标准', 1]);
  await app.restart();
  app.advance(5001);
  const next = await dispatch(app, 1);
  assert.notEqual(next.preanalysis.items[0].fingerprint, first.preanalysis.items[0].fingerprint);
  assert.deepEqual(next.preanalysis.items[0].answer, ['B']);
  await finish(app, next);
  assert.equal((await app.request('/preanalysis/status')).status, 'completed');
  const fresh = await app.request('/preanalysis/questions/PRE-1');
  assert.equal(fresh.state, 'ready');
  assert.equal(fresh.questionRevision, 1);
  assert.equal(fresh.contentVersion, stale.contentVersion);

  const app2 = await harness(t, 1);
  const pending = await dispatch(app2, 1);
  await correct(app2);
  assert.equal((await finish(app2, pending)).failureCode, 'preanalysis-validation');
  assert.equal((await app2.request('/preanalysis/questions/PRE-1')).text, '');
});

test('personalized journal retains selected answers and uses prepared analysis only after a button request', async t => {
  const app = await harness(t, 1);
  const batch = await dispatch(app, 1); await finish(app, batch);
  assert.equal((await app.request('/bridge/overview')).latestJob, null);
  const job = await app.request('/bridge/jobs', { questionId: 'PRE-1', answer: ['B'] });
  assert.match(job.prompt, /已保存的通用讲解/); assert.match(job.prompt, /我的答案：B/);
  await app.restart();
  const restored = await app.request(`/bridge/jobs/${job.id}`);
  assert.deepEqual(restored.userAnswer, ['B']); assert.equal(restored.questionFingerprint, job.questionFingerprint);
});

test('cached answer snapshots cannot contradict the current question even with a matching fingerprint', async t => {
  const app = await harness(t, 1);
  const batch = await dispatch(app, 1); await finish(app, batch);
  const learning = await app.saved();
  const file = path.join(app.dataDir, 'preanalysis-state.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  for (const answer of [['B'], ['A', 'A'], null, 'A']) {
    const candidate = structuredClone(original);
    candidate.cache['PRE-1'].answer = answer;
    const evidence = JSON.stringify(candidate);
    await writeFile(file, evidence); await app.restart();
    const prepared = await app.request('/preanalysis/questions/PRE-1');
    assert.equal(prepared.state, 'review'); assert.equal(prepared.text, '');
    const status = await app.request('/preanalysis/status');
    assert.equal(status.completed, 0); assert.equal(status.stale, 1);
    assert.equal(await readFile(file, 'utf8'), evidence, 'reading never silently repairs evidence');
  }
  assert.equal(await app.saved(), learning);
});

test('legacy cache keeps its provenance unknown and distinguishes identity checks from factual review', async t => {
  const app = await harness(t, 1);
  const batch = await dispatch(app, 1); await finish(app, batch);
  const file = path.join(app.dataDir, 'preanalysis-state.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  delete state.cache['PRE-1'].source; delete state.cache['PRE-1'].answer;
  const evidence = JSON.stringify(state);
  await writeFile(file, evidence); await app.restart();
  const prepared = await app.request('/preanalysis/questions/PRE-1');
  assert.equal(prepared.state, 'ready'); assert.equal(prepared.text, analysis);
  assert.equal(prepared.source, '来源未记录的历史通用讲解');
  assert.deepEqual(prepared.validation, { identity: 'matched', answer: 'not-recorded', factualReview: 'not-recorded' });
  assert.equal(await readFile(file, 'utf8'), evidence);
});
