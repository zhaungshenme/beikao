import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStudyApi } from './api.mjs';

const bank = [
  { id: 'single', type: 'single', category: '验证', chapter: '纠正', difficulty: '基础', knowledgePoint: '标准答案', stem: '单选测试',
    options: [{ id: 'A', text: '选项一' }, { id: 'B', text: '选项二' }, { id: 'C', text: '选项三' }], answer: ['A'], explanation: '原始解析', source: '自动化测试' },
  { id: 'multiple', type: 'multiple', category: '验证', chapter: '纠正', difficulty: '基础', knowledgePoint: '标准答案', stem: '多选测试',
    options: [{ id: 'A', text: '选项一' }, { id: 'B', text: '选项二' }, { id: 'C', text: '选项三' }], answer: ['A', 'C'], explanation: '原始多选解析', source: '自动化测试' },
];
async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yankao-answer-correction-'));
  const dataDir = join(directory, 'state');
  const questionsPath = join(directory, 'questions.json');
  await mkdir(dataDir);
  await writeFile(questionsPath, JSON.stringify(bank));
  let server, api, base;
  async function start() {
    api = createStudyApi({ allowLegacyWebBridge: true, dataDir, questionsPath, ...options });
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
  t.after(async () => {
    await stop();
    const owned = resolve(directory);
    assert.ok(owned.startsWith(resolve(tmpdir()) + sep) && owned.split(sep).at(-1).startsWith('yankao-answer-correction-'));
    await rm(owned, { recursive: true, force: true });
  });
  await start();
  return {
    dataDir, questionsPath,
    async request(path, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async restart() { await stop(); await start(); },
  };
}
const ok = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
const correction = (app, revision = 0, patch = {}) => app.request('/questions/single/answer', { answer: ['B'], explanation: '经核验的解析', note: '核验参考后纠正', expectedRevision: revision, ...patch }, 'PUT');
const session = async (app, patch = {}) => ok(await app.request('/sessions', { mode: 'sequential', questionIds: ['single'], count: 1, ...patch }));

test('answer corrections persist separately from the original bank and restore as a new version', async t => {
  const app = await harness(t);
  const originalFile = await readFile(app.questionsPath, 'utf8');
  assert.equal(ok(await app.request('/bootstrap')).questions[0].answerRevision, 0);
  assert.equal(ok(await correction(app)).question.answerRevision, 1);
  await app.restart();
  const saved = ok(await app.request('/questions/single/answer-history'));
  assert.deepEqual(saved.question.answer, ['B']);
  assert.equal(saved.entries.length, 2);
  assert.equal(saved.entries[1].source, 'original');
  const restored = ok(await app.request('/questions/single/answer/restore', { historyId: saved.entries[1].id, expectedRevision: 1 }));
  assert.deepEqual(restored.question.answer, ['A']);
  assert.equal(restored.question.answerRevision, 2);
  assert.equal(ok(await app.request('/questions/single/answer-history')).entries.length, 3);
  assert.equal(await readFile(app.questionsPath, 'utf8'), originalFile);
});

test('stale correction and stale restore never overwrite a newer standard', async t => {
  const app = await harness(t);
  const initial = ok(await app.request('/questions/single/answer-history'));
  ok(await correction(app));
  const conflict = await correction(app, 0, { answer: ['C'] });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'WRITE_CONFLICT');
  assert.deepEqual(conflict.body.current.answer, ['B']);
  assert.equal((await app.request('/questions/single/answer/restore', { historyId: initial.entries[0].id, expectedRevision: 0 })).status, 409);
  assert.equal(ok(await app.request('/questions/single/answer-history')).entries.length, 2);
});

test('invalid and oversized corrections are rejected atomically', async t => {
  const app = await harness(t);
  for (const patch of [{ answer: [] }, { answer: ['A', 'B'] }, { answer: ['Z'] }, { answer: ['B', 'B'] }, { explanation: 5 }, { explanation: '' }, { explanation: '  \n\t' }, { note: null }, { expectedRevision: -1 }]) {
    assert.equal((await correction(app, 0, patch)).status, 400);
  }
  assert.equal((await correction(app, 0, { explanation: 'x'.repeat(20001) })).status, 413);
  assert.equal((await correction(app, 0, { note: 'x'.repeat(2001) })).status, 413);
  const withoutBaseline = { answer: ['B'], explanation: '', note: '' };
  assert.equal((await app.request('/questions/single/answer', withoutBaseline, 'PUT')).status, 428);
  assert.equal(ok(await app.request('/questions/single/answer-history')).entries.length, 1);
  ok(await app.request('/questions/multiple/answer', { answer: ['B', 'A'], explanation: '新的多选解析', note: '', expectedRevision: 0 }, 'PUT'));
  assert.deepEqual(ok(await app.request('/questions/multiple/answer-history')).question.answer, ['A', 'B']);
});

