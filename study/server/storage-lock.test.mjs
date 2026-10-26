import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireStorageLock } from './storage-lock.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yankao-writer-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('one data directory permits one writer and a clean release permits restart', t => {
  const directory = fixture(t);
  const release = acquireStorageLock(directory);
  assert.throws(() => acquireStorageLock(directory), /阻止第二个服务/);
  release();
  release();
  const secondRelease = acquireStorageLock(directory);
  secondRelease();
});
test('a demonstrably dead writer can be recovered without changing the learning data', t => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, 'learning-state.json'), '{"keep":"原有笔记"}');
  fs.writeFileSync(path.join(directory, 'writer.lock'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
  const release = acquireStorageLock(directory);
  assert.equal(fs.readFileSync(path.join(directory, 'learning-state.json'), 'utf8'), '{"keep":"原有笔记"}');
  release();
});
test('an invalid ownership record fails closed and preserves its original bytes', t => {
  const directory = fixture(t);
  const file = path.join(directory, 'writer.lock');
  fs.writeFileSync(file, 'damaged');
  assert.throws(() => acquireStorageLock(directory), /锁损坏/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'damaged');
});
test('releasing an old owner cannot remove a replacement ownership token', t => {
  const directory = fixture(t);
  const release = acquireStorageLock(directory);
  const file = path.join(directory, 'writer.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }));
  release();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'replacement-owner');
});
