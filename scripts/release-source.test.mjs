import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { SOURCE_FILES, collectReleaseFiles, sourceZip, writeRelease } from './release-source.mjs';
import { questionFingerprint } from '../study/server/preanalysis.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beikao-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of SOURCE_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), '// synthetic source\n');
  }
  const pkg = { name: 'beikao', version: '1.0.0', dependencies: {}, devDependencies: {}, engines: { node: '>=22.12.0' }, repository: { url: 'https://example.invalid/upstream' }, scripts: { 'build:extension': 'unused' } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { '': pkg } }));
  const q = { id: 'PUBLIC-1', type: 'single', category: '合成', chapter: '测试', difficulty: '基础', stem: '合成题干', options: [{id:'A',text:'甲'}, {id:'B',text:'乙'}], answer:['A'], explanation:'合成原解析', knowledgePoint:'定义' };
  fs.writeFileSync(path.join(root, 'study/data/questions.json'), JSON.stringify([q]));
  fs.writeFileSync(path.join(root, 'study/data/prepared-explanations.json'), JSON.stringify({version:1,entries:[{questionId:q.id,fingerprint:questionFingerprint(q),answer:q.answer,text:'合成讲解用于验证公开题库与标准逐字匹配，公开的内容应只有题目本身及讲解。'.repeat(3),source:'合成作者',generatedAt:'2026-10-30T00:00:00Z'}]}));
  return root;
}

function zipEntries(zip) {
  const entries = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const length = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26);
    const extra = zip.readUInt16LE(offset + 28), start = offset + 30 + nameLength + extra;
    entries.set(zip.subarray(offset + 30, offset + 30 + nameLength).toString(), inflateRawSync(zip.subarray(start, start + length)));
    offset = start + length;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 14), entries.size);
  return entries;
}

