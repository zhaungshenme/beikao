import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { validatePreparedSeed, readPreparedSeed } from './prepared-seed.mjs';
import { createPreanalysisStore, questionFingerprint } from './preanalysis.mjs';
import { createStudyApi } from './api.mjs';

const question = { id: 'SEED-1', type: 'single', category: '测试', chapter: '基础', difficulty: '基础',
  stem: '哪项对应题设要求？', options: [{ id: 'A', text: '符合定义' }, { id: 'B', text: '不符合定义' }], answer: ['A'],
  explanation: '合成题库原解析。', knowledgePoint: '合成定义' };
const text = '本题根据题干给定的定义确定选择，先比较定义所要求的对象与条件，再判断选项是否满足。A（应选）：选项对象与题干规定的定义一致，满足必要条件。B（不选）：选项缺少该定义要求的条件，不能据此推出题干所需结论。';
const entry = () => ({ questionId: question.id, fingerprint: questionFingerprint(question), answer: ['A'], text,
  source: '合成公开讲解', generatedAt: '2026-10-30T00:00:00.000Z' });
const bundle = () => ({ version: 1, entries: [entry()] });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beikao-seed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'state'), seed = path.join(root, 'prepared.json');
  fs.mkdirSync(dataDir); fs.writeFileSync(seed, JSON.stringify(bundle()));
  return { root, dataDir, seed };
}
const store = (f, getQuestions = () => [question]) => createPreanalysisStore({ dataDir: f.dataDir, preparedExplanationsPath: f.seed,
  getQuestions, atomicJson: () => { throw new Error('read-only seed must not write'); } });

test('seed schema admits teaching fields only, clones input, and rejects duplicates or private state', () => {
  const value = bundle(), parsed = validatePreparedSeed(value);
  value.entries[0].text = 'changed'; assert.equal(parsed[question.id].text, text);
  assert.throws(() => validatePreparedSeed({ ...bundle(), failures: {} }), /结构/);
  assert.throws(() => validatePreparedSeed({ version: 1, entries: [{ ...entry(), note: 'private sentinel' }] }), /字段/);
  assert.throws(() => validatePreparedSeed({ version: 1, entries: [entry(), entry()] }), /题号/);
  assert.throws(() => validatePreparedSeed({ version: 1, entries: [{ ...entry(), questionId: '__proto__' }] }), /题号/);
  assert.throws(() => validatePreparedSeed({ version: 1, entries: [{ ...entry(), fingerprint: 'bad' }] }), /指纹/);
  assert.throws(() => validatePreparedSeed({ version: 1, entries: [{ ...entry(), answer: ['A', 'A'] }] }), /答案/);
});

test('clean installation reads matching bundled explanations without writing a local cache', t => {
  const f = fixture(t), before = fs.readFileSync(f.seed), view = store(f);
  assert.equal(view.status().completed, 1); assert.equal(view.status().stale, 0);
  assert.equal(view.question(question.id).state, 'ready'); assert.equal(view.question(question.id).text, text);
  assert.equal(view.question(question.id).source, '合成公开讲解');
  assert.equal(fs.existsSync(path.join(f.dataDir, 'preanalysis-state.json')), false);
  assert.deepEqual(fs.readFileSync(f.seed), before);
});

test('existing matching local explanation wins and all local bytes remain unchanged', t => {
  const f = fixture(t), local = { ...entry(), text: text + '\n本地修订的独立内容。', jobId: 'local:test', source: '本地旧来源' };
  const filename = path.join(f.dataDir, 'preanalysis-state.json');
  const bytes = JSON.stringify({ version: 1, status: 'paused', batchSize: 3, currentJobId: null, message: '保留', updatedAt: 'old',
    cache: { [question.id]: local }, failures: {}, quarantine: [] });
  fs.writeFileSync(filename, bytes); const view = store(f);
  assert.equal(view.question(question.id).text, local.text); assert.equal(view.question(question.id).source, '本地旧来源');
  assert.equal(fs.readFileSync(filename, 'utf8'), bytes);
});

test('changed stem, grading revision, or answer prevents a bundled explanation from appearing ready', t => {
  const f = fixture(t);
  for (const changed of [{ ...question, stem: '新题干' }, { ...question, answerRevision: 1 }, { ...question, answer: ['B'] }]) {
    const view = store(f, () => [changed]);
    assert.notEqual(view.question(question.id).state, 'ready'); assert.equal(view.question(question.id).text, '');
    assert.equal(view.status().completed, 0);
  }
  fs.writeFileSync(f.seed, JSON.stringify({ version: 1, entries: [{ ...entry(), answer: ['B'] }] }));
  assert.notEqual(store(f).question(question.id).state, 'ready');
});

test('missing optional seed preserves empty-bank behavior and malformed seed fails without storage writes', t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(readPreparedSeed(path.join(f.root, 'absent.json'))), []);
  fs.writeFileSync(f.seed, '{broken'); assert.throws(() => store(f));
  assert.deepEqual(fs.readdirSync(f.dataDir), []);
});

test('API exposes the explicitly supplied public seed and performs no network request', async t => {
  const f = fixture(t), questionsPath = path.join(f.root, 'questions.json');
  fs.writeFileSync(questionsPath, JSON.stringify([question]));
  const api = createStudyApi({ dataDir: f.dataDir, questionsPath, preparedExplanationsPath: f.seed,
    fetchImpl: () => { throw new Error('no network allowed'); } });
  const server = createServer(api.handle); t.after(() => { server.close(); server.closeAllConnections?.(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/study-api`;
  const response = await fetch(`${base}/preanalysis/questions/${question.id}`);
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.state, 'ready'); assert.equal(body.text, text); assert.equal(body.source, '合成公开讲解');
});
