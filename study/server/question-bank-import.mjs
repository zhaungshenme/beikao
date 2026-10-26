import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireStorageLock } from './storage-lock.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireValue = (value, message) => { if (!value) throw new Error(message); };
const nonemptyText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validId = value => nonemptyText(value, 100) && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);

/** Validate user-supplied data before replacing anything. No shipped bank is consulted. */
export function validateQuestionBankImport(value) {
  requireValue(Array.isArray(value) && value.length <= 50000, '题库须为最多 50000 题的 JSON 数组。');
  const ids = new Set();
  for (let index = 0; index < value.length; index++) {
    const question = value[index], label = `第 ${index + 1} 题`;
    requireValue(record(question) && validId(question.id) && !ids.has(question.id), `${label}题号无效或重复（id 须为 1 至 100 字符）。`);
    ids.add(question.id);
    requireValue(['single', 'multiple'].includes(question.type), `${label} type 只能为 single 或 multiple。`);
    for (const field of ['category', 'chapter', 'knowledgePoint', 'difficulty']) {
      requireValue(nonemptyText(question[field], 200), `${label} ${field} 须为 1 至 200 字符。`);
    }
    requireValue(nonemptyText(question.stem, 10000), `${label} stem 须为 1 至 10000 字符。`);
    requireValue(typeof question.explanation === 'string' && question.explanation.length <= 20000, `${label} explanation 须为不超过 20000 字符的字符串（可为空）。`);
    requireValue(question.source === undefined || typeof question.source === 'string' && question.source.length <= 1000, `${label} source 须为不超过 1000 字符的字符串。`);
    if (question.referenceUrls !== undefined) {
      requireValue(Array.isArray(question.referenceUrls) && question.referenceUrls.length <= 20 && question.referenceUrls.every(value => {
        if (typeof value !== 'string' || value.length > 2048) return false;
        try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
      }), `${label} referenceUrls 须为最多 20 个无账号密码的 HTTPS 链接。`);
    }
    requireValue(Array.isArray(question.options) && question.options.length >= 2 && question.options.length <= 26, `${label}须有 2 至 26 个选项。`);
    const optionIds = new Set();
    for (const option of question.options) {
      requireValue(record(option) && validId(option.id) && !optionIds.has(option.id) && nonemptyText(option.text, 10000), `${label}选项须有唯一 id 和非空 text。`);
      optionIds.add(option.id);
    }
    requireValue(Array.isArray(question.answer) && question.answer.length > 0 && question.answer.length <= optionIds.size &&
      new Set(question.answer).size === question.answer.length && question.answer.every(id => typeof id === 'string' && optionIds.has(id)), `${label} answer 须为不重复的有效选项 id 数组。`);
    requireValue(question.type !== 'single' || question.answer.length === 1, `${label}单选题只能有一个标准答案。`);
  }
  return value;
}

export function importQuestionBank({ sourcePath, targetPath, dataDir, replace = false, checkOnly = false }) {
  const source = path.resolve(sourcePath), target = path.resolve(targetPath);
  const stat = fs.statSync(source);
  requireValue(stat.isFile() && stat.size <= MAX_BYTES, '题库须为不超过 32 MiB 的普通 JSON 文件。');
  const bytes = fs.readFileSync(source);
  requireValue(bytes.byteLength <= MAX_BYTES, '题库超过 32 MiB 限制。');
  let questions;
  try { questions = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('题库不是有效的 UTF-8 JSON；原题库未更改。'); }
  validateQuestionBankImport(questions);
  if (checkOnly) return { count: questions.length, checked: true };
  requireValue(source !== target, '来源文件与目标题库相同；只校验请使用 --check。');
  const release = acquireStorageLock(dataDir);
  let temporary;
  try {
    const exists = fs.existsSync(target);
    requireValue(!exists || replace, '目标题库已存在，未覆盖。替换前请备份学习数据，并显式使用 --replace。');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    temporary = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    let backupPath;
    if (exists) {
      backupPath = path.join(dataDir, 'backups', `question-bank-${Date.now()}-${randomUUID()}.json`);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, target);
    } else {
      // COPYFILE_EXCL also refuses a target created after the initial existence check.
      fs.copyFileSync(temporary, target, fs.constants.COPYFILE_EXCL);
    }
    return { count: questions.length, targetPath: target, ...(backupPath ? { backupPath } : {}) };
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    release();
  }
}
