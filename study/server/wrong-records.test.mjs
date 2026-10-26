import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStudyApi } from './api.mjs';

const questions = Array.from({ length: 502 }, (_, index) => ({
  id: `wrong-record-${index}`, type: 'single', category: '独立测试', chapter: '错题本', knowledgePoint: '可恢复移除', difficulty: '基础',
  stem: `第${index}道独立测试题`, options: [{ id: 'A', text: '正确选项' }, { id: 'B', text: '错误选项' }], answer: ['A'], explanation: '用于验证数据保护。', source: '原创测试夹具',
}));
const [q1, q2, q3] = questions.map(question => question.id);
const baseline = progress => ({ wrongRemoved: progress.wrongRemoved ?? false, wrongCount: progress.wrongCount, lastAnsweredAt: progress.lastAnsweredAt ?? null });
const item = (questionId, progress) => ({ questionId, expected: baseline(progress) });
const seedProgress = (overrides = {}) => ({ attempts: 4, correctCount: 1, wrongCount: 3, wrongRemoved: false, lastAnswer: ['B'], lastCorrect: false, lastAnsweredAt: '2026-01-01T00:00:00.000Z', mastered: false, favorite: true, note: '完整学习笔记', reason: '完整错因', aiNote: '完整 AI 解析', ...overrides });
const seedState = () => ({ version: 1, questionRecords: {}, progress: { [q1]: seedProgress(), [q2]: seedProgress({ wrongCount: 2 }), [q3]: seedProgress({ wrongCount: 1 }) }, sessions: [{ id: 'preserved-completed-session', mode: 'sequential', status: 'completed', questionIds: [q1], answers: { [q1]: ['B'] }, submittedQuestionIds: [q1], cursor: 0, createdAt: '2025-12-31T00:00:00.000Z', finishedAt: '2026-01-01T00:00:00.000Z', deadlineAt: null, correctCount: 0, score: 0, removed: false, revision: 0 }], textHistory: [{ id: 'preserved-history', questionId: q1, field: 'note', text: '完整旧笔记', source: 'manual', createdAt: '2025-12-31T00:00:00.000Z' }] });
const hash = text => createHash('sha256').update(text).digest('hex');
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
function ok(response) { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; }

async function harness(t, initial = seedState()) {
  const directory = await mkdtemp(join(tmpdir(), 'yankao-wrong-records-test-'));
  const dataDir = join(directory, 'state');
  const questionsPath = join(directory, 'questions.json');
  const statePath = join(dataDir, 'learning-state.json');
  await mkdir(dataDir);
  await writeFile(questionsPath, JSON.stringify(questions));
  await writeFile(statePath, JSON.stringify(initial));
  let api, server, base;
  async function start() {
    api = createStudyApi({ dataDir, questionsPath });
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
    assert.ok(owned.startsWith(resolve(tmpdir()) + sep) && owned.split(sep).at(-1).startsWith('yankao-wrong-records-test-'));
    await rm(owned, { recursive: true, force: true });
  });
  await start();
  return {
    dataDir, statePath,
    async request(path, body, method = body === undefined ? 'GET' : 'POST') {
      // Requests must carry the baseline that their actual caller observed.
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async delayedBatch(body, bodyReady, release) {
      const req = { url: '/study-api/wrong-records/batch', method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { bodyReady.resolve(); await release.promise; yield Buffer.from(JSON.stringify(body)); } };
      let text;
      const res = { statusCode: 200, setHeader() {}, end(value) { text = value; } };
      await api.handle(req, res);
      return { status: res.statusCode, body: JSON.parse(text) };
    },
    async bytes() { return readFile(statePath, 'utf8'); },
    async restart() { await stop(); await start(); },
  };
}

