import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStudyApi } from './api.mjs';
import { questionFingerprint } from './preanalysis.mjs';

const question = {
  id: 'ai-history-question', type: 'single', category: '测试', chapter: '解析历史', difficulty: '基础',
  knowledgePoint: '持久化', stem: '哪一个选项用于验证解析历史？',
  options: [{ id: 'A', text: '保留每次完整回复' }, { id: 'B', text: '覆盖旧回复' }],
  answer: ['A'], explanation: '完整回复应当可按题目回看。', source: '自动化测试',
};

function success(response) {
  assert.ok(response.status >= 200 && response.status < 300, `${response.status}: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function harness(t, options = {}) {
  const { initialState, ...apiOptions } = options;
  const directory = await mkdtemp(join(tmpdir(), 'yankao-ai-history-'));
  const dataDir = join(directory, 'state');
  const questionsPath = join(directory, 'questions.json');
  await mkdir(dataDir, { recursive: true });
  await writeFile(questionsPath, JSON.stringify([question]), 'utf8');
  if (initialState) await writeFile(join(dataDir, 'learning-state.json'), JSON.stringify(initialState), 'utf8');
  let api;
  let server;
  let base;
  async function start() {
    api = createStudyApi({ dataDir, questionsPath, ...apiOptions });
    server = createServer((req, res) => api.handle(req, res));
    await new Promise((resolveStart, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveStart);
    });
    base = `http://127.0.0.1:${server.address().port}/study-api`;
  }
  async function stop() {
    if (server?.listening) {
      const closed = new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      server.closeAllConnections?.();
      await closed;
    }
    server = undefined;
    api?.close();
    api = undefined;
  }
  t.after(async () => {
    await stop();
    const owned = resolve(directory);
    assert.ok(owned.startsWith(resolve(tmpdir()) + sep) && owned.split(sep).at(-1).startsWith('yankao-ai-history-'));
    await rm(owned, { recursive: true, force: true });
  });
  await start();
  return {
    dataDir,
    questionsPath,
    async restart() { await stop(); await start(); },
    async request(path, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('saved API history remains readable byte for byte after generation retirement and restart', async t => {
  const entry = { ...storedEntry('saved-api-history'), followup: '旧追问', retrieval: { searchCalls: 1, fetchCalls: 2, estimatedCostCny: 0.015 }, sources: [] };
  let calls = 0;
  const app = await harness(t, { initialState: seed([entry]), fetchImpl: async () => { calls++; throw new Error('No generation'); } });
  const before = await readFile(join(app.dataDir, 'learning-state.json'), 'utf8');
  assert.deepEqual(success(await app.request(`/questions/${question.id}/ai-history`)).entries, [entry]);
  for (const body of [{ questionId: question.id }, { questionId: question.id, retrievalEnabled: true }, {}]) {
    const retired = await app.request('/ai/explain', body);
    assert.equal(retired.status, 410);
    assert.equal(retired.body.modelRequested, false);
  }
  await app.restart();
  assert.deepEqual(success(await app.request(`/questions/${question.id}/ai-history`)).entries, [entry]);
  assert.equal(await readFile(join(app.dataDir, 'learning-state.json'), 'utf8'), before);
  assert.equal(calls, 0);
});

test('historical current and conflicting candidates preserve their generation snapshots independently', async t => {
  const first = { ...storedEntry('first-history'), followup: '首次旧追问', userAnswer: ['B'] };
  const second = { ...storedEntry('conflict-history', '以前保存的完整冲突候选。'), status: 'conflict', source: 'api-conflict', followup: '另一次旧追问', userAnswer: ['A'] };
  const app = await harness(t, { initialState: seed([first, second]) });
  const entries = success(await app.request(`/questions/${question.id}/ai-history`)).entries;
  assert.deepEqual(entries, [second, first]);
  await app.restart();
  assert.deepEqual(success(await app.request(`/questions/${question.id}/ai-history`)).entries, entries);
});

test('a completed web explanation is retained once and remains after a duplicate terminal update and restart', async t => {
  const app = await harness(t, { allowLegacyWebBridge: true });
  const job = success(await app.request('/bridge/jobs', { questionId: question.id, answer: ['A'], question: '网页追问' }));
  const completed = success(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '网页模型完整解析。' }));
  assert.ok(completed.aiHistoryId);
  const duplicate = success(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '网页模型完整解析。' }));
  assert.equal(duplicate.aiHistoryId, completed.aiHistoryId);
  let history = success(await app.request(`/questions/${question.id}/ai-history`));
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].provider, 'zhipu');
  assert.equal(history.entries[0].transport, 'web');
  assert.equal(history.entries[0].source, 'zhipu-web');
  assert.equal(history.entries[0].followup, '网页追问');
  await app.restart();
  history = success(await app.request(`/questions/${question.id}/ai-history`));
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].text, '网页模型完整解析。');
});

