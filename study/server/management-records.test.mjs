import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStudyApi } from './api.mjs';

const questions = Array.from({ length: 502 }, (_, index) => ({ id: `managed-${index}`, type: 'single', category: '独立测试', chapter: '记录管理', knowledgePoint: '可恢复删除', difficulty: '基础', stem: `第${index}道记录管理测试题`, options: [{ id: 'A', text: '正确选项' }, { id: 'B', text: '错误选项' }], answer: ['A'], explanation: '仅用于验证记录保护。', source: '原创测试夹具' }));
const [q1, q2] = questions.map(question => question.id);
const originalProgress = () => ({ attempts: 3, correctCount: 1, wrongCount: 2, wrongRemoved: false, lastAnswer: ['B'], lastCorrect: false, lastAnsweredAt: '2026-01-01T00:00:00.000Z', mastered: false, favorite: true, note: '完整笔记', reason: '完整错因', aiNote: '完整解析' });
const originalState = () => ({ version: 1, progress: { [q1]: originalProgress(), [q2]: originalProgress() }, sessions: [], textHistory: [{ id: 'unchanged-history', questionId: q1, field: 'note', text: '旧笔记完整正文', source: 'manual', createdAt: '2025-12-31T00:00:00.000Z' }] });
const expected = record => ({ removed: record.removed, revision: record.revision });
const questionItem = (questionId, record = { removed: false, revision: 0 }) => ({ questionId, expected: expected(record) });
const sessionItem = session => ({ sessionId: session.id, expected: expected(session) });
const hash = text => createHash('sha256').update(text).digest('hex');
function ok(response) { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; }
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
const content = record => { const copy = structuredClone(record); delete copy.removed; delete copy.revision; return copy; };

