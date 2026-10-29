import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStudyApi } from './api.mjs';

// These synthetic questions deliberately exercise different filters and exact-set grading.
const questions = [
  {
    id: 'fixture-single', type: 'single', category: '网络基础', chapter: 'TCP/IP',
    knowledgePoint: '网络分层', difficulty: '基础', stem: '哪一项是传输层协议？',
    options: [{ id: 'A', text: 'TCP' }, { id: 'B', text: 'IP' }, { id: 'C', text: 'ARP' }, { id: 'D', text: '以太网' }],
    answer: ['A'], explanation: 'TCP 是传输层协议。', source: '自动化测试原创题',
  },
  {
    id: 'fixture-multiple', type: 'multiple', category: '安全基础', chapter: '访问控制',
    knowledgePoint: '身份认证', difficulty: '进阶', stem: '以下哪些属于认证因素？',
    options: [{ id: 'A', text: '所知信息' }, { id: 'B', text: '浏览器颜色' }, { id: 'C', text: '持有物' }, { id: 'D', text: '窗口大小' }],
    answer: ['A', 'C'], explanation: '所知信息和持有物可作为认证因素。', source: '自动化测试原创题',
  },
  {
    id: 'fixture-risk', type: 'single', category: '安全基础', chapter: '风险管理',
    knowledgePoint: '风险处置', difficulty: '综合', stem: '风险评估应结合什么？',
    options: [{ id: 'A', text: '只看资产名称' }, { id: 'B', text: '发生可能性与影响' }, { id: 'C', text: '只看设备颜色' }, { id: 'D', text: '只看用户名' }],
    answer: ['B'], explanation: '风险应结合可能性与影响评估。', source: '自动化测试原创题',
  },
  {
    id: 'fixture-backup', type: 'single', category: '数据安全', chapter: '备份恢复',
    knowledgePoint: '恢复验证', difficulty: '基础', stem: '备份后还应执行什么？',
    options: [{ id: 'A', text: '丢弃所有记录' }, { id: 'B', text: '共享所有口令' }, { id: 'C', text: '关闭校验' }, { id: 'D', text: '恢复验证' }],
    answer: ['D'], explanation: '恢复验证可检查备份的可用性。', source: '自动化测试原创题',
  },
];

const asSession = (body) => body.session ?? body;
const asProgress = (body) => body.progress ?? body;

function questionProgress(bootstrap, id) {
  const progress = bootstrap.progress;
  if (Array.isArray(progress)) return progress.find((entry) => entry.questionId === id || entry.id === id);
  return progress?.[id] ?? progress?.questions?.[id] ?? progress?.byQuestion?.[id];
}