test('export and import carry historical API replies into another profile without calling a model', async t => {
  const entry = storedEntry('portable-history', '可迁移的历史完整解析。');
  const first = await harness(t, { initialState: seed([entry]) });
  const backup = success(await first.request('/export'));
  assert.deepEqual(backup.aiHistory, [entry]);
  const second = await harness(t, { fetchImpl: async () => { throw new Error('History import must not call a provider'); } });
  assert.equal(success(await second.request('/import', backup)).aiHistoryCount, 1);
  await second.restart();
  assert.deepEqual(success(await second.request(`/questions/${question.id}/ai-history`)).entries, [entry]);
});

const storedEntry = (id, text = '此前保存的完整解析。') => ({
  id, questionId: question.id, text, createdAt: '2026-01-01T00:00:00.000Z',
  provider: 'api', transport: 'api', source: 'api', status: 'current',
  userAnswer: ['B'], questionRevision: 0, questionFingerprint: questionFingerprint(question), model: 'old-model',
});
const seed = entries => ({ version: 1, progress: {}, sessions: [], aiHistory: entries });

test('legacy current and archived explanations are readable without inventing generation metadata or writing the profile', async t => {
  let calls = 0;
  const app = await harness(t, {
    initialState: { version: 1, progress: { [question.id]: { aiNote: '旧版当前解析。' } }, sessions: [], textHistory: [
      { id: 'old-text', questionId: question.id, field: 'aiNote', text: '更早的解析正文。', createdAt: '2025-02-03T00:00:00.000Z', source: 'api' },
      { id: 'empty-text', questionId: question.id, field: 'aiNote', text: '', createdAt: '2025-01-01T00:00:00.000Z', source: 'api' },
    ] },
    fetchImpl: async () => { calls++; throw new Error('History reads must never call a provider'); },
  });
  const before = await readFile(join(app.dataDir, 'learning-state.json'), 'utf8');
  const history = success(await app.request(`/questions/${question.id}/ai-history`));
  assert.deepEqual(history.entries.map(entry => entry.text), ['旧版当前解析。', '更早的解析正文。']);
  for (const entry of history.entries) {
    assert.equal(entry.transport, 'legacy');
    assert.equal(entry.status, 'legacy');
    for (const key of ['createdAt', 'model', 'userAnswer', 'questionRevision', 'questionFingerprint']) assert.equal(Object.hasOwn(entry, key), false, key);
  }
  assert.equal(history.entries[1].archivedAt, '2025-02-03T00:00:00.000Z');
  assert.equal(await readFile(join(app.dataDir, 'learning-state.json'), 'utf8'), before);
  assert.equal(calls, 0);
});

test('historical snapshots survive a replaced bank with removed options or missing question IDs', async t => {
  const entry = storedEntry('history-before-bank-change');
  const app = await harness(t, { initialState: seed([entry]) });
  const before = await readFile(join(app.dataDir, 'learning-state.json'), 'utf8');
  await writeFile(app.questionsPath, JSON.stringify([{ ...question, options: [question.options[0]] }]));
  await app.restart();
  assert.deepEqual(success(await app.request(`/questions/${question.id}/ai-history`)).entries, [entry]);
  await writeFile(app.questionsPath, '[]');
  await app.restart();
  assert.deepEqual(success(await app.request('/bootstrap')).questions, []);
  assert.deepEqual(success(await app.request(`/questions/${question.id}/ai-history`)).entries, [entry]);
  assert.deepEqual(success(await app.request('/export')).aiHistory, [entry]);
  assert.equal(await readFile(join(app.dataDir, 'learning-state.json'), 'utf8'), before);
});