test('correction preserves completed scores, old results and cumulative progress while new grades use the new answer', async t => {
  const app = await harness(t);
  const practice = await session(app);
  const checked = ok(await app.request(`/sessions/${practice.id}/check`, { questionId: 'single', answer: ['A'], expectedAnswer: [], expectedQuestionRevision: 0 }));
  assert.equal(checked.correct, true);
  ok(await app.request(`/sessions/${practice.id}/finish`, { expectedAnswers: { single: ['A'] } }));
  const beforeProgress = ok(await app.request('/bootstrap')).progress.single;
  ok(await correction(app));
  const old = ok(await app.request(`/sessions/${practice.id}/finish`, {}));
  assert.equal(old.session.score, 100);
  assert.deepEqual(old.results[0].answer, ['A']);
  assert.equal(old.results[0].questionRevision, 0);
  assert.equal(old.results[0].explanation, '原始解析');
  assert.deepEqual(ok(await app.request('/bootstrap')).progress.single, beforeProgress);
  const next = await session(app);
  const latest = ok(await app.request(`/sessions/${next.id}/check`, { questionId: 'single', answer: ['B'], expectedAnswer: [], expectedQuestionRevision: 1 }));
  assert.equal(latest.correct, true);
  assert.equal(latest.questionRevision, 1);
  await app.restart();
  assert.equal(ok(await app.request(`/sessions/${practice.id}/finish`, {})).session.score, 100);
});

test('legacy graded sessions receive their old standard before the first correction', async t => {
  const app = await harness(t);
  const practice = await session(app);
  ok(await app.request(`/sessions/${practice.id}/check`, { questionId: 'single', answer: ['A'], expectedAnswer: [] }));
  const backup = ok(await app.request('/export'));
  delete backup.sessions[0].gradedResults;
  await writeFile(join(app.dataDir, 'learning-state.json'), JSON.stringify(backup));
  await app.restart();
  ok(await correction(app));
  const replay = ok(await app.request(`/sessions/${practice.id}/check`, { questionId: 'single', answer: ['A'], expectedAnswer: ['A'] }));
  assert.equal(replay.correct, true);
  assert.deepEqual(replay.answer, ['A']);
  assert.equal(replay.session.gradedResults.single.questionRevision, 0);
});

test('a stale check retains the saved selection and cannot grade against an unseen correction', async t => {
  const app = await harness(t);
  const practice = await session(app);
  ok(await app.request(`/sessions/${practice.id}`, { questionId: 'single', answer: ['A'], expectedAnswer: [] }, 'PATCH'));
  ok(await correction(app));
  for (const expectedQuestionRevision of [undefined, 0]) {
    const result = await app.request(`/sessions/${practice.id}/check`, { questionId: 'single', answer: ['A'], expectedAnswer: ['A'], expectedQuestionRevision });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'QUESTION_UPDATED');
  }
  const boot = ok(await app.request('/bootstrap'));
  assert.deepEqual(boot.activeSession.answers.single, ['A']);
  assert.deepEqual(boot.activeSession.submittedQuestionIds, []);
  assert.equal(boot.progress.single?.attempts ?? 0, 0);
  assert.equal(ok(await app.request(`/sessions/${practice.id}/check`, { questionId: 'single', answer: ['A'], expectedAnswer: ['A'], expectedQuestionRevision: 1 })).correct, false);
});