test('only explicitly published bank and teaching content are exported; private state, other banks and assets stay local', t => {
  const root = fixture(t);
  for (const relative of ['study/data/private-questions.json', 'study/data/archive/old.json', 'study/storage/ai-settings.json', 'study/storage/learning-state.json', '.env', '.git/config', 'public/questions.json', 'browser-extension/local.json', 'study/screenshot.png', 'study/server/unreviewed.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), 'private sentinel');
  }
  const files = collectReleaseFiles(root);
  assert.deepEqual([...files.keys()].sort(), [...SOURCE_FILES, 'RELEASE-MANIFEST.json'].sort());
  assert.ok(!Buffer.concat([...files.values()]).includes('private sentinel'));
  const pkg = JSON.parse(files.get('package.json'));
  const manifest = JSON.parse(files.get('RELEASE-MANIFEST.json'));
  assert.equal(manifest.includesQuestionBank, true); assert.equal(manifest.includesPreparedExplanations, true); assert.equal(manifest.questionCount, 1);
  assert.equal(pkg.private, true);
  assert.equal(pkg.repository, undefined);
  assert.equal(pkg.scripts['build:extension'], undefined);
  assert.deepEqual(pkg.dependencies, {});
  const zip = sourceZip(files), entries = zipEntries(zip);
  assert.equal(entries.size, files.size);
  for (const [relative, data] of files) assert.deepEqual(entries.get(`beikao/${relative}`), data);
  assert.deepEqual(sourceZip(files), zip, 'identical reviewed source produces identical ZIP bytes');
});

test('credentials in a reviewed file block export without echoing the credential', t => {
  const root = fixture(t), credential = 'sk-' + 'A'.repeat(32);
  fs.writeFileSync(path.join(root, 'study/main.ts'), credential);
  assert.throws(() => collectReleaseFiles(root), error => error.message.includes('study/main.ts') && !error.message.includes(credential));
  assert.throws(() => writeRelease(root, path.join(root, 'artifacts/blocked')));
  assert.equal(fs.existsSync(path.join(root, 'artifacts/blocked')), false);
});

test('ordinary risk-management URL text is preserved while credentials in URL paths and parameters are blocked', t => {
  const root = fixture(t), sourceFile = path.join(root, 'study/main.ts');
  const reference = 'https://www.nist.gov/itl/ai-risk-management-framework';
  fs.writeFileSync(sourceFile, reference);
  assert.equal(collectReleaseFiles(root).get('study/main.ts').toString(), reference);
  const credential = 'sk-' + 'B'.repeat(32);
  for (const text of [credential, `const key = '${credential}';`, `https://example.invalid/${credential}`, `https://example.invalid/?key=${credential}`,
    'ghp_' + 'C'.repeat(32), 'github_pat_' + 'D'.repeat(32), ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')]) {
    fs.writeFileSync(sourceFile, text);
    assert.throws(() => collectReleaseFiles(root), /疑似真实密钥/);
  }
});

test('personal fields inside an otherwise valid public bank or explanation block publication', t => {
  const root = fixture(t), bankFile = path.join(root, 'study/data/questions.json');
  const bank = JSON.parse(fs.readFileSync(bankFile));
  bank[0].note = 'private sentinel'; fs.writeFileSync(bankFile, JSON.stringify(bank));
  assert.throws(() => collectReleaseFiles(root), /未允许字段/);
  delete bank[0].note; bank[0].options[0].lastAnswer = 'private sentinel'; fs.writeFileSync(bankFile, JSON.stringify(bank));
  assert.throws(() => collectReleaseFiles(root), /未允许字段/);
  delete bank[0].options[0].lastAnswer; fs.writeFileSync(bankFile, JSON.stringify(bank));
  const seedFile = path.join(root, 'study/data/prepared-explanations.json'), seed = JSON.parse(fs.readFileSync(seedFile));
  seed.entries[0].jobId = 'private-job'; fs.writeFileSync(seedFile, JSON.stringify(seed));
  assert.throws(() => collectReleaseFiles(root), /未允许的字段/);
});

test('stale fingerprints, changed answers and incomplete public explanations cannot be exported', t => {
  const root = fixture(t), seedFile = path.join(root, 'study/data/prepared-explanations.json');
  const original = JSON.parse(fs.readFileSync(seedFile));
  for (const change of [value => { value.entries[0].fingerprint = '0'.repeat(64); }, value => { value.entries[0].answer = ['B']; }, value => { value.entries = []; }]) {
    const candidate = structuredClone(original); change(candidate); fs.writeFileSync(seedFile, JSON.stringify(candidate));
    assert.throws(() => collectReleaseFiles(root), /不匹配|完整对应/);
  }
});

test('missing source or mismatched lock blocks a partial publication', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { '': { name: 'different' } } }));
  assert.throws(() => collectReleaseFiles(root), /package-lock/);
  fs.unlinkSync(path.join(root, 'study/main.ts'));
  assert.throws(() => collectReleaseFiles(root), /ENOENT/);
});

test('output is confined, never overwrites, and preserves the working source', t => {
  const root = fixture(t), destination = path.join(root, 'artifacts/ready');
  assert.throws(() => writeRelease(root, path.join(root, 'study')), /artifacts/);
  const result = writeRelease(root, destination);
  assert.equal(result.files, SOURCE_FILES.length + 1);
  assert.ok(fs.existsSync(result.zip));
  assert.throws(() => writeRelease(root, destination), /已存在/);
  assert.equal(fs.readFileSync(path.join(root, 'study/main.ts'), 'utf8'), '// synthetic source\n');
});

test('symlinked reviewed source cannot pull files from outside the project', t => {
  const root = fixture(t), source = path.join(root, 'src/views/study');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'beikao-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.renameSync(source, path.join(outside, 'study'));
  fs.symlinkSync(path.join(outside, 'study'), source, 'junction');
  assert.throws(() => collectReleaseFiles(root), /符号链接/);
});