test('selected wrong records can be removed and restored without losing any other learning data', async t => {
  const initial = seedState();
  const app = await harness(t, initial);
  const removed = ok(await app.request('/wrong-records/batch', { removed: true, items: [item(q1, initial.progress[q1]), item(q2, initial.progress[q2])] }));
  assert.equal(removed.changedCount, 2);
  assert.deepEqual(Object.keys(removed.progress).sort(), [q1, q2].sort());
  assert.equal(removed.progress[q1].wrongRemoved, true);
  const persisted = JSON.parse(await app.bytes());
  const expected = structuredClone(initial);
  expected.progress[q1].wrongRemoved = true;
  expected.progress[q2].wrongRemoved = true;
  delete persisted.updatedAt;
  assert.deepEqual(persisted, expected);
  await app.restart();
  assert.equal(ok(await app.request('/bootstrap')).progress[q1].wrongRemoved, true);
  const restored = ok(await app.request('/wrong-records/batch', { removed: false, items: [item(q1, removed.progress[q1]), item(q2, removed.progress[q2])] }));
  assert.equal(restored.changedCount, 2);
  assert.deepEqual(restored.progress[q1], initial.progress[q1]);
  const exported = ok(await app.request('/export'));
  assert.deepEqual(exported.progress, initial.progress);
  assert.deepEqual(exported.sessions, initial.sessions);
  assert.deepEqual(exported.textHistory, initial.textHistory);
});

test('wrong practice excludes removed records while ordinary practice still includes them', async t => {
  const initial = seedState();
  initial.progress[q2].mastered = true;
  const app = await harness(t, initial);
  ok(await app.request('/wrong-records/batch', { removed: true, items: [item(q1, initial.progress[q1])] }));
  const wrong = ok(await app.request('/sessions', { mode: 'wrong', count: 500 }));
  assert.deepEqual(wrong.questionIds, [q3]);
  assert.deepEqual(Object.keys(ok(await app.request('/bootstrap')).progress).sort(), [q1, q2, q3].sort(), 'filtering must not create empty progress for the whole bank');
  const normal = ok(await app.request('/sessions', { mode: 'sequential', questionIds: [q1], count: 1 }));
  assert.deepEqual(normal.questionIds, [q1]);
});

test('a new incorrect practice answer restores the record, and a correct answer keeps it removed', async t => {
  const initial = seedState();
  initial.progress[q1].wrongRemoved = true;
  initial.progress[q2].wrongRemoved = true;
  const app = await harness(t, initial);
  const practice = ok(await app.request('/sessions', { mode: 'sequential', questionIds: [q1, q2], count: 2 }));
  const correct = ok(await app.request(`/sessions/${practice.id}/check`, { questionId: q1, answer: ['A'], expectedAnswer: [] }));
  assert.equal(correct.progress.wrongRemoved, true);
  const wrong = ok(await app.request(`/sessions/${practice.id}/check`, { questionId: q2, answer: ['B'], expectedAnswer: [] }));
  assert.equal(wrong.progress.wrongRemoved, false);
  assert.equal(wrong.progress.wrongCount, initial.progress[q2].wrongCount + 1);
  assert.equal(wrong.progress.note, initial.progress[q2].note);
  const repeat = ok(await app.request(`/sessions/${practice.id}/check`, { questionId: q2, answer: ['B'], expectedAnswer: ['B'] }));
  assert.equal(repeat.progress.wrongCount, wrong.progress.wrongCount);
});

test('an incorrect or unanswered exam question restores a removed record on grading', async t => {
  const initial = seedState();
  initial.progress[q1].wrongRemoved = true;
  const app = await harness(t, initial);
  const exam = ok(await app.request('/sessions', { mode: 'exam', questionIds: [q1], count: 1 }));
  ok(await app.request(`/sessions/${exam.id}/finish`, { expectedAnswers: {} }));
  const progress = ok(await app.request('/bootstrap')).progress[q1];
  assert.equal(progress.wrongRemoved, false);
  assert.equal(progress.wrongCount, initial.progress[q1].wrongCount + 1);
});

test('replaying an already graded check or finish cannot restore a subsequently removed wrong record', async t => {
  const initial = seedState();
  const app = await harness(t, initial);
  const practice = ok(await app.request('/sessions', { mode: 'sequential', questionIds: [q1], count: 1 }));
  const checked = ok(await app.request(`/sessions/${practice.id}/check`, { questionId: q1, answer: ['B'], expectedAnswer: [] }));
  ok(await app.request('/wrong-records/batch', { removed: true, items: [item(q1, checked.progress)] }));
  const removed = ok(await app.request('/bootstrap')).progress[q1];
  assert.equal(removed.wrongRemoved, true);
  const repeat = ok(await app.request(`/sessions/${practice.id}/check`, { questionId: q1, answer: ['B'], expectedAnswer: ['B'] }));
  assert.deepEqual(repeat.progress, removed);
  ok(await app.request(`/sessions/${practice.id}/finish`, { expectedAnswers: { [q1]: ['B'] } }));
  assert.deepEqual(ok(await app.request('/bootstrap')).progress[q1], removed);
  ok(await app.request(`/sessions/${practice.id}/finish`, {}));
  assert.deepEqual(ok(await app.request('/bootstrap')).progress[q1], removed);
});