async function harness(t, initial = originalState()) {
  const directory = await mkdtemp(join(tmpdir(), 'yankao-management-test-'));
  const dataDir = join(directory, 'state');
  const statePath = join(dataDir, 'learning-state.json');
  const questionsPath = join(directory, 'questions.json');
  await mkdir(dataDir);
  await writeFile(statePath, JSON.stringify(initial));
  await writeFile(questionsPath, JSON.stringify(questions));
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  let api, server, base;
  async function start() {
    api = createStudyApi({ allowLegacyWebBridge: true, dataDir, questionsPath, now: () => time });
    server = createServer((req, res) => api.handle(req, res));
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    base = `http://127.0.0.1:${server.address().port}/study-api`;
  }
  async function stop() {
    if (server?.listening) {
      const closed = new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
      server.closeAllConnections(); await closed;
    }
    api?.close();
  }
  t.after(async () => {
    await stop();
    const owned = resolve(directory);
    assert.ok(owned.startsWith(resolve(tmpdir()) + sep) && owned.split(sep).at(-1).startsWith('yankao-management-test-'));
    await rm(owned, { recursive: true, force: true });
  });
  await start();
  return {
    dataDir, statePath, questionsPath,
    advance(milliseconds) { time += milliseconds; },
    async bytes() { return readFile(statePath, 'utf8'); },
    async restart() { await stop(); await start(); },
    async request(path, body, method = body === undefined ? 'GET' : 'POST') {
      // No reads are inserted to replace a caller's original baseline.
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async delayed(path, body, ready, release, method = 'POST') {
      const req = { url: `/study-api${path}`, method, headers: { host: '127.0.0.1', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { ready.resolve(); await release.promise; yield Buffer.from(JSON.stringify(body)); } };
      let text;
      const res = { statusCode: 200, setHeader() {}, end(value) { text = value; } };
      await api.handle(req, res);
      return { status: res.statusCode, body: JSON.parse(text) };
    },
  };
}

async function createSession(app, overrides = {}) { return ok(await app.request('/sessions', { mode: 'sequential', questionIds: [q1, q2], count: 2, ...overrides })); }
async function questionBatch(app, removed, items) { return app.request('/question-records/batch', { removed, items }); }
async function sessionBatch(app, removed, sessions) { return app.request('/session-records/batch', { removed, items: sessions.map(sessionItem) }); }

test('legacy schema receives readable defaults without rewriting the original profile', async t => {
  const initial = originalState();
  initial.sessions.push({ id: 'legacy-practice', mode: 'sequential', questionIds: [q1], answers: {}, submittedQuestionIds: [], createdAt: '2025-12-31T00:00:00.000Z', deadlineAt: null, status: 'active', cursor: 0 });
  const app = await harness(t, initial);
  const before = hash(await app.bytes());
  const boot = ok(await app.request('/bootstrap'));
  assert.equal(boot.questions.length, questions.length);
  assert.deepEqual(boot.questionRecords[q1], { removed: false, revision: 0 });
  assert.equal(boot.sessions[0].removed, false);
  assert.equal(boot.sessions[0].revision, 0);
  assert.equal(boot.activeSession.id, 'legacy-practice');
  assert.equal(hash(await app.bytes()), before);
  assert.equal(ok(await app.request('/sessions/legacy-practice')).revision, 0);
  assert.equal(hash(await app.bytes()), before);
});

test('question removal and recovery preserve the original bank, learning content, and complete history', async t => {
  const initial = originalState();
  const app = await harness(t, initial);
  const bankHash = hash(await readFile(app.questionsPath, 'utf8'));
  const first = ok(await questionBatch(app, true, [questionItem(q1), questionItem(q2)]));
  assert.equal(first.changedCount, 2);
  assert.deepEqual(first.questionRecords, { [q1]: { removed: true, revision: 1 }, [q2]: { removed: true, revision: 1 } });
  assert.equal(hash(await readFile(app.questionsPath, 'utf8')), bankHash);
  let backup = ok(await app.request('/export'));
  assert.deepEqual(backup.progress, initial.progress);
  assert.deepEqual(backup.textHistory, initial.textHistory);
  await app.restart();
  assert.deepEqual(ok(await app.request('/bootstrap')).questionRecords[q1], { removed: true, revision: 1 });
  const restored = ok(await questionBatch(app, false, [questionItem(q1, first.questionRecords[q1])]));
  assert.deepEqual(restored.questionRecords[q1], { removed: false, revision: 2 });
  backup = ok(await app.request('/export'));
  assert.deepEqual(backup.questionRecords[q1], { removed: false, revision: 2 }, 'restored metadata must remain a local state record');
  assert.deepEqual(backup.progress, initial.progress);
  assert.deepEqual(backup.textHistory, initial.textHistory);
});

test('all future practice modes exclude removed questions and explicit stale selections cannot fall back to the whole bank', async t => {
  const app = await harness(t);
  ok(await questionBatch(app, true, [questionItem(q1)]));
  for (const mode of ['sequential', 'random', 'exam', 'wrong', 'favorites']) {
    const session = ok(await app.request('/sessions', { mode, count: 500 }));
    assert.ok(session.questionIds.length > 0);
    assert.ok(!session.questionIds.includes(q1), mode);
  }
  const before = hash(await app.bytes());
  for (const questionIds of [[q1], [q1, q2]]) {
    const response = await app.request('/sessions', { mode: 'sequential', count: 500, questionIds });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'QUESTION_REMOVED');
    assert.equal(hash(await app.bytes()), before);
  }
  assert.equal((await app.request('/sessions', { mode: 'sequential', count: 500, questionIds: [] })).status, 400);
  assert.equal(hash(await app.bytes()), before);
});

test('an entirely removed question bank rejects every new mode without creating phantom learning records', async t => {
  const app = await harness(t);
  for (let index = 0; index < questions.length; index += 500) ok(await questionBatch(app, true, questions.slice(index, index + 500).map(question => questionItem(question.id))));
  const before = hash(await app.bytes());
  for (const mode of ['sequential', 'random', 'exam', 'wrong', 'favorites']) assert.equal((await app.request('/sessions', { mode, count: 1 })).status, 400);
  assert.equal(hash(await app.bytes()), before);
  assert.deepEqual(ok(await app.request('/bootstrap')).progress, originalState().progress);
});

test('existing sessions and AI work continue to resolve a question removed from future pools', async t => {
  const app = await harness(t);
  const practice = await createSession(app, { questionIds: [q1], count: 1 });
  ok(await questionBatch(app, true, [questionItem(q1)]));
  const saved = ok(await app.request(`/sessions/${practice.id}`, { questionId: q1, answer: ['A'], expectedAnswer: [] }, 'PATCH'));
  assert.equal(saved.revision, 1);
  const checked = ok(await app.request(`/sessions/${practice.id}/check`, { questionId: q1, answer: ['A'], expectedAnswer: ['A'] }));
  assert.equal(checked.correct, true);
  const finished = ok(await app.request(`/sessions/${practice.id}/finish`, { expectedAnswers: { [q1]: ['A'] } }));
  assert.equal(finished.session.score, 100);
  const job = ok(await app.request('/bridge/jobs', { questionId: q1 }));
  ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '删除题目后仍保留的完整解析' }));
  assert.equal(ok(await app.request('/bootstrap')).progress[q1].aiNote, '删除题目后仍保留的完整解析');
  assert.ok(ok(await app.request(`/questions/${q1}/history`)).entries.some(entry => entry.text === '完整解析'));
});

