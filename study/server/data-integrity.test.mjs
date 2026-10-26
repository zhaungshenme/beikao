import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStudyApi } from './api.mjs';

const bank = [
  { id: 'integrity-single', type: 'single', category: '数据保护', chapter: '并发保存', knowledgePoint: '版本校验', difficulty: '基础', stem: '保存共享记录时应该比较什么？', options: [{ id: 'A', text: '原始版本' }, { id: 'B', text: '背景颜色' }, { id: 'C', text: '窗口宽度' }, { id: 'D', text: '文件图标' }], answer: ['A'], explanation: '比较原始版本，避免覆盖更新。', source: '回归测试原创题' },
  { id: 'integrity-multiple', type: 'multiple', category: '数据保护', chapter: '恢复', knowledgePoint: '历史版本', difficulty: '基础', stem: '哪些能力有助于恢复？', options: [{ id: 'A', text: '保留旧版本' }, { id: 'B', text: '静默截断' }, { id: 'C', text: '验证恢复结果' }, { id: 'D', text: '无条件覆盖' }], answer: ['A', 'C'], explanation: '保留历史并验证恢复。', source: '回归测试原创题' },
];
const q1 = bank[0].id;
const q2 = bank[1].id;

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yankao-integrity-test-'));
  const dataDir = join(directory, 'state');
  const questionsPath = join(directory, 'questions.json');
  await mkdir(dataDir);
  await writeFile(questionsPath, JSON.stringify(bank));
  let api;
  let server;
  let base;
  async function start() {
    api = createStudyApi({ allowLegacyWebBridge: true, dataDir, questionsPath, ...options });
    server = createServer((req, res) => api.handle(req, res));
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    base = `http://127.0.0.1:${server.address().port}/study-api`;
  }
  async function stop() {
    if (server?.listening) {
      const closed = new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
      server.closeAllConnections();
      await closed;
    }
    api?.close();
  }
  t.after(async () => {
    await stop();
    const owned = resolve(directory);
    assert.ok(owned.startsWith(resolve(tmpdir()) + sep) && owned.split(sep).at(-1).startsWith('yankao-integrity-test-'));
    await rm(owned, { recursive: true, force: true });
  });
  await start();
  return {
    dataDir,
    async request(path, body, method = body === undefined ? 'GET' : 'POST') {
      // No implicit reads or automatic expected values: every write below carries its actual client baseline.
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async requestChunks(path, chunks) {
      const req = { url: `/study-api${path}`, method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield* chunks; } };
      let text;
      const res = { statusCode: 200, setHeader() {}, end(value) { text = value; } };
      await api.handle(req, res);
      return { status: res.statusCode, body: JSON.parse(text) };
    },
    async restart() { await stop(); await start(); },
  };
}

function ok(response) { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; }
function conflict(response) { assert.equal(response.status, 409); assert.equal(response.body.code, 'WRITE_CONFLICT'); return response.body; }
async function progress(app) { return ok(await app.request('/bootstrap')).progress; }
async function history(app, id = q1) { return ok(await app.request(`/questions/${id}/history`)).entries; }
async function note(app, text, expected, id = q1) { return app.request(`/questions/${id}`, { note: text, expected: { note: expected } }, 'PATCH'); }
async function aiNote(app, text, expected) { return app.request(`/questions/${q1}`, { aiNote: text, expected: { aiNote: expected } }, 'PATCH'); }
async function session(app, overrides = {}) { return ok(await app.request('/sessions', { mode: 'sequential', questionIds: [q1], count: 1, ...overrides })); }
async function configureApi(app) { ok(await app.request('/ai/settings', { baseUrl: 'https://example.invalid/v1', model: 'test-model', apiKey: 'fixture-key' }, 'PUT')); }

async function blockWrite(app, filename = 'learning-state.json') {
  const target = join(app.dataDir, filename);
  const backup = `${target}.integrity-backup`;
  await rename(target, backup);
  await mkdir(target);
  return async () => { await rmdir(target); await rename(backup, target); };
}