async function harness(t, options = {}) {
  const { fixtureQuestions = questions, ...apiOptions } = options;
  const directory = await mkdtemp(join(tmpdir(), 'yankao-study-api-test-'));
  const dataDir = join(directory, 'data');
  const questionsPath = join(directory, 'questions.json');
  await mkdir(dataDir, { recursive: true });
  await writeFile(questionsPath, JSON.stringify(fixtureQuestions), 'utf8');
  let api;
  let server;
  let baseUrl;

  async function start() {
    api = await createStudyApi({ dataDir, questionsPath, ...apiOptions });
    assert.equal(typeof api.handle, 'function');
    server = createServer((req, res) => api.handle(req, res, () => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'test route not found' }));
    }));
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', accept);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  async function stop() {
    if (server?.listening) {
      const closing = new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
      server.closeAllConnections?.();
      await closing;
    }
    server = undefined;
    await api?.close?.();
    api = undefined;
  }

  t.after(async () => {
    await stop();
    // Only remove the unique directory this test created beneath the OS temporary folder.
    const ownedPath = resolve(directory);
    assert.ok(ownedPath.startsWith(resolve(tmpdir()) + sep));
    assert.ok(ownedPath.split(sep).at(-1).startsWith('yankao-study-api-test-'));
    await rm(ownedPath, { recursive: true, force: true });
  });
  await start();

  return {
    directory, dataDir, questionsPath,
    get baseUrl() { return baseUrl; },
    async restart() { await stop(); await start(); },
    holdRequest(path, { method = 'PATCH', body = {} } = {}) {
      let release;
      let reading;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { reading = resolve; });
      const encoded = Buffer.from(JSON.stringify(body));
      const req = {
        url: `/study-api${path}`, method,
        headers: { host: new URL(baseUrl).host, 'content-type': 'application/json' },
        async *[Symbol.asyncIterator]() {
          yield encoded.subarray(0, 1);
          reading();
          await gate;
          yield encoded.subarray(1);
        },
      };
      let text;
      const res = { statusCode: 200, setHeader() {}, end(value) { text = value; } };
      const pending = api.handle(req, res).then(() => ({ status: res.statusCode, body: JSON.parse(text), text }));
      return { started, finish() { release(); return pending; } };
    },
    async request(path, { method = 'GET', body, headers = {} } = {}) {
      // Legacy functional cases model a client that freshly read its editable values.
      // The independent integrity suite supplies fixed old baselines explicitly.
      if (body && (method === 'PATCH' || /\/(check|finish)$/.test(path))) {
        body = structuredClone(body);
        const snapshot = await (await fetch(`${baseUrl}/study-api/bootstrap`)).json();
        const questionMatch = /^\/questions\/([^/]+)$/.exec(path);
        if (questionMatch && body.expected === undefined) {
          const current = snapshot.progress?.[questionMatch[1]] || {};
          body.expected = Object.fromEntries(Object.keys(body).filter(key => ['note', 'reason', 'aiNote', 'favorite', 'mastered'].includes(key))
            .map(key => [key, current[key] ?? (['favorite', 'mastered'].includes(key) ? false : '')]));
        }
        const sessionMatch = /^\/sessions\/([^/]+)(?:\/(check|finish))?$/.exec(path);
        if (sessionMatch) {
          const current = snapshot.sessions?.find(session => session.id === sessionMatch[1]);
          if (body.questionId && body.expectedAnswer === undefined) body.expectedAnswer = current?.answers[body.questionId] || [];
          if (sessionMatch[2] === 'finish' && body.expectedAnswers === undefined) body.expectedAnswers = current?.answers || {};
        }
      }
      const response = await fetch(`${baseUrl}/study-api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch { result = { raw: text }; }
      return { status: response.status, body: result, text };
    },
  };
}

function success(response) {
  assert.ok(response.status >= 200 && response.status < 300, `${response.status}: ${response.text}`);
  return response.body;
}

function clientError(response) {
  assert.ok(response.status >= 400 && response.status < 500, `${response.status}: ${response.text}`);
  assert.equal(typeof response.body.error, 'string');
}

async function createSession(app, overrides = {}) {
  return asSession(success(await app.request('/sessions', {
    method: 'POST', body: { mode: 'sequential', count: 4, minutes: 10, ...overrides },
  })));
}

async function blockJsonWrite(app, filename = 'learning-state.json') {
  const target = join(app.dataDir, filename);
  const backup = `${target}.write-test-backup`;
  await rename(target, backup);
  await mkdir(target);
  let restored = false;
  return async () => {
    if (restored) return;
    await rmdir(target);
    await rename(backup, target);
    restored = true;
  };
}

test('bootstrap exposes the local question bank and empty learning state', async (t) => {
  const app = await harness(t);
  const boot = success(await app.request('/bootstrap'));
  assert.equal(boot.questions.length, 4);
  assert.deepEqual(boot.questions.map((question) => question.id).sort(), questions.map((question) => question.id).sort());
  assert.ok(boot.progress && typeof boot.progress === 'object');
  assert.ok(Array.isArray(boot.sessions));
  assert.equal(boot.activeSession, null);
  assert.ok(boot.ai && typeof boot.ai === 'object');
});

test('a release without a question-bank file starts empty and accepts a user bank after restart', async (t) => {
  const app = await harness(t, { fixtureQuestions: [] });
  await rm(app.questionsPath);
  await app.restart();
  const boot = success(await app.request('/bootstrap'));
  assert.deepEqual(boot.questions, []);
  assert.deepEqual(boot.progress, {});
  assert.deepEqual(boot.sessions, []);
  assert.equal(boot.activeSession, null);
  const result = await app.request('/sessions', { method: 'POST', body: { mode: 'sequential', count: 1 } });
  clientError(result);
  await writeFile(app.questionsPath, JSON.stringify(questions));
  await app.restart();
  assert.equal(success(await app.request('/bootstrap')).questions.length, questions.length);
  const session = await createSession(app, { questionIds: [questions[0].id], count: 1 });
  assert.deepEqual(session.questionIds, [questions[0].id]);
});

test('practice grading requires an exact choice set and ignores multiple-choice ordering', async (t) => {
  const app = await harness(t);
  const cases = [
    ['fixture-single', ['A'], true],
    ['fixture-single', ['B'], false],
    ['fixture-multiple', ['C', 'A'], true],
    ['fixture-multiple', ['A'], false],
    ['fixture-multiple', ['A', 'B', 'C'], false],
    ['fixture-multiple', ['B', 'D'], false],
  ];
  for (const [questionId, answer, expectedCorrect] of cases) {
    const session = await createSession(app, { questionIds: [questionId], count: 1 });
    const checked = success(await app.request(`/sessions/${session.id}/check`, {
      method: 'POST', body: { questionId, answer },
    }));
    assert.equal(checked.correct, expectedCorrect, `${questionId}: ${JSON.stringify(answer)}`);
    assert.deepEqual([...checked.answer].sort(), [...questions.find((question) => question.id === questionId).answer].sort());
    assert.equal(checked.explanation, questions.find((question) => question.id === questionId).explanation);
  }
});

test('empty or invalid practice selections are rejected without recording attempts', async (t) => {
  const app = await harness(t);
  const session = await createSession(app, { questionIds: ['fixture-single'], count: 1 });
  const before = success(await app.request('/bootstrap'));
  for (const answer of [[], ['A', 'B'], ['unknown-option'], 'A', null]) {
    clientError(await app.request(`/sessions/${session.id}/check`, { method: 'POST', body: { questionId: 'fixture-single', answer } }));
  }
  assert.deepEqual(success(await app.request('/bootstrap')).progress, before.progress);
});

test('rechecking or finishing the same practice answer cannot multiply wrong-answer counts', async (t) => {
  const app = await harness(t);
  const questionId = 'fixture-single';
  const session = await createSession(app, { count: 1, questionIds: [questionId] });
  success(await app.request(`/sessions/${session.id}/check`, { method: 'POST', body: { questionId, answer: ['B'] } }));
  const afterFirstCheck = success(await app.request('/bootstrap'));
  const repeated = await app.request(`/sessions/${session.id}/check`, { method: 'POST', body: { questionId, answer: ['B'] } });
  assert.ok(repeated.status < 500);
  const afterRepeat = success(await app.request('/bootstrap'));
  assert.deepEqual(afterRepeat.progress, afterFirstCheck.progress);

  success(await app.request(`/sessions/${session.id}/finish`, { method: 'POST', body: {} }));
  const afterFinish = success(await app.request('/bootstrap'));
  assert.deepEqual(afterFinish.progress, afterFirstCheck.progress);
  const wrongSession = await createSession(app, { mode: 'wrong', count: 4 });
  assert.ok(wrongSession.questionIds.includes(questionId));
});

test('saved answers, active session, mistakes, favorites, notes and mastery survive a restart', async (t) => {
  const app = await harness(t);
  const questionId = 'fixture-risk';
  const session = await createSession(app, { questionIds: [questionId], count: 1 });
  success(await app.request(`/sessions/${session.id}`, { method: 'PATCH', body: { questionId, answer: ['A'], cursor: 0 } }));
  success(await app.request(`/sessions/${session.id}/check`, { method: 'POST', body: { questionId, answer: ['A'] } }));
  const metadata = { favorite: true, mastered: true, note: '复习可能性与影响；保留中文和换行\n第二行', reason: '误把风险与资产清单混淆' };
  const patched = asProgress(success(await app.request(`/questions/${questionId}`, { method: 'PATCH', body: metadata })));
  for (const [key, value] of Object.entries(metadata)) assert.equal(patched[key], value);
  const before = success(await app.request('/bootstrap'));
  await app.restart();
  const after = success(await app.request('/bootstrap'));
  assert.deepEqual(after.progress, before.progress);
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.activeSession, before.activeSession);
  for (const [key, value] of Object.entries(metadata)) assert.equal(questionProgress(after, questionId)?.[key], value);
  const favorites = await createSession(app, { mode: 'favorites' });
  assert.deepEqual(favorites.questionIds, [questionId]);
});

test('exam answers do not affect mistakes until submission and finish is idempotent', async (t) => {
  const app = await harness(t);
  const before = success(await app.request('/bootstrap'));
  const session = await createSession(app, { mode: 'exam', count: 2, questionIds: ['fixture-single', 'fixture-multiple'] });
  assert.equal(session.mode, 'exam');
  assert.ok(Number.isFinite(Date.parse(session.deadlineAt)));
  success(await app.request(`/sessions/${session.id}`, { method: 'PATCH', body: { questionId: 'fixture-single', answer: ['B'], cursor: 1 } }));
  success(await app.request(`/sessions/${session.id}`, { method: 'PATCH', body: { questionId: 'fixture-multiple', answer: ['C', 'A'] } }));
  const whileAnswering = success(await app.request('/bootstrap'));
  assert.deepEqual(whileAnswering.progress, before.progress);
  clientError(await app.request(`/sessions/${session.id}/check`, { method: 'POST', body: { questionId: 'fixture-single', answer: ['B'] } }));
  const finished = success(await app.request(`/sessions/${session.id}/finish`, { method: 'POST', body: {} }));
  assert.equal(finished.results.length, 2);
  assert.equal(finished.results.find((result) => result.questionId === 'fixture-single').correct, false);
  assert.equal(finished.results.find((result) => result.questionId === 'fixture-multiple').correct, true);
  assert.equal(finished.results.find((result) => result.questionId === 'fixture-multiple').explanation, questions[1].explanation);
  const afterFirstFinish = success(await app.request('/bootstrap'));
  const repeatedFinish = success(await app.request(`/sessions/${session.id}/finish`, { method: 'POST', body: {} }));
  assert.deepEqual(repeatedFinish, finished);
  assert.deepEqual(success(await app.request('/bootstrap')).progress, afterFirstFinish.progress);
});

test('unanswered exam questions are marked wrong on submission', async (t) => {
  const app = await harness(t);
  const session = await createSession(app, { mode: 'exam', questionIds: ['fixture-single'], count: 1 });
  const finished = success(await app.request(`/sessions/${session.id}/finish`, { method: 'POST', body: {} }));
  assert.equal(finished.results[0].correct, false);
  assert.deepEqual(finished.results[0].userAnswer, []);
  const progress = questionProgress(success(await app.request('/bootstrap')), 'fixture-single');
  assert.equal(progress.attempts, 1);
  assert.equal(progress.wrongCount, 1);
});

test('expired exams submit saved answers once and reject answers after the deadline', async (t) => {
  let currentTime = Date.now();
  const app = await harness(t, { now: () => currentTime });
  const session = await createSession(app, { mode: 'exam', questionIds: ['fixture-single'], count: 1, minutes: 1 });
  success(await app.request(`/sessions/${session.id}`, { method: 'PATCH', body: { questionId: 'fixture-single', answer: ['A'] } }));
  currentTime += 60001;
  const lateSave = await app.request(`/sessions/${session.id}`, { method: 'PATCH', body: { questionId: 'fixture-single', answer: ['B'] } });
  assert.equal(lateSave.status, 409);
  const boot = success(await app.request('/bootstrap'));
  const completed = boot.sessions.find((entry) => entry.id === session.id);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.answers['fixture-single'], ['A']);
  const progress = questionProgress(boot, 'fixture-single');
  assert.equal(progress.attempts, 1);
  assert.equal(progress.correctCount, 1);
  assert.equal(progress.wrongCount, 0);
  assert.deepEqual(success(await app.request('/bootstrap')).progress, boot.progress);
});

test('an answer whose body finishes after the exam deadline cannot replace the previously saved answer', async (t) => {
  let currentTime = Date.now();
  const app = await harness(t, { now: () => currentTime });
  const session = await createSession(app, { mode: 'exam', questionIds: ['fixture-single'], count: 1, minutes: 1 });
  success(await app.request(`/sessions/${session.id}`, { method: 'PATCH', body: { questionId: 'fixture-single', answer: ['A'] } }));
  const pending = app.holdRequest(`/sessions/${session.id}`, { body: { questionId: 'fixture-single', answer: ['B'], expectedAnswer: ['A'] } });
  await pending.started;
  currentTime += 60001;
  assert.equal((await pending.finish()).status, 409);
  const boot = success(await app.request('/bootstrap'));
  assert.equal(boot.sessions[0].status, 'completed');
  assert.deepEqual(boot.sessions[0].answers['fixture-single'], ['A']);
  assert.equal(boot.progress['fixture-single'].correctCount, 1);
  await app.restart();
  assert.deepEqual(success(await app.request('/bootstrap')).sessions, boot.sessions);
});

test('a request waiting for its body cannot change the cursor after the session is finished', async (t) => {
  const app = await harness(t);
  const session = await createSession(app, { count: 2 });
  const pending = app.holdRequest(`/sessions/${session.id}`, { body: { cursor: 1 } });
  await pending.started;
  const finished = success(await app.request(`/sessions/${session.id}/finish`, { method: 'POST', body: {} }));
  assert.equal((await pending.finish()).status, 409);
  assert.deepEqual(success(await app.request(`/sessions/${session.id}`)), finished.session);
});

test('a delayed check cannot import an older replacement over its live session', async (t) => {
  const app = await harness(t);
  const questionId = 'fixture-single';
  const session = await createSession(app, { questionIds: [questionId], count: 1 });
  const pending = app.holdRequest(`/sessions/${session.id}/check`, { method: 'POST', body: { questionId, answer: ['A'], expectedAnswer: [] } });
  await pending.started;
  const backup = success(await app.request('/export'));
  backup.sessions[0] = { ...backup.sessions[0], status: 'completed', finishedAt: new Date().toISOString(), answers: { [questionId]: ['B'] }, submittedQuestionIds: [questionId] };
  success(await app.request('/import', { method: 'POST', body: backup }));
  const imported = success(await app.request('/bootstrap'));
  assert.equal(imported.sessions[0].status, 'active', 'import must keep the current live session');
  assert.equal((await pending.finish()).status, 200);
  const after = success(await app.request('/bootstrap'));
  assert.equal(after.progress[questionId].attempts, 1);
  assert.deepEqual(after.sessions[0].answers[questionId], ['A']);
});

test('a failed session creation leaves no phantom session and a retry creates one durable session', async (t) => {
  const app = await harness(t);
  await createSession(app, { count: 1 });
  const before = success(await app.request('/bootstrap'));
  const restore = await blockJsonWrite(app);
  try {
    assert.equal((await app.request('/sessions', { method: 'POST', body: { mode: 'sequential', count: 1 } })).status, 500);
    assert.deepEqual(success(await app.request('/bootstrap')).sessions, before.sessions);
  } finally { await restore(); }
  await createSession(app, { count: 1 });
  const after = success(await app.request('/bootstrap'));
  assert.equal(after.sessions.length, before.sessions.length + 1);
  await app.restart();
  assert.deepEqual(success(await app.request('/bootstrap')).sessions, after.sessions);
});

test('a failed answer save rolls back its answer and cursor before a successful retry', async (t) => {
  const app = await harness(t);
  const session = await createSession(app, { count: 2 });
  const body = { questionId: 'fixture-single', answer: ['A'], cursor: 1 };
  const restore = await blockJsonWrite(app);
  try {
    assert.equal((await app.request(`/sessions/${session.id}`, { method: 'PATCH', body })).status, 500);
    assert.deepEqual(success(await app.request(`/sessions/${session.id}`)), session);
  } finally { await restore(); }
  const saved = success(await app.request(`/sessions/${session.id}`, { method: 'PATCH', body }));
  await app.restart();
  assert.deepEqual(success(await app.request(`/sessions/${session.id}`)), saved);
});

test('a failed practice check rolls back grading so its retry is counted once and survives restart', async (t) => {
  const app = await harness(t);
  const questionId = 'fixture-single';
  const session = await createSession(app, { questionIds: [questionId], count: 1 });
  const before = success(await app.request('/bootstrap'));
  const body = { questionId, answer: ['B'] };
  const restore = await blockJsonWrite(app);
  try {
    assert.equal((await app.request(`/sessions/${session.id}/check`, { method: 'POST', body })).status, 500);
    const afterFailure = success(await app.request('/bootstrap'));
    assert.deepEqual(afterFailure.sessions, before.sessions);
    assert.deepEqual(afterFailure.progress, before.progress);
  } finally { await restore(); }
  success(await app.request(`/sessions/${session.id}/check`, { method: 'POST', body }));
  const checked = success(await app.request('/bootstrap'));
  assert.equal(checked.progress[questionId].attempts, 1);
  assert.equal(checked.progress[questionId].wrongCount, 1);
  await app.restart();
  assert.deepEqual(success(await app.request('/bootstrap')).progress, checked.progress);
});

test('a failed finish rolls back completion so retry persists its score and grading exactly once', async (t) => {
  const app = await harness(t);
  const questionId = 'fixture-single';
  const session = await createSession(app, { mode: 'exam', questionIds: [questionId], count: 1 });
  success(await app.request(`/sessions/${session.id}`, { method: 'PATCH', body: { questionId, answer: ['A'] } }));
  const before = success(await app.request('/bootstrap'));
  const restore = await blockJsonWrite(app);
  try {
    assert.equal((await app.request(`/sessions/${session.id}/finish`, { method: 'POST', body: {} })).status, 500);
    const afterFailure = success(await app.request('/bootstrap'));
    assert.deepEqual(afterFailure.sessions, before.sessions);
    assert.deepEqual(afterFailure.progress, before.progress);
  } finally { await restore(); }
  const finished = success(await app.request(`/sessions/${session.id}/finish`, { method: 'POST', body: {} }));
  assert.equal(finished.session.status, 'completed');
  assert.equal(finished.session.score, 100);
  const after = success(await app.request('/bootstrap'));
  assert.equal(after.progress[questionId].attempts, 1);
  await app.restart();
  const restarted = success(await app.request('/bootstrap'));
  assert.deepEqual(restarted.progress, after.progress);
  assert.deepEqual(restarted.sessions, after.sessions);
});

test('a failed metadata save exposes neither unsaved notes nor an unsaved favorite', async (t) => {
  const app = await harness(t);
  const questionId = 'fixture-single';
  success(await app.request(`/questions/${questionId}`, { method: 'PATCH', body: { note: '原笔记', aiNote: '原解析' } }));
  const before = success(await app.request('/bootstrap'));
  const restore = await blockJsonWrite(app);
  try {
    assert.equal((await app.request(`/questions/${questionId}`, { method: 'PATCH', body: { note: '未保存笔记', aiNote: '未保存解析', favorite: true } })).status, 500);
    assert.deepEqual(success(await app.request('/bootstrap')).progress, before.progress);
  } finally { await restore(); }
  await app.restart();
  assert.deepEqual(success(await app.request('/bootstrap')).progress, before.progress);
});

test('a failed import rolls back both progress and sessions while allowing the same backup to be retried', async (t) => {
  const app = await harness(t);
  const questionId = 'fixture-single';
  await createSession(app, { questionIds: [questionId], count: 1 });
  success(await app.request(`/questions/${questionId}`, { method: 'PATCH', body: { note: '保留原笔记' } }));
  const before = success(await app.request('/bootstrap'));
  const backup = success(await app.request('/export'));
  backup.progress[questionId].note = '导入笔记';
  backup.sessions[0].cursor = 0;
  backup.sessions.push({ ...backup.sessions[0], id: 'new-imported-session' });
  const restore = await blockJsonWrite(app);
  try {
    assert.equal((await app.request('/import', { method: 'POST', body: backup })).status, 500);
    const failed = success(await app.request('/bootstrap'));
    assert.deepEqual(failed.progress, before.progress);
    assert.deepEqual(failed.sessions, before.sessions);
  } finally { await restore(); }
  success(await app.request('/import', { method: 'POST', body: backup }));
  const imported = success(await app.request('/bootstrap'));
  assert.equal(imported.progress[questionId].note, '保留原笔记');
  assert.equal(imported.sessions.length, before.sessions.length + 1);
  await app.restart();
  const restarted = success(await app.request('/bootstrap'));
  assert.deepEqual(restarted.progress, imported.progress);
  assert.deepEqual(restarted.sessions, imported.sessions);
});

test('failed retrieval settings persistence cannot change the credentials held in memory', async (t) => {
  const app = await harness(t);
  success(await app.request('/ai/settings', { method: 'PUT', body: { baseUrl: 'https://api.deepseek.com/v1', clearApiKey: true } }));
  const before = success(await app.request('/bootstrap')).ai;
  const restore = await blockJsonWrite(app, 'ai-settings.json');
  try {
    assert.equal((await app.request('/ai/settings', { method: 'PUT', body: { apiKey: 'test-key' } })).status, 500);
    assert.deepEqual(success(await app.request('/bootstrap')).ai, before);
  } finally { await restore(); }
  success(await app.request('/ai/settings', { method: 'PUT', body: { apiKey: 'retry-test-key' } }));
  await app.restart();
  assert.equal(success(await app.request('/bootstrap')).ai.configured, true);
  assert.equal(success(await app.request('/bootstrap')).ai.model, '');
});

test('retired generation preserves the saved explanation and makes zero network calls', async (t) => {
  let calls = 0;
  const app = await harness(t, { fetchImpl: async () => { calls++; throw new Error('Generation forbidden'); } });
  const questionId = 'fixture-single';
  success(await app.request(`/questions/${questionId}`, { method: 'PATCH', body: { aiNote: '原解析' } }));
  const before = success(await app.request('/export'));
  const response = await app.request('/ai/explain', { method: 'POST', body: { questionId, answer: ['A'] } });
  assert.equal(response.status, 410);
  assert.equal(response.body.modelRequested, false);
  const after = success(await app.request('/export'));
  delete before.exportedAt; delete after.exportedAt;
  assert.deepEqual(after, before);
  assert.equal(calls, 0);
});

test('unknown questions and filters with no matches return controlled responses without phantom progress', async (t) => {
  const app = await harness(t);
  const empty = await app.request('/sessions', { method: 'POST', body: { mode: 'random', count: 3, minutes: 10, category: '不存在的分类' } });
  assert.ok(empty.status < 500, empty.text);
  if (empty.status < 300) assert.deepEqual(asSession(empty.body).questionIds, []);
  else clientError(empty);

  const unknownCreation = await app.request('/sessions', { method: 'POST', body: { mode: 'sequential', questionIds: ['unknown-question'], count: 1, minutes: 10 } });
  assert.ok(unknownCreation.status < 500, unknownCreation.text);
  if (unknownCreation.status < 300) assert.ok(!asSession(unknownCreation.body).questionIds.includes('unknown-question'));
  else clientError(unknownCreation);

  const session = await createSession(app, { count: 1, questionIds: ['fixture-single'] });
  clientError(await app.request(`/sessions/${session.id}`, { method: 'PATCH', body: { questionId: 'unknown-question', answer: ['A'] } }));
  clientError(await app.request(`/sessions/${session.id}/check`, { method: 'POST', body: { questionId: 'unknown-question', answer: ['A'] } }));
  clientError(await app.request('/questions/unknown-question', { method: 'PATCH', body: { favorite: true } }));
  assert.equal(questionProgress(success(await app.request('/bootstrap')), 'unknown-question'), undefined);
});

test('an empty question bank remains readable and rejects session creation gracefully', async (t) => {
  const app = await harness(t, { fixtureQuestions: [] });
  const boot = success(await app.request('/bootstrap'));
  assert.deepEqual(boot.questions, []);
  assert.deepEqual(boot.sessions, []);
  clientError(await app.request('/sessions', { method: 'POST', body: { mode: 'exam', count: 1, minutes: 10 } }));
  assert.deepEqual(success(await app.request('/export')).questionIds, []);
});

test('a rejected compound update does not partially change answers or question metadata', async (t) => {
  const app = await harness(t);
  const session = await createSession(app, { questionIds: ['fixture-single'], count: 1 });
  success(await app.request('/questions/fixture-single', { method: 'PATCH', body: { favorite: false, note: '原有笔记必须保留' } }));
  const before = success(await app.request('/bootstrap'));
  clientError(await app.request(`/sessions/${session.id}`, {
    method: 'PATCH', body: { questionId: 'fixture-single', answer: ['A'], cursor: 999 },
  }));
  clientError(await app.request('/questions/fixture-single', {
    method: 'PATCH', body: { favorite: true, note: { invalid: true } },
  }));
  const after = success(await app.request('/bootstrap'));
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.progress, before.progress);
  await app.restart();
  assert.deepEqual(success(await app.request('/bootstrap')).sessions, before.sessions);
});

test('export/import preserves newer local learning state and invalid import changes nothing', async (t) => {
  const app = await harness(t);
  const questionId = 'fixture-backup';
  success(await app.request(`/questions/${questionId}`, { method: 'PATCH', body: { favorite: true, note: '备份恢复验证' } }));
  const original = success(await app.request('/bootstrap'));
  const backup = success(await app.request('/export'));
  success(await app.request(`/questions/${questionId}`, { method: 'PATCH', body: { favorite: false, note: '已更改' } }));
  const latest = success(await app.request('/bootstrap'));
  success(await app.request('/import', { method: 'POST', body: backup }));
  const restored = success(await app.request('/bootstrap'));
  assert.deepEqual(restored.progress, latest.progress);
  assert.deepEqual(restored.sessions, original.sessions);
  clientError(await app.request('/import', { method: 'POST', body: { unexpected: true } }));
  assert.deepEqual(success(await app.request('/bootstrap')).progress, restored.progress);
});

test('overlapping saves for different questions survive restart without lost updates', async (t) => {
  const app = await harness(t);
  const changes = [
    ['fixture-single', { favorite: true, note: '并发保存甲' }],
    ['fixture-risk', { favorite: true, note: '并发保存乙' }],
  ];
  const responses = await Promise.all(changes.map(([id, body]) => app.request(`/questions/${id}`, { method: 'PATCH', body })));
  responses.forEach(success);
  await app.restart();
  const restored = success(await app.request('/bootstrap'));
  for (const [id, expected] of changes) {
    const progress = questionProgress(restored, id);
    assert.equal(progress?.favorite, true);
    assert.equal(progress?.note, expected.note);
  }
});

test('invalid backup sessions are rejected before any existing study data changes', async (t) => {
  const app = await harness(t);
  const existing = await createSession(app, { mode: 'exam', count: 1, questionIds: ['fixture-single'] });
  const before = success(await app.request('/bootstrap'));
  const backup = success(await app.request('/export'));
  const invalidSessions = [
    { ...existing, id: 'bad-unknown', questionIds: ['unknown-question'] },
    { ...existing, id: 'bad-duplicates', questionIds: ['fixture-single', 'fixture-single'] },
    { ...existing, id: 'bad-answer', answers: { 'fixture-single': ['unknown-option'] } },
    { ...existing, id: 'bad-mode', mode: 'not-a-mode' },
    { ...existing, id: 'bad-deadline', deadlineAt: null },
    { ...existing, id: 'bad-submitted', submittedQuestionIds: ['fixture-single'], answers: { 'fixture-single': ['A'] } },
  ];
  for (const invalidSession of invalidSessions) {
    clientError(await app.request('/import', { method: 'POST', body: { ...backup, sessions: [invalidSession] } }));
    const after = success(await app.request('/bootstrap'));
    assert.deepEqual(after.progress, before.progress);
    assert.deepEqual(after.sessions, before.sessions);
  }
});

test('retrieval configuration never echoes its API key and generation remains retired', async (t) => {
  let providerCalls = 0;
  const app = await harness(t, { fetchImpl: async () => { providerCalls += 1; throw new Error('unexpected provider request'); } });
  const unavailable = await app.request('/ai/explain', { method: 'POST', body: { questionId: 'fixture-single' } });
  assert.equal(unavailable.status, 410);
  assert.equal(providerCalls, 0);
  const apiKey = 'test-secret-never-echo-4f72895a';
  const saved = await app.request('/ai/settings', {
    method: 'PUT', body: { baseUrl: 'https://api.deepseek.com/v1', apiKey },
  });
  success(saved);
  assert.ok(!saved.text.includes(apiKey));
  assert.equal(providerCalls, 0);
  assert.ok(!(await app.request('/bootstrap')).text.includes(apiKey));
  assert.ok(!(await app.request('/export')).text.includes(apiKey));
  await app.restart();
  assert.ok(!(await app.request('/bootstrap')).text.includes(apiKey));
});

test('cross-origin writes are rejected without changing local study data', async (t) => {
  const app = await harness(t);
  const before = success(await app.request('/bootstrap'));
  const hostileHeaders = { Origin: 'https://unrelated.example' };
  for (const [path, method, body] of [
    ['/sessions', 'POST', { mode: 'random', count: 1, minutes: 10 }],
    ['/questions/fixture-single', 'PATCH', { favorite: true }],
    ['/ai/settings', 'PUT', { baseUrl: 'https://example.invalid/v1', model: 'changed' }],
    ['/import', 'POST', { unexpected: true }],
  ]) {
    const response = await app.request(path, { method, body, headers: hostileHeaders });
    assert.equal(response.status, 403, `${method} ${path}: ${response.text}`);
  }
  const after = success(await app.request('/bootstrap'));
  assert.deepEqual(after.progress, before.progress);
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.ai, before.ai);
  success(await app.request('/questions/fixture-single', { method: 'PATCH', body: { favorite: true }, headers: { Origin: app.baseUrl } }));
});

test('cross-site reads cannot expose notes, sessions, exports or AI configuration', async (t) => {
  const app = await harness(t);
  for (const path of ['/bootstrap', '/export']) {
    const originResponse = await app.request(path, { headers: { Origin: 'https://unrelated.example' } });
    assert.equal(originResponse.status, 403);
    const fetchSiteResponse = await app.request(path, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(fetchSiteResponse.status, 403);
  }
});