test('learning record removal hides continuation, preserves read access, and blocks every stale write including completed replay', async t => {
  const app = await harness(t);
  const older = await createSession(app);
  const newer = await createSession(app);
  const completed = ok(await app.request(`/sessions/${older.id}/finish`, { expectedAnswers: {} })).session;
  const beforeContent = ok(await app.request('/export'));
  const removed = ok(await sessionBatch(app, true, [completed, newer]));
  assert.equal(removed.changedCount, 2);
  assert.equal(ok(await app.request('/bootstrap')).activeSession, null);
  for (const record of removed.sessions) {
    assert.deepEqual(content(record), content(record.id === older.id ? completed : newer));
    assert.equal(ok(await app.request(`/sessions/${record.id}`)).removed, true);
    const before = hash(await app.bytes());
    for (const [suffix, body, method] of [['', { cursor: 1 }, 'PATCH'], ['/check', { questionId: q1, answer: ['A'], expectedAnswer: [] }, 'POST'], ['/finish', {}, 'POST']]) {
      const response = await app.request(`/sessions/${record.id}${suffix}`, body, method);
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'SESSION_REMOVED');
      assert.equal(response.body.current.id, record.id);
      assert.equal(hash(await app.bytes()), before);
    }
  }
  const restored = ok(await sessionBatch(app, false, removed.sessions));
  assert.equal(restored.changedCount, 2);
  assert.equal(ok(await app.request('/bootstrap')).activeSession.id, newer.id);
  const after = ok(await app.request('/export'));
  assert.deepEqual(after.progress, beforeContent.progress);
  assert.deepEqual(after.textHistory, beforeContent.textHistory);
  assert.deepEqual(content(restored.sessions[0]), content(completed));
});

test('session revisions advance once for each real mutation and remain unchanged for no-op or idempotent replay', async t => {
  const app = await harness(t);
  const session = await createSession(app);
  const path = `/sessions/${session.id}`;
  assert.equal(session.revision, 0);
  const initialHash = hash(await app.bytes());
  assert.equal(ok(await app.request(path, {}, 'PATCH')).revision, 0);
  assert.equal(hash(await app.bytes()), initialHash);
  assert.equal(ok(await app.request(path, { cursor: 1 }, 'PATCH')).revision, 1);
  const cursorHash = hash(await app.bytes());
  assert.equal(ok(await app.request(path, { cursor: 1 }, 'PATCH')).revision, 1);
  assert.equal(hash(await app.bytes()), cursorHash);
  assert.equal(ok(await app.request(path, { questionId: q1, answer: ['A'], expectedAnswer: [] }, 'PATCH')).revision, 2);
  assert.equal(ok(await app.request(path, { questionId: q1, answer: ['A'], expectedAnswer: ['A'] }, 'PATCH')).revision, 2);
  assert.equal(ok(await app.request(`${path}/check`, { questionId: q1, answer: ['A'], expectedAnswer: ['A'] })).session.revision, 3);
  assert.equal(ok(await app.request(`${path}/check`, { questionId: q1, answer: ['A'], expectedAnswer: ['A'] })).session.revision, 3);
  assert.equal(ok(await app.request(`${path}/finish`, { expectedAnswers: { [q1]: ['A'] } })).session.revision, 4);
  assert.equal(ok(await app.request(`${path}/finish`, {})).session.revision, 4);
});