test('all changed question fields require explicit baselines and a compound conflict changes nothing', async t => {
  const app = await harness(t);
  for (const [field, value] of [['note', '笔记'], ['reason', '错因'], ['aiNote', '解析'], ['favorite', true], ['mastered', true]]) {
    const missing = await app.request(`/questions/${q1}`, { [field]: value }, 'PATCH');
    assert.equal(missing.status, 428, field);
    assert.equal(missing.body.code, 'PRECONDITION_REQUIRED');
  }
  ok(await note(app, '已保存', ''));
  const mixed = conflict(await app.request(`/questions/${q1}`, { note: '过期笔记', favorite: true, expected: { note: '', favorite: false } }, 'PATCH'));
  assert.equal(mixed.current.note, '已保存');
  assert.equal((await progress(app))[q1].favorite, false);
  ok(await app.request(`/questions/${q1}`, { note: '已保存' }, 'PATCH'));
  assert.equal((await progress(app))[q1].note, '已保存');
});

test('two real client baselines cannot overwrite each other and independent fields can still merge', async t => {
  const app = await harness(t);
  const clientA = { note: '', reason: '' };
  const clientB = { note: '', reason: '' };
  ok(await note(app, '客户端 A 的新笔记', clientA.note));
  conflict(await note(app, '客户端 B 的旧草稿', clientB.note));
  ok(await app.request(`/questions/${q1}`, { reason: '客户端 B 的独立错因', expected: { reason: clientB.reason } }, 'PATCH'));
  await app.restart();
  const saved = (await progress(app))[q1];
  assert.equal(saved.note, '客户端 A 的新笔记');
  assert.equal(saved.reason, '客户端 B 的独立错因');
});

test('text history survives clearing, restart and a reversible restore without accepting a stale restore', async t => {
  const app = await harness(t);
  ok(await note(app, '第一版完整正文', ''));
  ok(await note(app, '', '第一版完整正文'));
  const first = (await history(app)).find(entry => entry.text === '第一版完整正文');
  assert.ok(first);
  ok(await note(app, '第二版正文', ''));
  conflict(await app.request(`/questions/${q1}/restore`, { historyId: first.id, expected: '' }));
  const restored = ok(await app.request(`/questions/${q1}/restore`, { historyId: first.id, expected: '第二版正文' }));
  assert.equal(restored.note, first.text);
  assert.ok((await history(app)).some(entry => entry.text === '第二版正文' && entry.source === 'restore'));
  await app.restart();
  assert.equal((await progress(app))[q1].note, first.text);
  assert.ok((await history(app)).some(entry => entry.id === first.id));
  const wrongQuestion = await app.request(`/questions/${q2}/restore`, { historyId: first.id, expected: '' });
  assert.equal(wrongQuestion.status, 404);
});

test('oversized notes and followups are rejected rather than saved or sent as truncated text', async t => {
  const app = await harness(t);
  ok(await note(app, '原内容', ''));
  const beforeHistory = await history(app);
  for (const [field, limit, baseline] of [['note', 10000, '原内容'], ['reason', 100, ''], ['aiNote', 20000, '']]) {
    assert.equal((await app.request(`/questions/${q1}`, { [field]: '字'.repeat(limit + 1), expected: { [field]: baseline } }, 'PATCH')).status, 413);
  }
  assert.equal((await app.request('/bridge/jobs', { questionId: q1, question: '问'.repeat(1501) })).status, 413);
  assert.deepEqual(await history(app), beforeHistory);
  assert.equal((await progress(app))[q1].note, '原内容');
  const boundary = '字'.repeat(10000);
  assert.equal(ok(await note(app, boundary, '原内容')).note, boundary);
});