test('colliding imported IDs preserve both complete replies and repeated import stays idempotent after restart', async t => {
  const original = storedEntry('same-id', '本地已有的付费解析。');
  const incoming = { ...storedEntry('same-id', '备份中另一份付费解析。'), model: 'another-model' };
  const app = await harness(t, { initialState: seed([original]) });
  const backup = { app: 'yankao-study', version: 1, progress: {}, sessions: [], aiHistory: [incoming] };
  const imported = success(await app.request('/import', backup));
  assert.equal(imported.aiHistoryCount, 1);
  assert.equal(imported.conflictCount, 1);
  const entries = success(await app.request(`/questions/${question.id}/ai-history`)).entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, incoming.text);
  assert.equal(entries[0].importedFromId, incoming.id);
  assert.notEqual(entries[0].id, incoming.id);
  assert.deepEqual(entries[1], original);
  await app.restart();
  const repeated = success(await app.request('/import', backup));
  assert.equal(repeated.aiHistoryCount, 0);
  assert.equal(repeated.skippedAiHistoryCount, 1);
  assert.deepEqual(success(await app.request(`/questions/${question.id}/ai-history`)).entries, entries);
});

test('import preserves AI history for an absent question until its bank is restored', async t => {
  const entry = { ...storedEntry('absent-question'), questionId: 'restorable-question' };
  const app = await harness(t);
  const backup = { app: 'yankao-study', version: 1, progress: {}, sessions: [], aiHistory: [entry] };
  assert.equal(success(await app.request('/import', backup)).aiHistoryCount, 1);
  await app.restart();
  assert.deepEqual(success(await app.request('/questions/restorable-question/ai-history')).entries, [entry]);
  assert.deepEqual(success(await app.request('/export')).aiHistory, [entry]);
});

test('full historical capacity still rejects imports atomically while generation is always retired', async t => {
  let calls = 0;
  const app = await harness(t, {
    initialState: seed(Array.from({ length: 10000 }, (_, index) => storedEntry(`full-${index}`))),
    fetchImpl: async () => { calls++; throw new Error('No provider request is allowed'); },
  });
  const before = await readFile(join(app.dataDir, 'learning-state.json'), 'utf8');
  const imported = await app.request('/import', { app: 'yankao-study', version: 1, progress: {}, sessions: [], aiHistory: [storedEntry('overflow')] });
  assert.equal(imported.status, 507);
  assert.equal(imported.body.code, 'AI_HISTORY_CAPACITY');
  assert.equal((await readdir(app.dataDir)).some(name => name.startsWith('before-import-')), false);
  const retired = await app.request('/ai/explain', { questionId: question.id });
  assert.equal(retired.status, 410);
  assert.equal(retired.body.modelRequested, false);
  assert.equal(calls, 0);
  assert.equal(await readFile(join(app.dataDir, 'learning-state.json'), 'utf8'), before);
});

const forkedWebHistory = (job, text, patch = {}) => ({
  id: 'forked-web-history', questionId: job.questionId, text, createdAt: '2026-01-01T00:00:00.000Z',
  provider: job.provider, transport: 'web', source: `${job.provider}-web`, status: 'current',
  userAnswer: job.userAnswer, questionRevision: job.questionRevision, questionFingerprint: job.questionFingerprint,
  followup: job.followup, operationId: `bridge:${job.id}`, ...patch,
});