test('deletion after a pending answer, check, or finish body prevents its old page from mutating the deleted session', async t => {
  for (const [suffix, body, method] of [['', { cursor: 1 }, 'PATCH'], ['/check', { questionId: q1, answer: ['B'], expectedAnswer: [] }, 'POST'], ['/finish', { expectedAnswers: {} }, 'POST']]) {
    const app = await harness(t);
    const session = await createSession(app);
    const ready = deferred(), release = deferred();
    const pending = app.delayed(`/sessions/${session.id}${suffix}`, body, ready, release, method);
    await ready.promise;
    ok(await sessionBatch(app, true, [session]));
    const deletedHash = hash(await app.bytes());
    release.resolve();
    const response = await pending;
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'SESSION_REMOVED');
    assert.equal(hash(await app.bytes()), deletedHash);
  }
});

test('new answers arriving while a batch body is delayed invalidate its old list version without partial deletion', async t => {
  const app = await harness(t);
  const first = await createSession(app), second = await createSession(app);
  const ready = deferred(), release = deferred();
  const pending = app.delayed('/session-records/batch', { removed: true, items: [sessionItem(first), sessionItem(second)] }, ready, release);
  await ready.promise;
  const changed = ok(await app.request(`/sessions/${second.id}`, { questionId: q1, answer: ['A'], expectedAnswer: [] }, 'PATCH'));
  const latestHash = hash(await app.bytes());
  release.resolve();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'WRITE_CONFLICT');
  assert.equal(response.body.current[first.id].removed, false);
  assert.equal(response.body.current[second.id].revision, changed.revision);
  assert.equal(hash(await app.bytes()), latestHash);
});

test('deletion and restoration reject ABA-stale versions and unchanged operations require matching baselines', async t => {
  const app = await harness(t);
  const session = await createSession(app);
  for (const kind of ['question', 'session']) {
    const path = `/${kind}-records/batch`;
    const firstItem = kind === 'question' ? questionItem(q1) : sessionItem(session);
    const getRecord = response => kind === 'question' ? response.questionRecords[q1] : response.sessions[0];
    const asItem = record => kind === 'question' ? questionItem(q1, record) : sessionItem(record);
    const deleted = getRecord(ok(await app.request(path, { removed: true, items: [firstItem] })));
    const deletedHash = hash(await app.bytes());
    assert.equal(ok(await app.request(path, { removed: true, items: [asItem(deleted)] })).changedCount, 0);
    assert.equal(hash(await app.bytes()), deletedHash);
    assert.equal((await app.request(path, { removed: true, items: [firstItem] })).status, 409);
    const restored = getRecord(ok(await app.request(path, { removed: false, items: [asItem(deleted)] })));
    assert.equal(restored.revision, 2);
    const restoredHash = hash(await app.bytes());
    const stale = await app.request(path, { removed: true, items: [firstItem] });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'WRITE_CONFLICT');
    assert.equal(hash(await app.bytes()), restoredHash);
  }
});