test('stale answer saves and stale checks cannot replace the answer saved by another client', async t => {
  const app = await harness(t);
  const practice = await session(app);
  const path = `/sessions/${practice.id}`;
  assert.equal((await app.request(path, { questionId: q1, answer: ['A'] }, 'PATCH')).status, 428);
  ok(await app.request(path, { questionId: q1, answer: ['A'], expectedAnswer: [] }, 'PATCH'));
  conflict(await app.request(path, { questionId: q1, answer: ['B'], expectedAnswer: [] }, 'PATCH'));
  assert.equal((await app.request(`${path}/check`, { questionId: q1, answer: ['B'] })).status, 428);
  conflict(await app.request(`${path}/check`, { questionId: q1, answer: ['B'], expectedAnswer: [] }));
  assert.equal((await progress(app))[q1], undefined);
  const checked = ok(await app.request(`${path}/check`, { questionId: q1, answer: ['A'], expectedAnswer: ['A'] }));
  assert.equal(checked.correct, true);
  assert.equal(checked.progress.attempts, 1);
  await app.restart();
  assert.deepEqual(ok(await app.request(path)).answers[q1], ['A']);
  assert.equal((await progress(app))[q1].attempts, 1);
});

test('answer CAS compares normalized sets and finish checks the whole saved answer map', async t => {
  const app = await harness(t);
  const exam = await session(app, { mode: 'exam', questionIds: [q1, q2], count: 2 });
  const path = `/sessions/${exam.id}`;
  ok(await app.request(path, { questionId: q2, answer: ['C', 'A'], expectedAnswer: [] }, 'PATCH'));
  ok(await app.request(path, { questionId: q2, answer: ['A', 'C'], expectedAnswer: ['C', 'A'] }, 'PATCH'));
  assert.equal((await app.request(`${path}/finish`, {})).status, 428);
  conflict(await app.request(`${path}/finish`, { expectedAnswers: {} }));
  assert.equal(ok(await app.request(path)).status, 'active');
  const finished = ok(await app.request(`${path}/finish`, { expectedAnswers: { [q2]: ['C', 'A'] } }));
  assert.equal(finished.session.status, 'completed');
  assert.deepEqual(ok(await app.request(`${path}/finish`, {})), finished);
  assert.equal((await progress(app))[q2].attempts, 1);
});

test('a delayed API result preserves an intervening manual explanation and stores the entire candidate', async t => {
  const started = deferred();
  const release = deferred();
  const candidate = '迟到模型候选\n'.repeat(250);
  const app = await harness(t, { fetchImpl: async () => { started.resolve(); await release.promise; return { ok: true, json: async () => ({ choices: [{ message: { content: candidate } }] }) }; } });
  await configureApi(app);
  ok(await aiNote(app, '生成前解析', ''));
  const pending = app.request('/ai/explain', { questionId: q1, answer: ['A'] });
  await started.promise;
  ok(await aiNote(app, '人工修订的新解析', '生成前解析'));
  release.resolve();
  const blocked = conflict(await pending);
  assert.equal(blocked.current.aiNote, '人工修订的新解析');
  assert.ok(blocked.historyId);
  assert.equal((await progress(app))[q1].aiNote, '人工修订的新解析');
  const savedCandidate = (await history(app)).find(entry => entry.id === blocked.historyId);
  assert.equal(savedCandidate.text, candidate.trim());
  assert.equal(savedCandidate.source, 'api-conflict');
  await app.restart();
  assert.equal((await history(app)).find(entry => entry.id === blocked.historyId).text, candidate.trim());
});