for (const variant of ['different reply', 'different generation snapshot']) {
  test(`an imported operation ID with a ${variant} cannot stand in for the active web completion`, async t => {
    const app = await harness(t, { allowLegacyWebBridge: true });
    const job = success(await app.request('/bridge/jobs', { questionId: question.id, answer: ['A'], question: '本机本轮追问。' }));
    const text = '本机本轮完整解析。';
    const foreign = forkedWebHistory(job, variant === 'different reply' ? '分叉备份生成的另一份解析。' : text,
      variant === 'different generation snapshot' ? { followup: '分叉备份的其他追问。', userAnswer: ['B'] } : {});
    success(await app.request('/import', { app: 'yankao-study', version: 1, progress: {}, sessions: [], aiHistory: [foreign] }));
    const completed = success(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text }));
    const entries = success(await app.request(`/questions/${question.id}/ai-history`)).entries;
    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, completed.aiHistoryId);
    assert.notEqual(entries[0].id, foreign.id);
    assert.equal(entries[0].text, text);
    assert.equal(entries[0].followup, job.followup);
    assert.deepEqual(entries[0].userAnswer, ['A']);
    assert.equal(entries[1].id, foreign.id);
    assert.equal(entries[1].text, foreign.text);
    assert.equal(entries.every(entry => entry.transport === 'web'), true, '每份回复均应保留自己的生成快照');
    assert.equal(success(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text })).aiHistoryId, completed.aiHistoryId);
    await app.restart();
    assert.deepEqual(success(await app.request(`/questions/${question.id}/ai-history`)).entries, entries);
  });
}

test('imported matching operation IDs do not consume the reserved slot for a live web reply', async t => {
  const app = await harness(t, { allowLegacyWebBridge: true,
    initialState: seed(Array.from({ length: 9998 }, (_, index) => storedEntry(`web-reserved-${index}`))),
  });
  const job = success(await app.request('/bridge/jobs', { questionId: question.id, answer: ['A'], question: '保留本轮位置。' }));
  const foreign = forkedWebHistory(job, '同操作编号的外部完整解析。');
  success(await app.request('/import', { app: 'yankao-study', version: 1, progress: {}, sessions: [], aiHistory: [foreign] }));
  const rejected = await app.request('/import', { app: 'yankao-study', version: 1, progress: {}, sessions: [], aiHistory: [storedEntry('cannot-take-web-slot')] });
  assert.equal(rejected.status, 507);
  assert.equal(rejected.body.code, 'AI_HISTORY_CAPACITY');
  const text = '保留位置后本轮真正生成的完整解析。';
  const completed = success(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text }));
  const entries = success(await app.request(`/questions/${question.id}/ai-history`)).entries;
  assert.equal(entries.length, 10000);
  assert.equal(entries[0].id, completed.aiHistoryId);
  assert.equal(entries[0].text, text);
  assert.equal(entries[1].text, foreign.text);
});

test('a web completion acknowledgement retries its matching snapshot after journal write failure', async t => {
  const app = await harness(t, { allowLegacyWebBridge: true });
  const job = success(await app.request('/bridge/jobs', { questionId: question.id, answer: ['A'], question: '保持本轮快照。' }));
  const foreign = forkedWebHistory(job, '相同操作编号的外部解析。');
  success(await app.request('/import', { app: 'yankao-study', version: 1, progress: {}, sessions: [], aiHistory: [foreign] }));
  const journalPath = join(app.dataDir, 'bridge-jobs.json');
  const journalBackup = join(app.dataDir, 'bridge-jobs-write-test.json');
  await rename(journalPath, journalBackup);
  await mkdir(journalPath);
  const text = '已保存正文、等待任务确认的完整解析。';
  try {
    assert.equal((await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text })).status, 500);
  } finally {
    await rmdir(journalPath);
    await rename(journalBackup, journalPath);
  }
  const before = success(await app.request(`/questions/${question.id}/ai-history`)).entries;
  assert.equal(before.length, 2);
  assert.equal(before[0].text, text);
  const completed = success(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text }));
  assert.equal(completed.aiHistoryId, before[0].id);
  assert.deepEqual(success(await app.request(`/questions/${question.id}/ai-history`)).entries, before);
});