test('deleted exams skip automatic grading and restoration retains the original deadline and grades once', async t => {
  const app = await harness(t);
  const exam = await createSession(app, { mode: 'exam', questionIds: [q1], count: 1, minutes: 1 });
  const removed = ok(await sessionBatch(app, true, [exam])).sessions[0];
  const progressBefore = ok(await app.request('/bootstrap')).progress;
  app.advance(120000);
  const deletedHash = hash(await app.bytes());
  const whileDeleted = ok(await app.request('/bootstrap'));
  assert.equal(whileDeleted.sessions[0].status, 'active');
  assert.equal(whileDeleted.activeSession, null);
  assert.deepEqual(whileDeleted.progress, progressBefore);
  assert.equal(hash(await app.bytes()), deletedHash);
  const restored = ok(await sessionBatch(app, false, [removed])).sessions[0];
  assert.equal(restored.deadlineAt, exam.deadlineAt);
  assert.equal(restored.revision, 2);
  const graded = ok(await app.request('/bootstrap'));
  assert.equal(graded.sessions[0].status, 'completed');
  assert.equal(graded.sessions[0].revision, 3);
  assert.equal(graded.progress[q1].attempts, progressBefore[q1].attempts + 1);
  const gradedHash = hash(await app.bytes());
  assert.equal(ok(await app.request('/bootstrap')).sessions[0].revision, 3);
  assert.equal(hash(await app.bytes()), gradedHash);
});

test('management batches strictly validate every ID and both baseline fields before touching any record', async t => {
  const app = await harness(t);
  const session = await createSession(app);
  for (const kind of ['question', 'session']) {
    const idKey = kind === 'question' ? 'questionId' : 'sessionId';
    const valid = kind === 'question' ? questionItem(q1) : sessionItem(session);
    const path = `/${kind}-records/batch`;
    const before = hash(await app.bytes());
    for (const missing of [{ [idKey]: valid[idKey] }, { ...valid, expected: { removed: false } }, { ...valid, expected: { revision: 0 } }]) {
      const response = await app.request(path, { removed: true, items: [missing] });
      assert.equal(response.status, 428);
      assert.equal(response.body.code, 'PRECONDITION_REQUIRED');
      assert.ok(response.body.current[valid[idKey]]);
      assert.equal(hash(await app.bytes()), before);
    }
    const malformed = [{}, { removed: 1, items: [valid] }, { removed: true, items: [] }, { removed: true, items: {} }, { removed: true, items: [null] }, { removed: true, items: [valid, valid] }, { removed: true, items: [valid, { ...valid, [idKey]: 'not-present' }] },
      ...[null, [], false, { removed: 'false', revision: 0 }, { removed: false, revision: -1 }, { removed: false, revision: 1.5 }, { removed: false, revision: '0' }, { removed: false, revision: Number.MAX_SAFE_INTEGER + 1 }].map(value => ({ removed: true, items: [{ ...valid, expected: value }] }))];
    for (const body of malformed) {
      assert.equal((await app.request(path, body)).status, 400, JSON.stringify(body));
      assert.equal(hash(await app.bytes()), before);
    }
  }
});

test('both record types reject more than 500 selections and accept exactly 500 in one transaction', async t => {
  const initial = originalState();
  initial.sessions = Array.from({ length: 501 }, (_, index) => ({ id: `sized-session-${index}`, mode: 'sequential', questionIds: [q1], answers: {}, submittedQuestionIds: [], createdAt: '2025-12-31T00:00:00.000Z', deadlineAt: null, status: 'active', cursor: 0, removed: false, revision: 0 }));
  const app = await harness(t, initial);
  for (const [path, items] of [['/question-records/batch', questions.slice(0, 501).map(question => questionItem(question.id))], ['/session-records/batch', initial.sessions.map(sessionItem)]]) {
    const before = hash(await app.bytes());
    assert.equal((await app.request(path, { removed: true, items })).status, 400);
    assert.equal(hash(await app.bytes()), before);
    const result = ok(await app.request(path, { removed: true, items: items.slice(0, 500) }));
    assert.equal(result.changedCount, 500);
    assert.equal(Object.keys(result.questionRecords ?? result.sessions).length, 500);
  }
  assert.equal(ok(await app.request('/bootstrap')).questionRecords[questions[500].id].removed, false);
  assert.equal(ok(await app.request('/sessions/sized-session-500')).removed, false);
});