test('a bridge reply cannot overwrite a manual explanation saved after the bridge job started', async t => {
  const app = await harness(t);
  ok(await aiNote(app, '开始前完整解析', ''));
  const job = ok(await app.request('/bridge/jobs', { questionId: q1 }));
  ok(await aiNote(app, '另一标签人工解析', '开始前完整解析'));
  const reply = ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '网页生成的完整候选' }));
  assert.equal(reply.status, 'failed');
  assert.equal(reply.failureCode, 'save-conflict');
  assert.equal(reply.text, '网页生成的完整候选');
  assert.equal((await progress(app))[q1].aiNote, '另一标签人工解析');
  assert.equal((await history(app)).find(entry => entry.id === reply.historyId).text, reply.text);
  await app.restart();
  assert.equal(ok(await app.request(`/bridge/jobs/${job.id}`)).historyId, reply.historyId);
});

for (const first of ['api', 'bridge']) {
  test(`${first} finishing first protects its explanation from the other AI channel`, async t => {
    const started = deferred();
    const release = deferred();
    const app = await harness(t, { fetchImpl: async () => { started.resolve(); await release.promise; return { ok: true, json: async () => ({ choices: [{ message: { content: 'API 生成正文' } }] }) }; } });
    await configureApi(app);
    ok(await aiNote(app, '共同原始解析', ''));
    const job = ok(await app.request('/bridge/jobs', { questionId: q1 }));
    const api = app.request('/ai/explain', { questionId: q1 });
    await started.promise;
    if (first === 'api') {
      release.resolve();
      assert.equal(ok(await api).text, 'API 生成正文');
      const late = ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '网页生成正文' }));
      assert.equal(late.failureCode, 'save-conflict');
      assert.equal((await progress(app))[q1].aiNote, 'API 生成正文');
      assert.ok((await history(app)).some(entry => entry.text === '网页生成正文'));
    } else {
      assert.equal(ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '网页生成正文' })).status, 'completed');
      release.resolve();
      conflict(await api);
      assert.equal((await progress(app))[q1].aiNote, '网页生成正文');
      assert.ok((await history(app)).some(entry => entry.text === 'API 生成正文'));
    }
  });
}

test('two concurrent API calls retain the later-finished candidate without replacing the first saved result', async t => {
  const started = [deferred(), deferred()];
  const release = [deferred(), deferred()];
  let calls = 0;
  const app = await harness(t, { fetchImpl: async () => { const index = calls++; started[index].resolve(); await release[index].promise; return { ok: true, json: async () => ({ choices: [{ message: { content: `调用 ${index} 的结果` } }] }) }; } });
  await configureApi(app);
  const oldCall = app.request('/ai/explain', { questionId: q1 });
  await started[0].promise;
  const newCall = app.request('/ai/explain', { questionId: q1 });
  await started[1].promise;
  release[1].resolve();
  assert.equal(ok(await newCall).text, '调用 1 的结果');
  release[0].resolve();
  conflict(await oldCall);
  assert.equal((await progress(app))[q1].aiNote, '调用 1 的结果');
  assert.ok((await history(app)).some(entry => entry.text === '调用 0 的结果'));
});

test('bridge completion retries its own applied write after a journal failure without duplicating history', async t => {
  const app = await harness(t);
  ok(await aiNote(app, '原版解析', ''));
  const job = ok(await app.request('/bridge/jobs', { questionId: q1 }));
  const restore = await blockWrite(app, 'bridge-jobs.json');
  try {
    assert.equal((await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '已写入但日志未确认的解析' })).status, 500);
    assert.equal((await progress(app))[q1].aiNote, '已写入但日志未确认的解析');
  } finally { await restore(); }
  const before = await history(app);
  await app.restart();
  const retry = ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '已写入但日志未确认的解析' }));
  assert.equal(retry.status, 'completed');
  assert.deepEqual(await history(app), before);
});

test('a manual save between a partial bridge commit and retry is protected by its writer identity', async t => {
  const app = await harness(t);
  const job = ok(await app.request('/bridge/jobs', { questionId: q1 }));
  const restore = await blockWrite(app, 'bridge-jobs.json');
  try { assert.equal((await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '初次生成结果' })).status, 500); }
  finally { await restore(); }
  ok(await aiNote(app, '用户在错误后保存的新内容', '初次生成结果'));
  const retry = ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '初次生成结果' }));
  assert.equal(retry.failureCode, 'save-conflict');
  assert.equal((await progress(app))[q1].aiNote, '用户在错误后保存的新内容');
});

