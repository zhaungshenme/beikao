import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStudyApi } from './api.mjs';

const questions = Array.from({ length: 501 }, (_, index) => ({
  id: `mastery-${index}`, type: 'single', category: '测试', chapter: '错题掌握', difficulty: '基础', knowledgePoint: '掌握状态',
  stem: `错题掌握测试 ${index}`, options: [{ id: 'A', text: '正确选项' }, { id: 'B', text: '错误选项' }], answer: ['A'], explanation: '独立测试夹具。', source: '自动化测试',
}));
const [q1, q2, q3] = questions.map(question => question.id);
const progress = (patch = {}) => ({ attempts: 3, correctCount: 1, wrongCount: 2, wrongRemoved: false, mastered: false,
  lastAnswer: ['B'], lastCorrect: false, lastAnsweredAt: '2026-01-01T00:00:00.000Z', favorite: true, note: '完整笔记', reason: '完整错因', aiNote: '完整AI解析', ...patch });
const initial = () => ({ version: 1, progress: { [q1]: progress(), [q2]: progress(), [q3]: progress({ wrongCount: 0 }) },
  questionRecords: {}, sessions: [], textHistory: [{ id: 'preserved-history', questionId: q1, field: 'note', text: '旧笔记', source: 'manual', createdAt: '2025-01-01T00:00:00.000Z' }] });
const item = (id, value) => ({ questionId: id, expected: { mastered: value.mastered, wrongRemoved: value.wrongRemoved,
  wrongCount: value.wrongCount, lastAnsweredAt: value.lastAnsweredAt } });
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }

async function harness(t, seed = initial()) {
  const directory = await mkdtemp(join(tmpdir(), 'yankao-wrong-mastery-'));
  const dataDir = join(directory, 'state');
  const questionsPath = join(directory, 'questions.json');
  const statePath = join(dataDir, 'learning-state.json');
  await mkdir(dataDir);
  await writeFile(questionsPath, JSON.stringify(questions));
  await writeFile(statePath, JSON.stringify(seed));
  let api, server, base;
  async function start() {
    api = createStudyApi({ dataDir, questionsPath });
    server = createServer((req, res) => api.handle(req, res));
    await new Promise(accept => server.listen(0, '127.0.0.1', accept));
    base = `http://127.0.0.1:${server.address().port}/study-api`;
  }
  async function stop() {
    if (!server?.listening) return;
    const closed = new Promise(accept => server.close(accept));
    server.closeAllConnections();
    await closed;
    api.close();
  }
  t.after(async () => {
    await stop();
    const owned = resolve(directory);
    assert.ok(owned.startsWith(resolve(tmpdir()) + sep) && owned.split(sep).at(-1).startsWith('yankao-wrong-mastery-'));
    await rm(owned, { recursive: true, force: true });
  });
  await start();
  return {
    statePath,
    async request(path, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async delayedMastery(body, ready, release) {
      const req = { url: '/study-api/wrong-records/mastery', method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json' },
        async *[Symbol.asyncIterator]() { ready.resolve(); await release.promise; yield Buffer.from(JSON.stringify(body)); } };
      let text;
      const res = { statusCode: 200, setHeader() {}, end(value) { text = value; } };
      await api.handle(req, res);
      return { status: res.statusCode, body: JSON.parse(text) };
    },
    async bytes() { return readFile(statePath, 'utf8'); },
    async restart() { await stop(); await start(); },
  };
}

test('single and batch mastery only change mastered while preserving answers, counts, text and histories', async t => {
  const seed = initial();
  const app = await harness(t, seed);
  const single = ok(await app.request('/wrong-records/mastery', { mastered: true, items: [item(q1, seed.progress[q1])] }));
  assert.equal(single.changedCount, 1);
  assert.deepEqual(single.progress[q1], { ...seed.progress[q1], mastered: true });
  const batch = ok(await app.request('/wrong-records/mastery', { mastered: true, items: [item(q1, single.progress[q1]), item(q2, seed.progress[q2])] }));
  assert.equal(batch.changedCount, 1);
  const actual = JSON.parse(await app.bytes());
  const expected = structuredClone(seed);
  expected.progress[q1].mastered = true;
  expected.progress[q2].mastered = true;
  delete actual.updatedAt;
  assert.deepEqual(actual, expected);
  await app.restart();
  assert.equal(ok(await app.request('/bootstrap')).progress[q2].mastered, true);
});

test('mastered records can be returned to pending and a fresh identical target is a disk-free no-op', async t => {
  const seed = initial();
  seed.progress[q1].mastered = true;
  const app = await harness(t, seed);
  const back = ok(await app.request('/wrong-records/mastery', { mastered: false, items: [item(q1, seed.progress[q1])] }));
  assert.deepEqual(back.progress[q1], { ...seed.progress[q1], mastered: false });
  const before = await app.bytes();
  const same = ok(await app.request('/wrong-records/mastery', { mastered: false, items: [item(q1, back.progress[q1])] }));
  assert.equal(same.changedCount, 0);
  assert.equal(await app.bytes(), before);
});

test('every changed baseline field rejects the entire batch including an identical current target', async t => {
  const seed = initial();
  const app = await harness(t, seed);
  const before = await app.bytes();
  for (const patch of [{ mastered: true }, { wrongRemoved: true }, { wrongCount: 1 }, { lastAnsweredAt: null }]) {
    const stale = { ...item(q2, seed.progress[q2]), expected: { ...item(q2, seed.progress[q2]).expected, ...patch } };
    for (const mastered of [true, false]) {
      const response = await app.request('/wrong-records/mastery', { mastered, items: [item(q1, seed.progress[q1]), stale] });
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'WRITE_CONFLICT');
      assert.deepEqual(response.body.current, { [q1]: seed.progress[q1], [q2]: seed.progress[q2] });
      assert.equal(await app.bytes(), before);
    }
  }
});