test('any stale selected baseline rejects the entire batch and provides current records for refresh', async t => {
  const initial = seedState();
  const app = await harness(t, initial);
  const before = hash(await app.bytes());
  for (const stale of [{ wrongRemoved: true }, { wrongCount: 1 }, { lastAnsweredAt: null }]) {
    const response = await app.request('/wrong-records/batch', { removed: true, items: [item(q1, initial.progress[q1]), { questionId: q2, expected: { ...baseline(initial.progress[q2]), ...stale } }] });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'WRITE_CONFLICT');
    assert.deepEqual(response.body.current, { [q1]: initial.progress[q1], [q2]: initial.progress[q2] });
    assert.equal(hash(await app.bytes()), before);
    assert.equal(ok(await app.request('/bootstrap')).progress[q1].wrongRemoved, false);
  }
});

test('a fresh wrong answer arriving while the batch body is delayed invalidates the old baseline', async t => {
  const initial = seedState();
  const app = await harness(t, initial);
  const ready = deferred();
  const release = deferred();
  const pending = app.delayedBatch({ removed: true, items: [item(q1, initial.progress[q1]), item(q2, initial.progress[q2])] }, ready, release);
  await ready.promise;
  const practice = ok(await app.request('/sessions', { mode: 'sequential', questionIds: [q2], count: 1 }));
  ok(await app.request(`/sessions/${practice.id}/check`, { questionId: q2, answer: ['B'], expectedAnswer: [] }));
  const latest = hash(await app.bytes());
  release.resolve();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'WRITE_CONFLICT');
  assert.equal(response.body.current[q2].wrongCount, initial.progress[q2].wrongCount + 1);
  assert.equal(hash(await app.bytes()), latest);
});

test('every selected item must carry all three explicit baseline fields', async t => {
  const initial = seedState();
  const app = await harness(t, initial);
  const before = hash(await app.bytes());
  const incomplete = [{ questionId: q2 }, ...Object.keys(baseline(initial.progress[q2])).map(key => {
    const expected = baseline(initial.progress[q2]); delete expected[key]; return { questionId: q2, expected };
  })];
  for (const missing of incomplete) {
    const response = await app.request('/wrong-records/batch', { removed: true, items: [item(q1, initial.progress[q1]), missing] });
    assert.equal(response.status, 428);
    assert.equal(response.body.code, 'PRECONDITION_REQUIRED');
    assert.deepEqual(response.body.current, { [q1]: initial.progress[q1], [q2]: initial.progress[q2] });
    assert.equal(hash(await app.bytes()), before);
  }
});