test('a note and its history commit atomically and a failed save leaves both at the previous version', async t => {
  const app = await harness(t);
  ok(await note(app, '已持久化版本', ''));
  const before = await history(app);
  const restore = await blockWrite(app);
  try {
    assert.equal((await note(app, '写盘失败版本', '已持久化版本')).status, 500);
    assert.equal((await progress(app))[q1].note, '已持久化版本');
    assert.deepEqual(await history(app), before);
  } finally { await restore(); }
  await app.restart();
  assert.deepEqual(await history(app), before);
  ok(await note(app, '成功重试版本', '已持久化版本'));
  assert.equal((await history(app)).filter(entry => entry.text === '已持久化版本').length, 1);
});

test('safe import preserves newer progress and completed sessions while adding records and recoverable old text', async t => {
  const app = await harness(t);
  ok(await note(app, '较新的本地笔记', ''));
  const practice = await session(app);
  ok(await app.request(`/sessions/${practice.id}/check`, { questionId: q1, answer: ['A'], expectedAnswer: [] }));
  ok(await app.request(`/sessions/${practice.id}/finish`, { expectedAnswers: { [q1]: ['A'] } }));
  const backup = ok(await app.request('/export'));
  backup.progress[q1].note = '旧备份笔记';
  backup.progress[q1].attempts = 0;
  backup.progress[q1].correctCount = 0;
  backup.progress[q2] = { note: '新增题目笔记' };
  backup.sessions[0] = { ...backup.sessions[0], status: 'active', answers: {}, submittedQuestionIds: [] };
  // This fixture deliberately models an older ungraded backup, so it has no grading snapshot.
  delete backup.sessions[0].gradedResults;
  backup.sessions.push({ ...backup.sessions[0], id: 'new-session-from-backup', questionIds: [q2] });
  const imported = ok(await app.request('/import', backup));
  assert.equal(imported.progressCount, 1);
  assert.equal(imported.sessionCount, 1);
  assert.equal(imported.skippedProgressCount, 1);
  assert.equal(imported.skippedSessionCount, 1);
  assert.equal(imported.conflictCount, 2);
  const boot = ok(await app.request('/bootstrap'));
  assert.equal(boot.progress[q1].note, '较新的本地笔记');
  assert.equal(boot.progress[q1].attempts, 1);
  assert.equal(boot.progress[q2].note, '新增题目笔记');
  assert.equal(boot.sessions.find(item => item.id === practice.id).status, 'completed');
  assert.ok((await history(app)).some(entry => entry.text === '旧备份笔记' && entry.source === 'import-conflict'));
  const beforeRepeat = await history(app);
  ok(await app.request('/import', backup));
  assert.deepEqual(await history(app), beforeRepeat, 'reimporting the same old text must not manufacture duplicate conflict history');
  const snapshots = (await readdir(app.dataDir)).filter(name => name.startsWith('before-import-'));
  assert.equal(snapshots.length, 2);
  await app.restart();
  assert.equal((await progress(app))[q1].note, '较新的本地笔记');
});

test('invalid imported progress and text are rejected without altering the state file or creating a snapshot', async t => {
  const app = await harness(t);
  ok(await note(app, '不可清空的笔记', ''));
  const before = await readFile(join(app.dataDir, 'learning-state.json'), 'utf8');
  const base = { app: 'yankao-study', version: 1, sessions: [] };
  for (const invalid of [null, [], { note: null }, { favorite: 'false' }, { attempts: -1 }, { lastAnswer: ['unknown'] }, { lastAnsweredAt: 'bad-date' }]) {
    assert.equal((await app.request('/import', { ...base, progress: { [q1]: invalid } })).status, 400, JSON.stringify(invalid));
  }
  assert.equal((await app.request('/import', { ...base, progress: { [q1]: { note: '大'.repeat(10001) } } })).status, 413);
  assert.equal(await readFile(join(app.dataDir, 'learning-state.json'), 'utf8'), before);
  assert.deepEqual((await readdir(app.dataDir)).filter(name => name.startsWith('before-import-')), []);
});

