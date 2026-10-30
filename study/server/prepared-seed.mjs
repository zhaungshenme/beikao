import fs from 'node:fs';

const keys = ['questionId', 'fingerprint', 'answer', 'text', 'source', 'generatedAt'].sort();
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const plainText = value => typeof value === 'string' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);

/** Public teaching content only; never import a private preanalysis-state file. */
export function validatePreparedSeed(value) {
  assert(record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['entries', 'version']) && value.version === 1 &&
    Array.isArray(value.entries) && value.entries.length <= 50000, '公开讲解文件结构无效。');
  const cache = Object.create(null);
  for (const entry of value.entries) {
    assert(record(entry) && JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(keys), '公开讲解含未允许的字段。');
    assert(plainText(entry.questionId) && entry.questionId.length > 0 && entry.questionId.length <= 100 &&
      entry.questionId === entry.questionId.trim() && !['__proto__', 'constructor', 'prototype'].includes(entry.questionId) &&
      !Object.hasOwn(cache, entry.questionId), '公开讲解题号无效或重复。');
    assert(typeof entry.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(entry.fingerprint), '公开讲解指纹无效。');
    assert(Array.isArray(entry.answer) && entry.answer.length > 0 && entry.answer.length <= 26 && new Set(entry.answer).size === entry.answer.length &&
      entry.answer.every(id => plainText(id) && id.length > 0 && id.length <= 100), '公开讲解答案无效。');
    assert(plainText(entry.text) && entry.text === entry.text.trim() && entry.text.length >= 80 && entry.text.length <= 20000, '公开讲解正文无效。');
    assert(plainText(entry.source) && entry.source.trim().length > 0 && entry.source.length <= 500 &&
      typeof entry.generatedAt === 'string' && Number.isFinite(Date.parse(entry.generatedAt)), '公开讲解来源或时间无效。');
    cache[entry.questionId] = structuredClone(entry);
  }
  return cache;
}

export function readPreparedSeed(file) {
  if (!file || !fs.existsSync(file)) return Object.create(null);
  assert(fs.statSync(file).isFile() && fs.statSync(file).size <= 64 * 1024 * 1024, '公开讲解文件超过大小限制。');
  return validatePreparedSeed(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
}
