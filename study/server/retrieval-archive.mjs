import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { questionFingerprint } from './preanalysis.mjs';
import { isDeepSeekBaseUrl, retrieveQuestionSources } from './deepseek-retrieval.mjs';
import { deriveSavedSearchTextRecovery } from './retrieval-recovery.mjs';

const MAX_RECORDS = 10000;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const allowedStates = new Set(['running', 'completed', 'failed', 'unknown']);
// Search also depends on category and knowledge point, beyond the answer hash.
export const RETRIEVAL_RULE_VERSION = 2;
export const retrievalQuestionFingerprint = question => hash(JSON.stringify([
  RETRIEVAL_RULE_VERSION, questionFingerprint(question), question.category ?? '', question.knowledgePoint ?? '',
]));

export class RetrievalArchiveError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Independent, private source archive. Never reads or writes personal learning data. */
export function createRetrievalArchive({ dataDir, getQuestion, getQuestions, getSettings, atomicJson,
  fetchImpl = globalThis.fetch, now = Date.now }) {
  const root = path.join(dataDir, 'retrieval-archive');
  const records = new Map();
  const requestIds = new Map();
  const active = new Set();
  const controllers = new Set();
  let closed = false;
  const timestamp = () => new Date(now()).toISOString();
  const keyFor = entry => `${hash(entry.questionId)}/${entry.questionFingerprint}`;
  const fileFor = key => path.join(root, `${key}.json`);
  const references = (entry, recovery) => ({
    localRecoverySourceCount: recovery?.sourceCount ?? 0,
    referenceAvailable: entry.sources.some(source => typeof source?.content === 'string' && source.content.trim()) || Boolean(recovery?.sourceCount),
  });
  const metadata = (entry, recovery) => ({
    id: entry.id, requestId: entry.requestId, questionId: entry.questionId,
    questionFingerprint: entry.questionFingerprint, questionRevision: entry.questionRevision,
    status: entry.status, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    ...references(entry, recovery),
    sourceCount: entry.sources.length, ...(entry.errorCode ? { errorCode: entry.errorCode, error: entry.error } : {}),
    ...(Number.isInteger(entry.upstreamStatus) ? { upstreamStatus: entry.upstreamStatus } : {}),
    ...(['search', 'fetch'].includes(entry.tool) ? { tool: entry.tool } : {}),
    ...(typeof entry.partial === 'boolean' ? { partial: entry.partial } : {}),
    ...(Array.isArray(entry.sourceErrors) ? { sourceErrors: entry.sourceErrors } : {}),
    ...(Array.isArray(entry.skippedSources) ? { skippedSources: entry.skippedSources } : {}),
    ...(typeof entry.contentPolicy === 'string' ? { contentPolicy: entry.contentPolicy } : {}),
  });
  const validate = entry => {
    if (!entry || entry.version !== 1 || typeof entry.id !== 'string' || typeof entry.requestId !== 'string' ||
        typeof entry.questionId !== 'string' || !fingerprintPattern.test(entry.questionFingerprint) ||
        !Number.isSafeInteger(entry.questionRevision) || !allowedStates.has(entry.status) ||
        !Array.isArray(entry.sources) || !Array.isArray(entry.searchResults) || entry.modelRequested !== false) {
      throw new Error('检索原文档案损坏，已阻止覆盖，请保留文件后检查。');
    }
    return entry;
  };
  // Only known hashed file names are indexed. Full web documents stay on disk.
  if (fs.existsSync(root)) {
    for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
      if (!directory.isDirectory() || !fingerprintPattern.test(directory.name)) continue;
      for (const file of fs.readdirSync(path.join(root, directory.name), { withFileTypes: true })) {
        if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
        const bytes = fs.readFileSync(path.join(root, directory.name, file.name));
        const entry = validate(JSON.parse(bytes.toString('utf8')));
        const key = keyFor(entry);
        if (`${key}.json` !== `${directory.name}/${file.name}` || records.has(key) || requestIds.has(entry.requestId)) {
          throw new Error('检索原文档案身份冲突，已阻止覆盖，请保留文件后检查。');
        }
        records.set(key, metadata(entry, deriveSavedSearchTextRecovery(bytes))); requestIds.set(entry.requestId, key);
        if (records.size > MAX_RECORDS) throw new Error('检索原文档案数量超过容量，请先备份后检查。');
      }
    }
  }
  const put = entry => {
    const key = keyFor(entry);
    atomicJson(fileFor(key), entry);
    // Only terminal failed records can expose saved Search text recovery. Hash
    // the actual durable bytes, never an in-memory JSON serialization.
    const recovery = entry.status === 'failed' ? deriveSavedSearchTextRecovery(fs.readFileSync(fileFor(key))) : undefined;
    records.set(key, metadata(entry, recovery)); requestIds.set(entry.requestId, key);
  };
  const publicEntry = (value, key, recovery) => {
    const entry = structuredClone(value);
    if (Array.isArray(entry.sources)) Object.assign(entry, references(entry, recovery));
    if (recovery) entry.localRecovery = recovery;
    if (entry.status === 'running' && !active.has(key)) {
      entry.status = 'unknown';
      entry.errorCode = 'INTERRUPTED';
      entry.error = '上次检索在完成前中断，结果不明确；不会自动重新请求。';
    }
    let current;
    try { current = getQuestion(entry.questionId); } catch { /* A replaced bank can omit a previous question. */ }
    entry.currentFingerprintMatch = Boolean(current && retrievalQuestionFingerprint(current) === entry.questionFingerprint);
    return entry;
  };
  const read = key => {
    const bytes = fs.readFileSync(fileFor(key));
    return publicEntry(validate(JSON.parse(bytes.toString('utf8'))), key, deriveSavedSearchTextRecovery(bytes));
  };
  const history = questionId => ({ entries: [...records.entries()].filter(([, entry]) => entry.questionId === questionId)
    .map(([key]) => read(key)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  const status = () => {
    const settings = getSettings();
    const counts = { completed: 0, failed: 0, running: 0, unknown: 0 };
    const entries = [...records.entries()].map(([key, entry]) => publicEntry(entry, key));
    for (const entry of entries) counts[entry.status]++;
    return { mode: 'web-retrieval-only', configured: isDeepSeekBaseUrl(settings.baseUrl) && Boolean(settings.key),
      baseUrl: settings.baseUrl, total: getQuestions().length, archived: records.size, ...counts, entries };
  };

  async function retrieve({ question, requestId }) {
    if (closed) throw new RetrievalArchiveError(503, '本机服务正在关闭，未开始检索。', 'SERVICE_CLOSED');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
      throw new RetrievalArchiveError(400, '请提供有效的检索请求编号。', 'INVALID_REQUEST_ID');
    }
    const fingerprint = retrievalQuestionFingerprint(question);
    const key = `${hash(question.id)}/${fingerprint}`;
    const reusedKey = requestIds.get(requestId);
    if (reusedKey && reusedKey !== key) throw new RetrievalArchiveError(409, '该请求编号已用于其他题目版本，未再次请求。', 'REQUEST_ID_CONFLICT');
    if (records.has(key)) return { cached: true, entry: read(key) };
    if (records.size >= MAX_RECORDS) throw new RetrievalArchiveError(507, '检索原文档案容量不足，未开始检索。', 'RETRIEVAL_CAPACITY');
    // Pin provider and credential together, without exposing the key to callers.
    const settings = getSettings();
    if (!isDeepSeekBaseUrl(settings.baseUrl) || !settings.key) {
      throw new RetrievalArchiveError(503, '请先在学习设置配置 DeepSeek 官方 API Key；未发起检索。', 'RETRIEVAL_NOT_CONFIGURED');
    }
    let entry = { version: 1, id: randomUUID(), requestId, questionId: question.id,
      questionFingerprint: fingerprint, questionRevision: question.answerRevision ?? 0,
      status: 'running', createdAt: timestamp(), updatedAt: timestamp(), query: '', searchResults: [], sources: [],
      usage: { searchCalls: 0, fetchCalls: 0, estimatedCostCny: 0 }, modelRequested: false,
      sourceNotice: '来自 Search／Fetch 的外部网页资料，未由模型生成，也未核实为本题正确解析。' };
    // The durable running record is also the per-question/version reservation.
    put(entry);
    active.add(key);
    const controller = new AbortController(); controllers.add(controller);
    try {
      const result = await retrieveQuestionSources({ question, apiKey: settings.key, fetchImpl,
        signal: controller.signal, archive: true,
        onProgress: partial => { entry = { ...entry, ...partial, updatedAt: timestamp() }; put(entry); },
      });
      entry = { ...entry, ...result, status: 'completed', phase: 'completed', updatedAt: timestamp() };
      put(entry);
    } catch (error) {
      entry = { ...entry, status: 'failed', updatedAt: timestamp(), errorCode: error.code ?? 'RETRIEVAL_FAILED',
        error: error.name === 'DeepSeekRetrievalError' ? error.message : '检索或原文保存未完成，请保留档案后检查；不会自动重试。',
        ...(Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599 ? { upstreamStatus: error.upstreamStatus } : {}),
        ...(['search', 'fetch'].includes(error.tool) ? { tool: error.tool } : {}),
      };
      // If writing fails, the last durable running/partial record remains and
      // becomes unknown after restart. Never claim that a failed save succeeded.
      put(entry);
    } finally { active.delete(key); controllers.delete(controller); }
    return { cached: false, entry: entry.status === 'failed' ? read(key) : publicEntry(entry, key) };
  }

  return { retrieve, history, status, close() { closed = true; for (const controller of controllers) controller.abort(); } };
}