test('history is exported and merged into a fresh profile without deleting either profile history', async t => {
  const source = await harness(t);
  ok(await note(source, '源档案第一版', ''));
  ok(await note(source, '源档案第二版', '源档案第一版'));
  const backup = ok(await source.request('/export'));
  assert.ok(backup.textHistory.some(entry => entry.text === '源档案第一版'));
  const target = await harness(t);
  ok(await appNoteForSecondQuestion(target));
  const existing = await history(target, q2);
  ok(await target.request('/import', backup));
  assert.equal((await progress(target))[q1].note, '源档案第二版');
  assert.ok((await history(target)).some(entry => entry.text === '源档案第一版'));
  assert.deepEqual(await history(target, q2), existing);
  await target.restart();
  assert.ok((await history(target)).some(entry => entry.text === '源档案第一版'));
});

test('reimporting a colliding history id retains both texts once even after restart', async t => {
  const app = await harness(t);
  const original = { id: 'shared-history-id', questionId: q1, field: 'note', text: '本地同编号的原始正文', createdAt: '2026-01-01T00:00:00.000Z', source: 'fixture' };
  const incoming = { ...original, text: '外部同编号的不同完整正文' };
  const backup = entries => ({ app: 'yankao-study', version: 1, progress: {}, sessions: [], textHistory: entries });
  ok(await app.request('/import', backup([original])));
  ok(await app.request('/import', backup([incoming, incoming])));
  const first = await history(app);
  assert.equal(first.length, 2);
  assert.equal(first.find(entry => entry.id === original.id).text, original.text);
  assert.equal(first.filter(entry => entry.text === incoming.text).length, 1);
  ok(await app.request('/import', backup([incoming])));
  assert.deepEqual(await history(app), first);
  await app.restart();
  ok(await app.request('/import', backup([incoming])));
  assert.deepEqual(await history(app), first);
  const otherVersion = { ...incoming, text: '外部同编号的另一份真实正文' };
  ok(await app.request('/import', backup([otherVersion])));
  assert.equal((await history(app)).length, 3);
  assert.ok((await history(app)).some(entry => entry.text === otherVersion.text));
});