test('a newly wrong answer that leaves mastered false invalidates a delayed old mastery request', async t => {
  const seed = initial();
  const app = await harness(t, seed);
  const ready = deferred();
  const release = deferred();
  const pending = app.delayedMastery({ mastered: true, items: [item(q1, seed.progress[q1]), item(q2, seed.progress[q2])] }, ready, release);
  await ready.promise;
  const practice = ok(await app.request('/sessions', { mode: 'sequential', questionIds: [q2], count: 1 }));
  ok(await app.request(`/sessions/${practice.id}/check`, { questionId: q2, answer: ['B'], expectedAnswer: [] }));
  const before = await app.bytes();
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.current[q2].mastered, false);
  assert.equal(result.body.current[q2].wrongCount, seed.progress[q2].wrongCount + 1);
  assert.equal(await app.bytes(), before);
  assert.equal(ok(await app.request('/bootstrap')).progress[q1].mastered, false);
});

test('all four baseline fields are mandatory and malformed batches change nothing', async t => {
  const seed = initial();
  const app = await harness(t, seed);
  const valid = item(q1, seed.progress[q1]);
  const before = await app.bytes();
  for (const field of Object.keys(valid.expected)) {
    const missing = structuredClone(valid);
    delete missing.expected[field];
    assert.equal((await app.request('/wrong-records/mastery', { mastered: true, items: [missing] })).status, 428);
  }
  assert.equal((await app.request('/wrong-records/mastery', { mastered: true, items: [{ questionId: q1 }] })).status, 428);
  const bodies = [
    {}, { mastered: 'true', items: [valid] }, { mastered: true }, { mastered: true, items: [] }, { mastered: true, items: {} },
    { mastered: true, items: [null] }, { mastered: true, items: [valid, valid] },
    { mastered: true, items: [{ ...valid, questionId: 'unknown' }] },
    { mastered: true, items: [item(q3, seed.progress[q3])] },
    { mastered: true, items: Array.from({ length: 501 }, (_, index) => item(questions[index].id, seed.progress[q1])) },
    ...[null, [], 'baseline'].map(expected => ({ mastered: true, items: [{ questionId: q1, expected }] })),
    ...[{ mastered: 1 }, { wrongRemoved: 'false' }, { wrongCount: -1 }, { wrongCount: 1.2 }, { lastAnsweredAt: 'invalid' }]
      .map(patch => ({ mastered: true, items: [{ questionId: q1, expected: { ...valid.expected, ...patch } }] })),
  ];
  for (const body of bodies) assert.equal((await app.request('/wrong-records/mastery', body)).status, 400, JSON.stringify(body));
  assert.equal(await app.bytes(), before);
});

test('removed wrong records and removed bank questions cannot be marked mastered', async t => {
  const seed = initial();
  seed.progress[q1].wrongRemoved = true;
  seed.questionRecords[q2] = { removed: true, revision: 1 };
  const app = await harness(t, seed);
  const before = await app.bytes();
  for (const id of [q1, q2]) {
    const response = await app.request('/wrong-records/mastery', { mastered: true, items: [item(id, seed.progress[id])] });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'WRONG_RECORD_UNAVAILABLE');
  }
  assert.equal(await app.bytes(), before);
});