test('write failures roll back complete management batches and their revision numbers', async t => {
  for (const kind of ['question', 'session']) {
    const app = await harness(t);
    const first = await createSession(app), second = await createSession(app);
    const initial = ok(await app.request('/export'));
    const before = hash(await app.bytes());
    const saved = `${app.statePath}.test-backup`;
    await rename(app.statePath, saved); await mkdir(app.statePath);
    try {
      const response = kind === 'question' ? await questionBatch(app, true, [questionItem(q1), questionItem(q2)]) : await sessionBatch(app, true, [first, second]);
      assert.equal(response.status, 500);
      const after = ok(await app.request('/export'));
      assert.deepEqual(after.questionRecords, initial.questionRecords);
      assert.deepEqual(after.sessions, initial.sessions);
      assert.deepEqual(after.progress, initial.progress);
    } finally { await rmdir(app.statePath); await rename(saved, app.statePath); }
    assert.equal(hash(await app.bytes()), before);
    await app.restart();
    assert.deepEqual(ok(await app.request('/export')).sessions, initial.sessions);
  }
});

test('backup round trips preserve deletions, local restoration wins over old backups, and legacy defaults remain compatible', async t => {
  const app = await harness(t);
  const session = await createSession(app);
  const deletedQuestion = ok(await questionBatch(app, true, [questionItem(q1)])).questionRecords[q1];
  const deletedSession = ok(await sessionBatch(app, true, [session])).sessions[0];
  const deletedBackup = ok(await app.request('/export'));
  const restoredQuestion = ok(await questionBatch(app, false, [questionItem(q1, deletedQuestion)])).questionRecords[q1];
  const restoredSession = ok(await sessionBatch(app, false, [deletedSession])).sessions[0];
  const importedOld = ok(await app.request('/import', deletedBackup));
  assert.ok(importedOld.conflictCount >= 2);
  assert.deepEqual(ok(await app.request('/bootstrap')).questionRecords[q1], restoredQuestion);
  assert.deepEqual(ok(await app.request(`/sessions/${session.id}`)), restoredSession);
  const target = await harness(t, { version: 1, progress: {}, sessions: [] });
  ok(await target.request('/import', deletedBackup));
  await target.restart();
  assert.deepEqual(ok(await target.request('/bootstrap')).questionRecords[q1], deletedQuestion);
  assert.equal(ok(await target.request(`/sessions/${session.id}`)).removed, true);
  assert.equal(ok(await target.request('/bootstrap')).activeSession, null);
  const legacy = structuredClone(deletedBackup);
  delete legacy.questionRecords;
  legacy.sessions[0].id = 'legacy-imported-session';
  delete legacy.sessions[0].removed; delete legacy.sessions[0].revision;
  ok(await app.request('/import', legacy));
  const importedLegacy = ok(await app.request('/sessions/legacy-imported-session'));
  assert.equal(importedLegacy.removed, false);
  assert.equal(importedLegacy.revision, 0);
  assert.deepEqual(ok(await app.request('/bootstrap')).questionRecords[q1], restoredQuestion);
});

test('invalid imported deletion metadata is rejected before snapshots or any state change', async t => {
  const app = await harness(t);
  const session = await createSession(app);
  const backup = ok(await app.request('/export'));
  const before = hash(await app.bytes());
  const badMetadata = [null, [], { removed: null }, { removed: 'true' }, { removed: 1 }, { revision: -1 }, { revision: 1.1 }, { revision: '0' }, { revision: Number.MAX_SAFE_INTEGER + 1 }];
  for (const value of badMetadata) {
    const badQuestion = { ...backup, questionRecords: { [q1]: value } };
    assert.equal((await app.request('/import', badQuestion)).status, 400);
    if (value && !Array.isArray(value)) assert.equal((await app.request('/import', { ...backup, sessions: [{ ...session, ...value }] })).status, 400);
    assert.equal(hash(await app.bytes()), before);
  }
  assert.equal((await app.request('/import', { ...backup, questionRecords: null })).status, 400);
  assert.deepEqual((await readdir(app.dataDir)).filter(name => name.startsWith('before-import-')), []);
});