test('history for a question missing from the current bank remains intact on startup and export', async t => {
  const app = await harness(t);
  ok(await note(app, '当前题目笔记', ''));
  const path = join(app.dataDir, 'learning-state.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  const orphan = { id: 'orphan-history-id', questionId: 'not-in-current-bank', field: 'note', text: '旧题库题目的历史正文', createdAt: '2025-01-01T00:00:00.000Z', source: 'fixture' };
  saved.textHistory.push(orphan);
  await writeFile(path, JSON.stringify(saved));
  await app.restart();
  const exported = ok(await app.request('/export'));
  assert.deepEqual(exported.textHistory.find(entry => entry.id === orphan.id), orphan);
  assert.equal((await app.request('/questions/not-in-current-bank/history')).status, 404);
  assert.equal((await progress(app))[q1].note, '当前题目笔记');
});

async function appNoteForSecondQuestion(app) { return note(app, '目标档案独立笔记', '', q2); }

test('invalid session timestamps and cursor positions are rejected rather than silently rewritten during import', async t => {
  const app = await harness(t);
  ok(await app.request('/sessions', { mode: 'sequential', questionIds: [q1], count: 1 }));
  const backup = ok(await app.request('/export'));
  const before = await readFile(join(app.dataDir, 'learning-state.json'), 'utf8');
  const valid = backup.sessions[0];
  for (const invalid of [
    { ...valid, createdAt: 'bad-date' }, { ...valid, createdAt: null },
    { ...valid, cursor: -1 }, { ...valid, cursor: 1.5 }, { ...valid, cursor: '0' },
    { ...valid, cursor: 99 }, { ...valid, status: 'completed', finishedAt: 'bad-date' },
  ]) {
    assert.equal((await app.request('/import', { ...backup, sessions: [invalid] })).status, 400);
    assert.equal(await readFile(join(app.dataDir, 'learning-state.json'), 'utf8'), before);
  }
  assert.deepEqual((await readdir(app.dataDir)).filter(name => name.startsWith('before-import-')), []);
});

test('an imported exam requires a string deadline and native export timestamps remain compatible', async t => {
  const app = await harness(t);
  await session(app, { mode: 'exam' });
  const backup = ok(await app.request('/export'));
  const before = await readFile(join(app.dataDir, 'learning-state.json'), 'utf8');
  const valid = backup.sessions[0];
  for (const deadlineAt of [0, 1, 1735689600000, false, true, null, [], {}]) {
    assert.equal((await app.request('/import', { ...backup, sessions: [{ ...valid, deadlineAt }] })).status, 400, JSON.stringify(deadlineAt));
    assert.equal(await readFile(join(app.dataDir, 'learning-state.json'), 'utf8'), before);
  }
  const legacy = { ...valid, id: 'valid-exam-without-optional-cursor' };
  delete legacy.cursor;
  const imported = ok(await app.request('/import', { ...backup, sessions: [legacy] }));
  assert.equal(imported.sessionCount, 1);
  const restored = ok(await app.request(`/sessions/${legacy.id}`));
  assert.equal(restored.deadlineAt, valid.deadlineAt);
  assert.equal(restored.createdAt, valid.createdAt);
  assert.equal(restored.cursor, 0);
});

test('an oversized API explanation is rejected without truncating or replacing the saved explanation', async t => {
  const app = await harness(t, { fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '字'.repeat(20001) } }] }) }) });
  await configureApi(app);
  ok(await aiNote(app, '已有完整解析', ''));
  const before = await history(app);
  assert.equal((await app.request('/ai/explain', { questionId: q1 })).status, 413);
  assert.equal((await progress(app))[q1].aiNote, '已有完整解析');
  assert.deepEqual(await history(app), before);
});

test('a backup larger than four megabytes round-trips with all history while ordinary requests keep their smaller limit', async t => {
  const source = await harness(t);
  const seed = {
    app: 'yankao-study', version: 1, progress: { [q1]: { note: '大历史备份当前笔记' } }, sessions: [],
    textHistory: Array.from({ length: 220 }, (_, index) => ({ id: `large-history-${index}`, questionId: q1, field: 'aiNote', text: '史'.repeat(20000), createdAt: '2026-01-01T00:00:00.000Z', source: 'fixture' })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(seed)) > 4 * 1024 * 1024);
  ok(await source.request('/import', seed));
  const exported = ok(await source.request('/export'));
  const target = await harness(t);
  ok(await target.request('/import', exported));
  await target.restart();
  const roundTrip = ok(await target.request('/export'));
  assert.equal(roundTrip.progress[q1].note, '大历史备份当前笔记');
  assert.equal(roundTrip.textHistory.length, seed.textHistory.length);
  assert.equal(roundTrip.textHistory.at(-1).text, seed.textHistory.at(-1).text);
  const chunk = Buffer.alloc(4 * 1024 * 1024, 32);
  const ordinary = await target.requestChunks('/sessions', [chunk, Buffer.from(' ')]);
  assert.equal(ordinary.status, 413);
  assert.match(ordinary.body.error, /4MB/);
  const excessiveImport = await target.requestChunks('/import', Array(17).fill(chunk));
  assert.equal(excessiveImport.status, 413);
  assert.match(excessiveImport.body.error, /64MB/);
});