test('a failed batch save rolls back all mastery changes in memory and on disk before retry', async t => {
  const seed = initial();
  const app = await harness(t, seed);
  const before = await app.bytes();
  const held = app.statePath + '.held';
  const body = { mastered: true, items: [item(q1, seed.progress[q1]), item(q2, seed.progress[q2])] };
  await rename(app.statePath, held);
  await mkdir(app.statePath);
  try {
    assert.equal((await app.request('/wrong-records/mastery', body)).status, 500);
    const snapshot = ok(await app.request('/bootstrap'));
    assert.equal(snapshot.progress[q1].mastered, false);
    assert.equal(snapshot.progress[q2].mastered, false);
    assert.equal(await readFile(held, 'utf8'), before);
  } finally { await rmdir(app.statePath); await rename(held, app.statePath); }
  await app.restart();
  assert.equal(ok(await app.request('/wrong-records/mastery', body)).changedCount, 2);
  await app.restart();
  assert.equal(ok(await app.request('/bootstrap')).progress[q1].mastered, true);
});

test('wrong mode excludes mastered questions and an ordinary new wrong answer returns them to pending', async t => {
  const seed = initial();
  const app = await harness(t, seed);
  const marked = ok(await app.request('/wrong-records/mastery', { mastered: true, items: [item(q1, seed.progress[q1])] }));
  const filtered = ok(await app.request('/sessions', { mode: 'wrong', count: 500 }));
  assert.deepEqual(filtered.questionIds, [q2]);
  const ordinary = ok(await app.request('/sessions', { mode: 'sequential', questionIds: [q1], count: 1 }));
  const wrong = ok(await app.request(`/sessions/${ordinary.id}/check`, { questionId: q1, answer: ['B'], expectedAnswer: [] }));
  assert.equal(wrong.progress.mastered, false);
  assert.equal(wrong.progress.wrongRemoved, false);
  assert.equal(wrong.progress.wrongCount, marked.progress[q1].wrongCount + 1);
  assert.equal(wrong.progress.note, marked.progress[q1].note);
  assert.equal(wrong.progress.aiNote, marked.progress[q1].aiNote);
  const pending = ok(await app.request('/sessions', { mode: 'wrong', count: 500 }));
  assert.deepEqual(pending.questionIds, [q1, q2]);
  const remarked = ok(await app.request('/wrong-records/mastery', { mastered: true, items: [item(q1, wrong.progress)] }));
  const replay = ok(await app.request(`/sessions/${ordinary.id}/check`, { questionId: q1, answer: ['B'], expectedAnswer: ['B'] }));
  assert.deepEqual(replay.progress, remarked.progress[q1], 'replaying old grading must not clear a later mastery mark');
});

test('correct practice keeps mastery while an unanswered new exam resets it on grading', async t => {
  const seed = initial();
  seed.progress[q1].mastered = true;
  seed.progress[q2].mastered = true;
  const app = await harness(t, seed);
  const ordinary = ok(await app.request('/sessions', { mode: 'sequential', questionIds: [q1], count: 1 }));
  assert.equal(ok(await app.request(`/sessions/${ordinary.id}/check`, { questionId: q1, answer: ['A'], expectedAnswer: [] })).progress.mastered, true);
  const exam = ok(await app.request('/sessions', { mode: 'exam', questionIds: [q2], count: 1 }));
  ok(await app.request(`/sessions/${exam.id}/finish`, { expectedAnswers: {} }));
  const boot = ok(await app.request('/bootstrap'));
  assert.equal(boot.progress[q1].mastered, true);
  assert.equal(boot.progress[q2].mastered, false);
  assert.equal(boot.progress[q2].wrongCount, seed.progress[q2].wrongCount + 1);
});

test('old imports cannot undo a newer local mastery mark or a newer local pending state', async t => {
  const seed = initial();
  const app = await harness(t, seed);
  const pendingBackup = ok(await app.request('/export'));
  const marked = ok(await app.request('/wrong-records/mastery', { mastered: true, items: [item(q1, seed.progress[q1])] }));
  const masteredBackup = ok(await app.request('/export'));
  ok(await app.request('/import', pendingBackup));
  assert.equal(ok(await app.request('/bootstrap')).progress[q1].mastered, true);
  ok(await app.request('/wrong-records/mastery', { mastered: false, items: [item(q1, marked.progress[q1])] }));
  ok(await app.request('/import', masteredBackup));
  await app.restart();
  assert.equal(ok(await app.request('/bootstrap')).progress[q1].mastered, false);
});