test('a stale exam finish retains the whole exam, while current versions and automatic deadlines can finish', async t => {
  let now = Date.now();
  const app = await harness(t, { now: () => now });
  const exam = await session(app, { mode: 'exam', minutes: 1 });
  ok(await app.request(`/sessions/${exam.id}`, { questionId: 'single', answer: ['B'], expectedAnswer: [] }, 'PATCH'));
  ok(await correction(app));
  const stale = await app.request(`/sessions/${exam.id}/finish`, { expectedAnswers: { single: ['B'] }, expectedQuestionRevisions: { single: 0 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'QUESTION_UPDATED');
  assert.equal(stale.body.current.questions[0].answerRevision, 1);
  assert.equal(ok(await app.request('/bootstrap')).activeSession.status, 'active');
  const finished = ok(await app.request(`/sessions/${exam.id}/finish`, { expectedAnswers: { single: ['B'] }, expectedQuestionRevisions: { single: 1 } }));
  assert.equal(finished.session.score, 100);
  const timed = await session(app, { mode: 'exam', minutes: 1 });
  now += 61000;
  const boot = ok(await app.request('/bootstrap'));
  assert.equal(boot.sessions.find(s => s.id === timed.id).gradedResults.single.questionRevision, 1);
});

test('a failed correction rolls back its history, effective standard and legacy grading snapshots', async t => {
  const app = await harness(t);
  const practice = await session(app);
  ok(await app.request(`/sessions/${practice.id}/check`, { questionId: 'single', answer: ['A'], expectedAnswer: [] }));
  const stateFile = join(app.dataDir, 'learning-state.json');
  const held = stateFile + '.held';
  await rename(stateFile, held);
  await mkdir(stateFile);
  try {
    assert.equal((await correction(app)).status, 500);
    assert.equal(ok(await app.request('/questions/single/answer-history')).question.answerRevision, 0);
    assert.equal(ok(await app.request('/questions/single/answer-history')).entries.length, 1);
  } finally { await rmdir(stateFile); await rename(held, stateFile); }
  await app.restart();
  ok(await correction(app));
  assert.equal(ok(await app.request('/questions/single/answer-history')).entries.length, 2);
});

test('export/import retains grading snapshots and corrections while an older backup cannot revert a local correction', async t => {
  const source = await harness(t);
  const old = ok(await source.request('/export'));
  ok(await correction(source));
  const practice = await session(source);
  ok(await source.request(`/sessions/${practice.id}/check`, { questionId: 'single', answer: ['B'], expectedAnswer: [], expectedQuestionRevision: 1 }));
  ok(await source.request(`/sessions/${practice.id}/finish`, { expectedAnswers: { single: ['B'] } }));
  const backup = ok(await source.request('/export'));
  const target = await harness(t);
  ok(await target.request('/import', backup));
  assert.equal(ok(await target.request('/questions/single/answer-history')).question.answerRevision, 1);
  assert.equal(ok(await target.request(`/sessions/${practice.id}/finish`, {})).session.score, 100);
  ok(await correction(target, 1, { answer: ['C'] }));
  ok(await target.request('/import', old));
  ok(await target.request('/import', backup));
  assert.deepEqual(ok(await target.request('/questions/single/answer-history')).question.answer, ['C']);
  assert.equal(ok(await target.request(`/sessions/${practice.id}/finish`, {})).session.score, 100);
  await target.restart();
  assert.deepEqual(ok(await target.request('/questions/single/answer-history')).question.answer, ['C']);
});

test('invalid correction histories and forged grading results reject the complete import without changes', async t => {
  const app = await harness(t);
  ok(await correction(app));
  const practice = await session(app);
  ok(await app.request(`/sessions/${practice.id}/check`, { questionId: 'single', answer: ['B'], expectedAnswer: [], expectedQuestionRevision: 1 }));
  const backup = ok(await app.request('/export'));
  const before = await readFile(join(app.dataDir, 'learning-state.json'), 'utf8');
  const invalidHistory = structuredClone(backup);
  invalidHistory.answerCorrections.single.entries[1].revision = 5;
  assert.equal((await app.request('/import', invalidHistory)).status, 400);
  const forged = structuredClone(backup);
  forged.sessions[0].gradedResults.single.correct = false;
  assert.equal((await app.request('/import', forged)).status, 400);
  assert.equal(await readFile(join(app.dataDir, 'learning-state.json'), 'utf8'), before);
});

test('importing a correction freezes preexisting local grades and old imported sessions use their backup standard', async t => {
  const source = await harness(t);
  const originalPractice = await session(source);
  ok(await source.request(`/sessions/${originalPractice.id}/check`, { questionId: 'single', answer: ['A'], expectedAnswer: [] }));
  ok(await source.request(`/sessions/${originalPractice.id}/finish`, { expectedAnswers: { single: ['A'] } }));
  const oldBackup = ok(await source.request('/export'));
  delete oldBackup.sessions[0].gradedResults;
  delete oldBackup.answerCorrections;
  ok(await correction(source));
  const correctedBackup = ok(await source.request('/export'));
  const target = await harness(t);
  const local = await session(target);
  ok(await target.request(`/sessions/${local.id}/check`, { questionId: 'single', answer: ['A'], expectedAnswer: [] }));
  ok(await target.request('/import', correctedBackup));
  const localResult = ok(await target.request(`/sessions/${local.id}/finish`, { expectedAnswers: { single: ['A'] } }));
  assert.equal(localResult.session.score, 100);
  assert.deepEqual(localResult.results[0].answer, ['A']);
  const fresh = await harness(t);
  ok(await correction(fresh));
  ok(await fresh.request('/import', oldBackup));
  const importedResult = ok(await fresh.request(`/sessions/${originalPractice.id}/finish`, {}));
  assert.equal(importedResult.session.score, 100);
  assert.deepEqual(importedResult.results[0].answer, ['A']);
});

test('a bridge reply based on a superseded standard is retained in history without overwriting the saved explanation', async t => {
  const app = await harness(t);
  ok(await app.request('/questions/single', { aiNote: '已经核验的原解析', expected: { aiNote: '' } }, 'PATCH'));
  const job = ok(await app.request('/bridge/jobs', { questionId: 'single' }));
  assert.equal(job.questionRevision, 0);
  ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: '旧标准临时回复', sequence: 1 }));
  ok(await correction(app));
  await app.restart();
  const final = ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '完整但基于旧标准的回复', sequence: 2 }));
  assert.equal(final.status, 'failed');
  assert.equal(final.failureCode, 'answer-standard-conflict');
  assert.ok(final.historyId);
  assert.equal(final.text, '完整但基于旧标准的回复');
  assert.match(final.error, /标准答案已更新/);
  assert.equal(ok(await app.request('/bootstrap')).progress.single.aiNote, '已经核验的原解析');
  const entries = ok(await app.request('/questions/single/history')).entries;
  assert.equal(entries.find(entry => entry.id === final.historyId).text, final.text);
  assert.equal(entries.find(entry => entry.id === final.historyId).source, 'answer-standard-conflict');
  assert.deepEqual(ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '迟到重试', sequence: 3 })), final);
  const next = ok(await app.request('/bridge/jobs', { questionId: 'single' }));
  assert.equal(next.questionRevision, 1);
  ok(await app.request(`/bridge/jobs/${next.id}/update`, { provider: 'zhipu', status: 'completed', text: '按新标准重新生成的解析' }));
  assert.equal(ok(await app.request('/bootstrap')).progress.single.aiNote, '按新标准重新生成的解析');
});

