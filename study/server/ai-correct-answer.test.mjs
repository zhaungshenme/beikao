import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStudyApi } from './api.mjs';

const bank = [
  { id: 'correct-single', type: 'single', category: '基础', chapter: '理解验证', difficulty: '基础', knowledgePoint: '解题思路', stem: '单选理解测试',
    options: [{ id: 'A', text: '正确项' }, { id: 'B', text: '错误项' }, { id: 'C', text: '干扰项' }], answer: ['A'], explanation: '测试原解析。', source: '原创测试' },
  { id: 'correct-multiple', type: 'multiple', category: '基础', chapter: '理解验证', difficulty: '基础', knowledgePoint: '解题思路', stem: '多选理解测试',
    options: [{ id: 'A', text: '正确项一' }, { id: 'B', text: '错误项' }, { id: 'C', text: '正确项二' }], answer: ['A', 'C'], explanation: '测试多选原解析。', source: '原创测试' },
];
const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yankao-ai-correct-answer-'));
  const dataDir = join(directory, 'state');
  const questionsPath = join(directory, 'questions.json');
  await mkdir(dataDir);
  await writeFile(questionsPath, JSON.stringify(bank));
  const api = createStudyApi({ allowLegacyWebBridge: true, dataDir, questionsPath, ...options });
  const server = createServer((req, res) => api.handle(req, res));
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const base = `http://127.0.0.1:${server.address().port}/study-api`;
  t.after(async () => {
    const closed = new Promise(accept => server.close(accept));
    server.closeAllConnections();
    await closed;
    api.close();
    const owned = resolve(directory);
    assert.ok(owned.startsWith(resolve(tmpdir()) + sep) && owned.split(sep).at(-1).startsWith('yankao-ai-correct-answer-'));
    await rm(owned, { recursive: true, force: true });
  });
  return {
    async request(path, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
  };
}
async function completedCorrectSession(app, questionId, answer) {
  const practice = ok(await app.request('/sessions', { mode: 'sequential', questionIds: [questionId], count: 1 }));
  assert.equal(ok(await app.request(`/sessions/${practice.id}/check`, { questionId, answer, expectedAnswer: [] })).correct, true);
  const saved = [...answer].sort();
  const finished = ok(await app.request(`/sessions/${practice.id}/finish`, { expectedAnswers: { [questionId]: saved } }));
  assert.equal(finished.session.score, 100);
  return ok(await app.request('/bootstrap'));
}
function verifyCorrectLearningPrompt(prompt) {
  assert.match(prompt, /我的选择与题库标准答案一致/);
  assert.match(prompt, /核验解题思路/);
  assert.match(prompt, /排除其他选项/);
  assert.match(prompt, /不要把答对等同于已掌握/);
  assert.match(prompt, /不要无依据认定我是猜对的/);
  assert.match(prompt, /不含答案的同知识点追问/);
  assert.match(prompt, /等待我回答后再判断理解程度/);
  assert.match(prompt, /标准答案有误.*明确指出/);
  assert.match(prompt, /理论学习.*防御原理/);
  assert.doesNotMatch(prompt, /我的错因/);
}
function verifyGradesUnchanged(before, after, id) {
  assert.deepEqual(after.sessions, before.sessions);
  const withoutAi = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['aiNote', 'aiNoteOperationId'].includes(key)));
  assert.deepEqual(withoutAi(after.progress[id]), withoutAi(before.progress[id]));
  assert.equal(after.progress[id].mastered, false, 'requesting AI does not mark correct guesses or correct choices as mastered');
}

test('a correctly answered single choice can stream an AI explanation without changing its saved grade', async t => {
  const app = await harness(t);
  const id = bank[0].id;
  const before = await completedCorrectSession(app, id, ['A']);
  const job = ok(await app.request('/bridge/jobs', { questionId: id, answer: ['A'] }));
  verifyCorrectLearningPrompt(job.prompt);
  assert.match(job.prompt, /我的答案：A/);
  ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: '逐步核验判断依据', sequence: 1 }));
  verifyGradesUnchanged(before, ok(await app.request('/bootstrap')), id);
  assert.equal(ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '完整理解解析与不含答案的追问', sequence: 2 })).status, 'completed');
  const after = ok(await app.request('/bootstrap'));
  verifyGradesUnchanged(before, after, id);
  assert.equal(after.progress[id].aiNote, '完整理解解析与不含答案的追问');
});

test('a correct multiple-choice set in different order receives the same understanding-focused explanation', async t => {
  const app = await harness(t);
  const id = bank[1].id;
  const before = await completedCorrectSession(app, id, ['C', 'A']);
  const job = ok(await app.request('/bridge/jobs', { questionId: id, answer: ['C', 'A'], question: '我选对了，帮我检查是否理解判断依据。' }));
  verifyCorrectLearningPrompt(job.prompt);
  assert.match(job.prompt, /我的答案：A、C/);
  assert.match(job.prompt, /我选对了，帮我检查是否理解判断依据/);
  ok(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '解释每个选项并验证理解' }));
  verifyGradesUnchanged(before, ok(await app.request('/bootstrap')), id);
});

test('the optional API also accepts a correct answer and uses the shared prompt without changing its score', async t => {
  let sent;
  const app = await harness(t, { fetchImpl: async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'API核验思路与关键依据' } }] }) };
  } });
  const id = bank[0].id;
  const before = await completedCorrectSession(app, id, ['A']);
  ok(await app.request('/ai/settings', { baseUrl: 'https://example.invalid/v1', model: 'test-model', apiKey: 'test-only-correct-answer-key' }, 'PUT'));
  const result = ok(await app.request('/ai/explain', { questionId: id, answer: ['A'] }));
  assert.equal(result.text, 'API核验思路与关键依据');
  verifyCorrectLearningPrompt(sent.messages.find(message => message.role === 'user').content);
  verifyGradesUnchanged(before, ok(await app.request('/bootstrap')), id);
});
