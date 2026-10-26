import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { importQuestionBank, validateQuestionBankImport } from './question-bank-import.mjs';
import { acquireStorageLock } from './storage-lock.mjs';

const fixture = () => [{ id: 'own-1', type: 'single', category: '原创测试分类', chapter: '测试章节', knowledgePoint: '测试知识点', difficulty: '自定义',
  stem: '合成测试题干', options: [{ id: '甲', text: '合成选项一' }, { id: '乙', text: '合成选项二' }], answer: ['甲'], explanation: '' }];
function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beikao-bank-import-'));
  const sourcePath = path.join(directory, 'own.json'), targetPath = path.join(directory, 'project/study/data/questions.json'), dataDir = path.join(directory, 'runtime');
  fs.writeFileSync(sourcePath, '\uFEFF' + JSON.stringify(fixture()));
  t.after(() => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, sourcePath, targetPath, dataDir };
}

test('check-only validates a custom bank without writing target or runtime data', t => {
  const app = harness(t);
  assert.deepEqual(importQuestionBank({ ...app, checkOnly: true }), { count: 1, checked: true });
  assert.equal(fs.existsSync(app.targetPath), false);
  assert.equal(fs.existsSync(app.dataDir), false);
});

test('a new installation imports only the explicit user JSON and refuses silent overwrites', t => {
  const app = harness(t);
  const result = importQuestionBank(app);
  assert.equal(result.count, 1);
  assert.deepEqual(fs.readFileSync(app.targetPath), fs.readFileSync(app.sourcePath));
  assert.throws(() => importQuestionBank(app), /已存在/);
  assert.equal(fs.existsSync(path.join(app.dataDir, 'writer.lock')), false);
});

test('replacement needs the explicit flag, preserves original bank, and leaves learning data untouched', t => {
  const app = harness(t);
  importQuestionBank(app);
  const original = fs.readFileSync(app.targetPath);
  const learningPath = path.join(app.dataDir, 'learning-state.json'), learning = '{"synthetic":"preserve bytes"}';
  fs.writeFileSync(learningPath, learning);
  const updated = fixture(); updated[0].stem = '替换后的合成题干';
  fs.writeFileSync(app.sourcePath, JSON.stringify(updated));
  const result = importQuestionBank({ ...app, replace: true });
  assert.deepEqual(fs.readFileSync(result.backupPath), original);
  assert.equal(JSON.parse(fs.readFileSync(app.targetPath, 'utf8'))[0].stem, updated[0].stem);
  assert.equal(fs.readFileSync(learningPath, 'utf8'), learning);
});

test('the running service lock prevents importing or replacing its question bank', t => {
  const app = harness(t), release = acquireStorageLock(app.dataDir);
  try { assert.throws(() => importQuestionBank(app), /正在使用|正由进程/); }
  finally { release(); }
  assert.equal(fs.existsSync(app.targetPath), false);
});

test('invalid input never replaces a valid bank, even with --replace', t => {
  const app = harness(t); importQuestionBank(app);
  const original = fs.readFileSync(app.targetPath);
  for (const invalid of ['{', JSON.stringify([{ ...fixture()[0], answer: ['丙'] }]), JSON.stringify([...fixture(), ...fixture()])]) {
    fs.writeFileSync(app.sourcePath, invalid);
    assert.throws(() => importQuestionBank({ ...app, replace: true }));
    assert.deepEqual(fs.readFileSync(app.targetPath), original);
  }
});

test('bank schema rejects malformed fields and unsafe identities but supports custom option IDs', () => {
  assert.doesNotThrow(() => validateQuestionBankImport(fixture()));
  assert.doesNotThrow(() => validateQuestionBankImport([]));
  const malformed = [
    { id: '__proto__' }, { stem: '' }, { category: null }, { options: [null, {}] },
    { options: [{ id: 'A', text: '' }, { id: 'B', text: '合成' }] }, { answer: ['甲', '甲'] },
    { answer: ['甲', '乙'] }, { explanation: null }, { referenceUrls: ['javascript:alert(1)'] },
    { referenceUrls: ['https://name:password@example.test/'] },
  ];
  for (const patch of malformed) assert.throws(() => validateQuestionBankImport([{ ...fixture()[0], ...patch }]));
  assert.doesNotThrow(() => validateQuestionBankImport([{ ...fixture()[0], type: 'multiple', answer: ['甲', '乙'], referenceUrls: ['https://example.test/reference'] }]));
});