test('older bridge journals without a standard revision remain readable as revision zero and invalid revisions fail without rewriting', async t => {
  const app = await harness(t);
  const job = ok(await app.request('/bridge/jobs', { questionId: 'single' }));
  const file = join(app.dataDir, 'bridge-jobs.json');
  const journal = JSON.parse(await readFile(file, 'utf8'));
  delete journal.jobs[0].questionRevision;
  const legacy = JSON.stringify(journal);
  await writeFile(file, legacy);
  await app.restart();
  assert.equal(ok(await app.request(`/bridge/jobs/${job.id}`)).status, 'queued');
  for (const revision of [-1, 0.5, '0']) {
    journal.jobs[0].questionRevision = revision;
    const invalid = JSON.stringify(journal);
    await writeFile(file, invalid);
    assert.throws(() => createStudyApi({ allowLegacyWebBridge: true, dataDir: app.dataDir, questionsPath: app.questionsPath }), /解析任务记录损坏/);
    assert.equal(await readFile(file, 'utf8'), invalid);
  }
  await writeFile(file, legacy);
  ok(await correction(app));
  const final = ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '兼容旧日志的完整回复' }));
  assert.equal(final.failureCode, 'answer-standard-conflict');
  assert.equal(ok(await app.request('/questions/single/history')).entries.find(entry => entry.id === final.historyId).text, final.text);
});

test('a delayed API explanation under an older answer is retained as a candidate and returns a conflict', async t => {
  let started, release;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const responseGate = new Promise(resolve => { release = resolve; });
  const app = await harness(t, { fetchImpl: async () => {
    started();
    await responseGate;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'API基于旧标准的完整回复' } }] }) };
  } });
  ok(await app.request('/ai/settings', { baseUrl: 'https://example.invalid/v1', model: 'test-model', apiKey: 'test-only-answer-revision-key' }, 'PUT'));
  ok(await app.request('/questions/single', { aiNote: '已经保存的解析', expected: { aiNote: '' } }, 'PATCH'));
  const pending = app.request('/ai/explain', { questionId: 'single' });
  await requestStarted;
  ok(await correction(app));
  release();
  const conflict = await pending;
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'WRITE_CONFLICT');
  assert.match(conflict.body.error, /标准答案已更新/);
  assert.equal(ok(await app.request('/bootstrap')).progress.single.aiNote, '已经保存的解析');
  assert.equal(ok(await app.request('/questions/single/history')).entries.find(entry => entry.id === conflict.body.historyId).text, 'API基于旧标准的完整回复');
  await app.restart();
  assert.equal(ok(await app.request('/questions/single/history')).entries.find(entry => entry.id === conflict.body.historyId).source, 'answer-standard-conflict');
});
