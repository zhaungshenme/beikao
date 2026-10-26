import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { SOURCE_FILES, collectReleaseFiles, sourceZip, writeRelease } from './release-source.mjs';

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

test('only reviewed source is exported; bank, private state, Git and assets are never copied', t => {
  const root = fixture(t);
  for (const relative of ['study/data/questions.json', 'study/data/archive/old.json', 'study/storage/ai-settings.json', 'study/storage/learning-state.json', '.env', '.git/config', 'public/questions.json', 'browser-extension/local.json', 'study/screenshot.png', 'study/server/unreviewed.mjs']) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), 'private sentinel');
  }
  const files = collectReleaseFiles(root);
  assert.deepEqual([...files.keys()].sort(), [...SOURCE_FILES, 'RELEASE-MANIFEST.json'].sort());
  assert.ok(!Buffer.concat([...files.values()]).includes('private sentinel'));
  const pkg = JSON.parse(files.get('package.json'));
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