test('malformed batch values, duplicate or unknown IDs, and records without wrong answers change nothing', async t => {
  const initial = seedState();
  initial.progress[q3].wrongCount = 0;
  const app = await harness(t, initial);
  const before = hash(await app.bytes());
  const valid = item(q1, initial.progress[q1]);
  const invalidBodies = [
    {}, { removed: 'true', items: [valid] }, { removed: true }, { removed: true, items: [] }, { removed: true, items: {} },
    { removed: true, items: [null] }, { removed: true, items: [{ questionId: 1, expected: valid.expected }] },
    { removed: true, items: [valid, valid] }, { removed: true, items: [valid, { ...valid, questionId: 'unknown-question' }] },
    { removed: true, items: [valid, item(q3, initial.progress[q3])] }, { removed: false, items: [item(q3, initial.progress[q3])] },
    ...[null, [], 'baseline'].map(expected => ({ removed: true, items: [valid, { questionId: q2, expected }] })),
    ...[{ wrongRemoved: 'false' }, { wrongRemoved: null }, { wrongCount: '2' }, { wrongCount: -1 }, { wrongCount: 1.5 }, { wrongCount: Number.MAX_SAFE_INTEGER + 1 }, { lastAnsweredAt: 0 }, { lastAnsweredAt: false }, { lastAnsweredAt: 'invalid-date' }].map(bad => ({ removed: true, items: [valid, { questionId: q2, expected: { ...baseline(initial.progress[q2]), ...bad } }] })),
  ];
  for (const body of invalidBodies) {
    const response = await app.request('/wrong-records/batch', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(hash(await app.bytes()), before);
  }
});

test('at most 500 unique wrong records are accepted in a single atomic batch', async t => {
  const initial = seedState();
  initial.progress = Object.fromEntries(questions.slice(0, 501).map(question => [question.id, seedProgress()]));
  const app = await harness(t, initial);
  const items = Object.entries(initial.progress).map(([id, progress]) => item(id, progress));
  const before = hash(await app.bytes());
  assert.equal((await app.request('/wrong-records/batch', { removed: true, items })).status, 400);
  assert.equal(hash(await app.bytes()), before);
  const result = ok(await app.request('/wrong-records/batch', { removed: true, items: items.slice(0, 500) }));
  assert.equal(result.changedCount, 500);
  assert.equal(Object.keys(result.progress).length, 500);
  assert.equal(ok(await app.request('/bootstrap')).progress[questions[500].id].wrongRemoved, false);
});

test('same-state requests remain idempotent only with an exact matching baseline', async t => {
  const initial = seedState();
  const app = await harness(t, initial);
  const first = ok(await app.request('/wrong-records/batch', { removed: true, items: [item(q1, initial.progress[q1])] }));
  const before = hash(await app.bytes());
  const repeat = ok(await app.request('/wrong-records/batch', { removed: true, items: [item(q1, first.progress[q1])] }));
  assert.equal(repeat.changedCount, 0);
  assert.equal(hash(await app.bytes()), before);
  assert.equal((await app.request('/wrong-records/batch', { removed: true, items: [item(q1, initial.progress[q1])] })).status, 409);
  assert.equal(hash(await app.bytes()), before);
});

test('a failed batch disk write rolls back all in-memory and durable changes', async t => {
  const initial = seedState();
  const app = await harness(t, initial);
  const before = hash(await app.bytes());
  const saved = `${app.statePath}.test-backup`;
  await rename(app.statePath, saved);
  await mkdir(app.statePath);
  try {
    const response = await app.request('/wrong-records/batch', { removed: true, items: [item(q1, initial.progress[q1]), item(q2, initial.progress[q2])] });
    assert.equal(response.status, 500);
    assert.deepEqual(ok(await app.request('/bootstrap')).progress, initial.progress);
  } finally { await rmdir(app.statePath); await rename(saved, app.statePath); }
  assert.equal(hash(await app.bytes()), before);
  await app.restart();
  assert.deepEqual(ok(await app.request('/bootstrap')).progress, initial.progress);
});

test('legacy state and backups default missing removal flags to false while invalid imported flags are rejected', async t => {
  const initial = seedState();
  delete initial.progress[q1].wrongRemoved;
  const app = await harness(t, initial);
  const before = hash(await app.bytes());
  assert.equal(ok(await app.request('/bootstrap')).progress[q1].wrongRemoved, false);
  assert.equal(hash(await app.bytes()), before, 'reading legacy state must not rewrite its file');
  const target = await harness(t, { version: 1, progress: {}, sessions: [] });
  const backup = { app: 'yankao-study', version: 1, progress: initial.progress, sessions: [] };
  for (const wrongRemoved of [null, 'false', 0, {}, []]) {
    const invalid = structuredClone(backup); invalid.progress[q1].wrongRemoved = wrongRemoved;
    assert.equal((await target.request('/import', invalid)).status, 400);
  }
  ok(await target.request('/import', backup));
  assert.equal(ok(await target.request('/bootstrap')).progress[q1].wrongRemoved, false);
  const removed = ok(await target.request('/wrong-records/batch', { removed: true, items: [item(q1, initial.progress[q1])] }));
  assert.equal(removed.changedCount, 1);
  const roundTrip = await harness(t, { version: 1, progress: {}, sessions: [] });
  ok(await roundTrip.request('/import', ok(await target.request('/export'))));
  await roundTrip.restart();
  assert.equal(ok(await roundTrip.request('/bootstrap')).progress[q1].wrongRemoved, true);
});
