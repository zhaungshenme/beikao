import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createStudyApi } from './api.mjs';
import { createRetrievalArchive, retrievalQuestionFingerprint, RETRIEVAL_RULE_VERSION } from './retrieval-archive.mjs';
import { questionFingerprint } from './preanalysis.mjs';
import { retrieveQuestionSources, ARCHIVE_CONTENT_POLICY, PDF_EXTRACT_CONTENT_POLICY } from './deepseek-retrieval.mjs';

const KEY = 'synthetic-retrieval-key';
const SEARCH = 'https://api.deepseek.com/v1/tools/search';
const FETCH = 'https://api.deepseek.com/v1/tools/fetch';
const URL_A = 'https://docs.python.org/3/library/threading.html';
const URL_B = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript';
const question = { id: 'retrieval-test', category: '理论', knowledgePoint: '同步', chapter: '基础', type: 'single',
  stem: '为何需要同步？', options: [{ id: 'A', text: '共享状态' }, { id: 'B', text: '不共享状态' }],
  answer: ['A'], explanation: '合成测试数据', answerRevision: 0 };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const sourceContent = '  原始正文\n' + '完整网页资料。'.repeat(1800) + '\n  ';

async function harness(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beikao-retrieval-archive-'));
  const questionsPath = path.join(directory, 'questions.json');
  const dataDir = path.join(directory, 'storage');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(questionsPath, JSON.stringify([question]));
  const originalLearning = { version: 1, progress: { [question.id]: { aiNote: '原AI解析必须原样保留', note: '私人笔记', lastAnswer: ['B'] } }, sessions: [] };
  fs.writeFileSync(path.join(dataDir, 'learning-state.json'), JSON.stringify(originalLearning));
  const learningBytes = fs.readFileSync(path.join(dataDir, 'learning-state.json'));
  fs.writeFileSync(path.join(dataDir, 'ai-settings.json'), JSON.stringify({ baseUrl: 'https://api.deepseek.com/v1', model: 'old-model', apiKey: KEY }));
  const calls = [];
  let fetchCount = 0;
  const fetchImpl = async (url, init) => {
    assert.ok([SEARCH, FETCH].includes(url), '模型或第三方网页请求不得触达网络');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (options.fetchImpl) return options.fetchImpl(url, init, calls.length);
    if (url === SEARCH) return json({ results: [{ title: 'Python', url: URL_A }, { title: 'MDN', url: URL_B }] });
    fetchCount++;
    if (options.failSecondFetch && fetchCount === 2) return json({ error: KEY }, 429);
    return json({ title: `Source ${fetchCount}`, content: sourceContent });
  };
  let api;
  let server;
  let base;
  const start = async () => {
    api = createStudyApi({ dataDir, questionsPath, fetchImpl, allowLegacyWebBridge: options.allowLegacyWebBridge === true });
    server = createServer((req, res) => api.handle(req, res));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/study-api`;
  };
  const stop = async () => {
    api?.close();
    if (server?.listening) {
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeAllConnections?.(); await stopped;
    }
  };
  t.after(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await start();
  return {
    dataDir, calls, questionsPath, learningBytes,
    async restart() { await stop(); await start(); },
    async request(route, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    retrieve(requestId = 'request-first-1234') { return this.request('/ai/retrieve', { questionId: question.id, expectedQuestionRevision: 0, requestId }); },
  };
}

test('只调用Search/Fetch，完整原文保存且不动个人解析、笔记或学习状态', async t => {
  const f = await harness(t);
  const result = await f.retrieve();
  assert.equal(result.status, 200);
  assert.equal(result.body.cached, false);
  const { entry } = result.body;
  assert.equal(entry.status, 'completed'); assert.equal(entry.modelRequested, false);
  assert.equal(entry.sources[0].content, sourceContent);
  assert.equal(entry.sources[0].contentTruncated, false);
  assert.equal(entry.sources[0].contentEdited, false);
  assert.deepEqual(f.calls.map(call => call.url), [SEARCH, FETCH, FETCH]);
  assert.deepEqual(entry.searchResults.map(item => item.url), [URL_A, URL_B]);
  assert.ok(!JSON.stringify(f.calls).includes('私人笔记'));
  assert.ok(!JSON.stringify(f.calls).includes('原AI解析'));
  assert.ok(!JSON.stringify(result.body).includes(KEY));
  assert.deepEqual(fs.readFileSync(path.join(f.dataDir, 'learning-state.json')), f.learningBytes);
  const status = await f.request('/retrieval/status');
  assert.equal(status.body.completed, 1); assert.equal(status.body.entries[0].sourceCount, 2);
  assert.equal(status.body.entries[0].currentFingerprintMatch, true);
  const history = await f.request(`/questions/${question.id}/retrieval-history`);
  assert.equal(history.body.entries[0].sources[1].content, sourceContent);
});

test('缓存与重启不重发，同题新requestId仍复用当前完整档案', async t => {
  const f = await harness(t);
  const first = await f.retrieve();
  await f.restart();
  const again = await f.retrieve('request-second-1234');
  assert.equal(again.body.cached, true); assert.equal(again.body.entry.id, first.body.entry.id);
  assert.equal(f.calls.length, 3);
});

test('部分失败保留已抓原文和发送计数，失败档案不自动重试', async t => {
  const f = await harness(t, { failSecondFetch: true });
  const result = await f.retrieve();
  assert.equal(result.body.entry.status, 'failed');
  assert.equal(result.body.entry.errorCode, 'RATE_LIMITED');
  assert.equal(result.body.entry.sources.length, 1);
  assert.equal(result.body.entry.sources[0].content, sourceContent);
  assert.equal(result.body.entry.usage.fetchCalls, 2);
  await f.retrieve('request-try-again-1234');
  await f.restart(); await f.retrieve('request-after-restart-1234');
  assert.equal(f.calls.length, 3);
});

test('旧生成路由固定410，模型参数和legacy flag不能恢复生成网络', async t => {
  const f = await harness(t, { allowLegacyWebBridge: true });
  for (const payload of [{}, { questionId: question.id, model: 'anything', retrievalEnabled: false }, { transport: 'official-api', force: true }]) {
    const result = await f.request('/ai/explain', payload);
    assert.equal(result.status, 410); assert.equal(result.body.modelRequested, false);
  }
  assert.equal(f.calls.length, 0);
});

test('非官方网关不能保存，旧model和联网开关不能改变仅检索模式', async t => {
  const f = await harness(t);
  const gateway = await f.request('/ai/settings', { baseUrl: 'https://gateway.invalid/v1' }, 'PUT');
  assert.equal(gateway.status, 400);
  const update = await f.request('/ai/settings', { baseUrl: 'https://api.deepseek.com/v1', model: 'please-generate', retrievalEnabled: false }, 'PUT');
  assert.equal(update.status, 200); assert.equal(update.body.mode, 'web-retrieval-only');
  assert.equal(update.body.model, ''); assert.equal(update.body.retrievalEnabled, true);
  assert.equal(f.calls.length, 0);
});

test('版本或多余私人字段被拒绝时零网络', async t => {
  const f = await harness(t);
  for (const body of [
    { questionId: question.id, expectedQuestionRevision: 1, requestId: 'request-invalid-1234' },
    { questionId: question.id, expectedQuestionRevision: 0, requestId: 'request-private-1234', answer: ['B'] },
  ]) {
    const result = await f.request('/ai/retrieve', body);
    assert.ok(result.status >= 400);
  }
  assert.equal(f.calls.length, 0);
});

test('同题同时请求只有一个网络序列，另一请求返回已持久running档案', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let entered;
  const enteredSearch = new Promise(resolve => { entered = resolve; });
  const f = await harness(t, { fetchImpl: async (url, init) => {
    if (url === SEARCH) { entered(); await wait; return json({ results: [{ url: URL_A, title: 'Python' }] }); }
    return json({ content: '同步资料' });
  } });
  const first = f.retrieve(); await enteredSearch;
  const second = await f.retrieve('request-concurrent-1234');
  assert.equal(second.body.cached, true); assert.equal(second.body.entry.status, 'running');
  release(); assert.equal((await first).body.entry.status, 'completed');
  assert.equal(f.calls.length, 2);
});

test('知识点或科目变化会改变检索身份；旧档案不冒充当前版本', async t => {
  const f = await harness(t); await f.retrieve();
  const changed = { ...question, knowledgePoint: '已修改的检索知识点' };
  assert.notEqual(retrievalQuestionFingerprint(changed), retrievalQuestionFingerprint(question));
  fs.writeFileSync(f.questionsPath, JSON.stringify([changed])); await f.restart();
  const history = await f.request(`/questions/${question.id}/retrieval-history`);
  assert.equal(history.body.entries[0].currentFingerprintMatch, false);
  const next = await f.retrieve('request-changed-1234');
  assert.equal(next.body.cached, false); assert.equal(f.calls.length, 6);
});

test('进程中断的running档案读取为unknown，不盲重发；首次落盘失败零网络', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beikao-retrieval-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const options = { dataDir: directory, getQuestion: () => question, getQuestions: () => [question],
    getSettings: () => ({ baseUrl: 'https://api.deepseek.com/v1', key: KEY }), fetchImpl: async () => { calls++; throw new Error('offline'); },
    atomicJson: () => { throw new Error('disk full'); } };
  const denied = createRetrievalArchive(options);
  await assert.rejects(denied.retrieve({ question, requestId: 'request-disk-failure' }));
  assert.equal(calls, 0);
  const fingerprint = retrievalQuestionFingerprint(question);
  const { createHash } = await import('node:crypto');
  const subdir = path.join(directory, 'retrieval-archive', createHash('sha256').update(question.id).digest('hex'));
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, `${fingerprint}.json`), JSON.stringify({ version: 1, id: 'interrupted-id', requestId: 'interrupted-request',
    questionId: question.id, questionFingerprint: fingerprint, questionRevision: 0, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    modelRequested: false, sources: [], searchResults: [], query: '', usage: { searchCalls: 1, fetchCalls: 0, estimatedCostCny: 0.005 } }));
  const restored = createRetrievalArchive(options);
  const cached = await restored.retrieve({ question, requestId: 'never-resend-this' });
  assert.equal(cached.cached, true); assert.equal(cached.entry.status, 'unknown'); assert.equal(calls, 0);
});

test('完整原文只作安全脱敏且标明编辑，不静默截断', async t => {
  const raw = `  ${sourceContent}\u0001${KEY}\n`;
  const f = await harness(t, { fetchImpl: async url => url === SEARCH
    ? json({ results: [{ url: URL_A, title: `标题${KEY}` }] })
    : json({ title: '正文', content: raw }) });
  const result = await f.retrieve();
  assert.equal(result.body.entry.status, 'completed');
  assert.equal(result.body.entry.searchResultsEdited, true);
  assert.equal(result.body.entry.sources[0].content, raw.replace('\u0001', '').replaceAll(KEY, '[已隐藏]'));
  assert.equal(result.body.entry.sources[0].contentEdited, true);
  assert.equal(result.body.entry.sources[0].contentTruncated, false);
  assert.ok(!JSON.stringify(result.body).includes(KEY));
});

test('完整结果落盘失败不冒充completed，已取网页仍保留为failed证据', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beikao-retrieval-save-failure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createRetrievalArchive({ dataDir: directory, getQuestion: () => question, getQuestions: () => [question],
    getSettings: () => ({ baseUrl: 'https://api.deepseek.com/v1', key: KEY }),
    fetchImpl: async url => url === SEARCH ? json({ results: [{ url: URL_A, title: 'Python' }] }) : json({ content: sourceContent }),
    atomicJson: (file, entry) => {
      if (entry.status === 'completed') throw new Error('disk full');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(entry));
    } });
  const result = await store.retrieve({ question, requestId: 'request-final-save-failure' });
  assert.equal(result.entry.status, 'failed'); assert.equal(result.entry.sources[0].content, sourceContent);
  assert.equal(store.status().completed, 0); assert.equal(store.status().failed, 1);
});

test('上游HTTP错误保留安全status/tool诊断，不读取错误正文或自动重试', async t => {
  for (const upstreamStatus of [401, 402, 403, 429, 404, 500]) for (const tool of ['search', 'fetch']) {
    const f = await harness(t, { fetchImpl: async url => {
      if (tool === 'fetch' && url === SEARCH) return json({ results: [{ url: URL_A, title: 'Python' }] });
      return new Response(KEY, { status: upstreamStatus });
    } });
    const result = await f.retrieve();
    const { entry } = result.body;
    assert.equal(entry.status, 'failed'); assert.equal(entry.upstreamStatus, upstreamStatus); assert.equal(entry.tool, tool);
    assert.ok(entry.error.includes(`HTTP ${upstreamStatus}`)); assert.ok(!JSON.stringify(result.body).includes(KEY));
    await f.retrieve('request-never-retry-errors');
    assert.equal(f.calls.length, tool === 'search' ? 1 : 2);
    const status = await f.request('/retrieval/status');
    assert.equal(status.body.entries[0].upstreamStatus, upstreamStatus); assert.equal(status.body.entries[0].tool, tool);
  }
});

test('归档模式跳过无Search正文的公开PDF，保留证据且只Fetch后续两份网页', async t => {
  const pdf = 'https://patentimages.storage.googleapis.com/example%2EPDF#page=1';
  const fetched = [];
  const f = await harness(t, { fetchImpl: async (url, init) => {
    if (url === SEARCH) return json({ results: [{ url: pdf, title: 'PDF文件' }, { url: URL_A, title: '网页一' }, { url: URL_B, title: '网页二' }] });
    fetched.push(JSON.parse(init.body).url);
    return json({ title: '网页正文', content: sourceContent });
  } });
  const result = await f.retrieve();
  assert.equal(result.body.entry.status, 'completed'); assert.deepEqual(fetched, [URL_A, URL_B]);
  assert.equal(result.body.entry.skippedSources.length, 1);
  assert.equal(result.body.entry.skippedSources[0].reason, 'non-web-file');
  assert.equal(result.body.entry.sources.length, 2); assert.equal(result.body.entry.usage.fetchCalls, 2);
  assert.equal(result.body.entry.modelRequested, false);
});

test('首个来源Fetch403后允许下一个唯一来源成功，completed明确标注partial', async t => {
  const fetched = [];
  const f = await harness(t, { fetchImpl: async (url, init) => {
    if (url === SEARCH) return json({ results: [{ url: URL_A }, { url: URL_B }, { url: 'https://www.python.org/extra' }] });
    const target = JSON.parse(init.body).url; fetched.push(target);
    return target === URL_A ? json({ error: KEY }, 403) : json({ content: sourceContent });
  } });
  const result = await f.retrieve(); const { entry } = result.body;
  assert.equal(entry.status, 'completed'); assert.equal(entry.partial, true);
  assert.equal(entry.sources.length, 1); assert.equal(entry.sources[0].url, URL_B);
  assert.equal(entry.sourceErrors[0].code, 'SOURCE_BLOCKED'); assert.equal(entry.sourceErrors[0].upstreamStatus, 403);
  assert.deepEqual(fetched, [URL_A, URL_B]); assert.equal(entry.usage.fetchCalls, 2);
  assert.equal(entry.modelRequested, false); assert.ok(!JSON.stringify(result.body).includes(KEY));
  const status = await f.request('/retrieval/status');
  assert.equal(status.body.entries[0].partial, true); assert.equal(status.body.entries[0].sourceErrors.length, 1);
});

test('来源403及404全部失败时仍failed，重复URL和三条以上结果不增加Fetch预算', async t => {
  const fetched = [];
  const f = await harness(t, { fetchImpl: async (url, init) => {
    if (url === SEARCH) return json({ results: [{ url: URL_A }, { url: `${URL_A}#duplicate` }, { url: URL_B }, { url: 'https://www.python.org/ignored' }] });
    const target = JSON.parse(init.body).url; fetched.push(target);
    return json({ error: 'source unavailable' }, target === URL_A ? 403 : 404);
  } });
  const result = await f.retrieve(); const { entry } = result.body;
  assert.equal(entry.status, 'failed'); assert.equal(entry.sources.length, 0); assert.equal(entry.sourceErrors.length, 2);
  assert.equal(entry.errorCode, 'SOURCE_NOT_FOUND'); assert.equal(entry.upstreamStatus, 404);
  assert.deepEqual(fetched, [URL_A, URL_B]); assert.equal(entry.usage.fetchCalls, 2);
  await f.retrieve('request-do-not-repeat-unavailable'); assert.equal(fetched.length, 2);
});

test('全部明显非网页文件时只Search不Fetch，保存跳过证据而非宣称成功', async t => {
  const f = await harness(t, { fetchImpl: async url => {
    assert.equal(url, SEARCH);
    return json({ results: [{ url: 'https://www.python.org/file.pdf' }, { url: 'https://www.python.org/file.docx' }, { url: 'https://www.python.org/file.zip' }] });
  } });
  const result = await f.retrieve();
  assert.equal(result.body.entry.status, 'failed'); assert.equal(result.body.entry.skippedSources.length, 3);
  assert.equal(result.body.entry.usage.fetchCalls, 0); assert.equal(result.body.entry.sources.length, 0); assert.equal(f.calls.length, 1);
});

test('旧非归档完整性模式仍在首个Fetch403或404时停止，不采用部分结果', async () => {
  for (const status of [403, 404]) {
    const calls = [];
    await assert.rejects(retrieveQuestionSources({ question, apiKey: KEY, fetchImpl: async (url, init) => {
      calls.push(url);
      if (url === SEARCH) return json({ results: [{ url: URL_A }, { url: URL_B }] });
      return json({ error: 'unavailable' }, status);
    } }), { code: status === 403 ? 'SOURCE_BLOCKED' : 'SOURCE_NOT_FOUND', upstreamStatus: status, tool: 'fetch' });
    assert.deepEqual(calls, [SEARCH, FETCH]);
  }
});

test('归档模式Fetch鉴权、额度、限速及服务器错误均立即停止，不抓备用来源', async t => {
  for (const status of [401, 402, 429, 500]) {
    const f = await harness(t, { fetchImpl: async url => url === SEARCH
      ? json({ results: [{ url: URL_A }, { url: URL_B }] })
      : json({ error: 'must stop' }, status) });
    const result = await f.retrieve();
    assert.equal(result.body.entry.status, 'failed'); assert.equal(result.body.entry.upstreamStatus, status);
    assert.equal(f.calls.length, 2); assert.equal(result.body.entry.sources.length, 0);
    assert.equal(result.body.entry.sourceErrors.length, 0);
  }
});

test('v2归档请求Search正文，403/404时保留相同URL完整原文并明确来源', async t => {
  for (const status of [403, 404]) {
    const original = `  Search完整正文\n${'网页内容。'.repeat(1600)}\n `;
    const f = await harness(t, { fetchImpl: async (url, init) => {
      if (url === SEARCH) {
        assert.equal(JSON.parse(init.body).need_content, true);
        return json({ results: [{ url: URL_A, title: 'Search正文', content: original }, { url: URL_B, title: '另一个网页' }] });
      }
      return JSON.parse(init.body).url === URL_A ? json({ error: 'unavailable' }, status) : json({ content: sourceContent });
    } });
    const result = await f.retrieve(); const { entry } = result.body;
    assert.equal(entry.status, 'completed'); assert.equal(entry.partial, true);
    const searchSource = entry.sources.find(source => source.url === URL_A);
    assert.equal(searchSource.content, original); assert.equal(searchSource.contentOrigin, 'search');
    assert.equal(searchSource.contentTruncated, false);
    assert.equal(entry.sources.find(source => source.url === URL_B).contentOrigin, 'fetch');
    assert.equal(entry.usage.searchCalls, 1); assert.equal(entry.usage.fetchCalls, 2);
  }
});

test('Fetch成功会按相同URL替换Search正文，两个唯一来源和调用上限不变', async t => {
  const f = await harness(t, { fetchImpl: async (url, init) => url === SEARCH
    ? json({ results: [{ url: URL_A, content: 'Search正文一' }, { url: `${URL_A}#重复`, content: '不能成为第三来源' }, { url: URL_B, content: 'Search正文二' }] })
    : json({ content: sourceContent }) });
  const result = await f.retrieve();
  assert.equal(result.body.entry.status, 'completed'); assert.equal(result.body.entry.sources.length, 2);
  assert.ok(result.body.entry.sources.every(source => source.contentOrigin === 'fetch' && source.content === sourceContent));
  assert.equal(new Set(result.body.entry.sources.map(source => source.url)).size, 2); assert.equal(f.calls.length, 3);
});

test('Search摘要或snippet不能冒充原文，Fetch无正文时不宣称成功', async t => {
  const f = await harness(t, { fetchImpl: async url => url === SEARCH
    ? json({ results: [{ url: URL_A, snippet: '摘要不是正文', summary: '总结不是正文', content: '  ' }] })
    : json({ error: 'unavailable' }, 404) });
  const result = await f.retrieve();
  assert.equal(result.body.entry.status, 'failed'); assert.equal(result.body.entry.sources.length, 0);
  assert.equal(result.body.entry.searchResults[0].snippet, '摘要不是正文'); assert.equal(f.calls.length, 2);
});

test('已有Search正文不能掩盖Fetch401/402/429，保留原文证据但仍failed且立即停', async t => {
  for (const status of [401, 402, 429]) {
    const f = await harness(t, { fetchImpl: async url => url === SEARCH
      ? json({ results: [{ url: URL_A, content: 'Search已取原文' }, { url: URL_B, content: '另一原文' }] })
      : json({ error: 'must stop' }, status) });
    const result = await f.retrieve();
    assert.equal(result.body.entry.status, 'failed'); assert.equal(result.body.entry.upstreamStatus, status);
    assert.equal(result.body.entry.sources.length, 2); assert.ok(result.body.entry.sources.every(source => source.contentOrigin === 'search'));
    assert.equal(f.calls.length, 2);
  }
});

test('Fetch连接失败或5xx仅可用已有Search正文部分完成，并停止所有后续网络', async t => {
  for (const kind of ['connection', 500, 503]) {
    const f = await harness(t, { fetchImpl: async url => {
      if (url === SEARCH) return json({ results: [{ url: URL_A, content: '原文一' }, { url: URL_B, content: '原文二' }] });
      if (kind === 'connection') throw new Error('connection failed');
      return json({ error: 'upstream failed' }, kind);
    } });
    const result = await f.retrieve();
    assert.equal(result.body.entry.status, 'completed'); assert.equal(result.body.entry.partial, true);
    assert.equal(result.body.entry.sources.length, 2); assert.equal(result.body.entry.sourceErrors.length, 1);
    assert.equal(result.body.entry.sourceErrors[0].code, kind === 'connection' ? 'CONNECTION_FAILED' : 'UPSTREAM_FAILED');
    assert.equal(f.calls.length, 2); assert.equal(result.body.entry.usage.fetchCalls, 1);
  }
});

test('Fetch超时已有Search正文时部分完成且不发下个Fetch，发送前已持久正文', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beikao-search-fallback-timeout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const saved = [];
  let entered;
  const fetching = new Promise(resolve => { entered = resolve; });
  const store = createRetrievalArchive({ dataDir: directory, getQuestion: () => question, getQuestions: () => [question],
    getSettings: () => ({ baseUrl: 'https://api.deepseek.com/v1', key: KEY }),
    atomicJson: (_, entry) => saved.push(structuredClone(entry)),
    fetchImpl: async url => {
      calls.push(url);
      if (url === SEARCH) return json({ results: [{ url: URL_A, content: sourceContent }, { url: URL_B, content: '第二份Search正文' }] });
      assert.equal(saved.at(-1).sources[0].content, sourceContent); assert.equal(saved.at(-1).sources[0].contentOrigin, 'search');
      entered(); return new Promise(() => {});
    } });
  const pending = store.retrieve({ question, requestId: 'request-timeout-search-fallback' });
  await fetching; t.mock.timers.tick(10000);
  const result = await pending;
  assert.equal(result.entry.status, 'completed'); assert.equal(result.entry.partial, true);
  assert.equal(result.entry.sources.length, 2); assert.equal(result.entry.sourceErrors[0].code, 'TIMEOUT');
  assert.deepEqual(calls, [SEARCH, FETCH]); assert.equal(result.entry.usage.fetchCalls, 1);
});

test('v2规则让v1档案仅保留旧历史，不重写旧终态或误作当前缓存', async t => {
  assert.equal(RETRIEVAL_RULE_VERSION, 2);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beikao-search-v2-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { createHash } = await import('node:crypto');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const oldFingerprint = hash(JSON.stringify([1, questionFingerprint(question), question.category, question.knowledgePoint]));
  const file = path.join(directory, 'retrieval-archive', hash(question.id), `${oldFingerprint}.json`);
  const entry = { version: 1, id: 'v1-failed', requestId: 'old-v1-request', questionId: question.id, questionFingerprint: oldFingerprint,
    questionRevision: 0, status: 'failed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), modelRequested: false,
    sources: [], searchResults: [], query: '', usage: { searchCalls: 1, fetchCalls: 1, estimatedCostCny: 0.01 }, errorCode: 'TIMEOUT' };
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(entry));
  const bytes = fs.readFileSync(file);
  const store = createRetrievalArchive({ dataDir: directory, getQuestion: () => question, getQuestions: () => [question],
    getSettings: () => ({ baseUrl: 'https://api.deepseek.com/v1', key: KEY }), atomicJson: () => { throw new Error('should not write'); } });
  assert.notEqual(retrievalQuestionFingerprint(question), oldFingerprint);
  assert.equal(store.history(question.id).entries[0].currentFingerprintMatch, false);
  assert.equal(store.history(question.id).entries[0].status, 'failed'); assert.deepEqual(fs.readFileSync(file), bytes);
});

test('PDF采用Search已返摘录且从不Fetch，HTML仍Fetch，最多两份唯一来源', async t => {
  const pdf = 'https://www.python.org/reference%2EPDF#page=3';
  const original = '  Search返回的PDF片段\n保留空白。  ';
  const fetched = [];
  const f = await harness(t, { fetchImpl: async (url, init) => {
    if (url === SEARCH) return json({ results: [{ url: pdf, title: 'PDF摘录', content: original },
      { url: URL_A, title: '网页', content: 'Search网页正文' }, { url: URL_B, content: '预算外网页正文' }] });
    fetched.push(JSON.parse(init.body).url); return json({ content: sourceContent });
  } });
  const { body: { entry } } = await f.retrieve();
  assert.equal(entry.status, 'completed'); assert.equal(entry.contentPolicy, ARCHIVE_CONTENT_POLICY);
  assert.deepEqual(fetched, [URL_A]); assert.equal(entry.sources.length, 2);
  assert.deepEqual(entry.usage, { searchCalls: 1, fetchCalls: 1, estimatedCostCny: 0.01 });
  const document = entry.sources[0];
  assert.equal(document.url, 'https://www.python.org/reference%2EPDF'); assert.equal(document.content, original);
  assert.equal(document.contentOrigin, 'search'); assert.equal(document.sourceKind, 'document-extract');
  assert.equal(document.documentType, 'pdf'); assert.equal(document.fetchSkipped, true);
  assert.equal(document.contentPolicy, PDF_EXTRACT_CONTENT_POLICY); assert.equal(document.resultIndex, 0);
  assert.equal(document.originalUrl, pdf); assert.equal(document.originalFragment, 'page=3');
  assert.equal(entry.sources[1].sourceKind, 'web-page'); assert.equal(entry.sources[1].contentOrigin, 'fetch');
  assert.equal(entry.skippedSources[0].reason, 'pdf-fetch-skipped');
  assert.match(entry.skippedSources[0].notice, /不代表完整 PDF/);
  assert.equal(entry.localRecovery, undefined); assert.equal(entry.localRecoverySourceCount, 0); assert.equal(entry.referenceAvailable, true);
});

test('两个PDF只Search零Fetch，首个空片段不挡后续有效body且不拼接', async t => {
  const pdf = 'https://www.python.org/reference.pdf';
  const f = await harness(t, { fetchImpl: async url => {
    assert.equal(url, SEARCH);
    return json({ results: [{ url: `${pdf}#page=1`, content: '  ' },
      { url: `${pdf}#page=2`, content: '第二页已返回文字' },
      { url: 'https://www.sqlite.org/notes.pdf#page=4', content: '另一个PDF文字' }] });
  } });
  const { body: { entry } } = await f.retrieve();
  assert.equal(entry.status, 'completed'); assert.equal(entry.sources.length, 2); assert.equal(f.calls.length, 1);
  assert.equal(entry.usage.fetchCalls, 0); assert.equal(entry.usage.estimatedCostCny, 0.005);
  assert.equal(entry.sources[0].content, '第二页已返回文字'); assert.equal(entry.sources[0].resultIndex, 1);
  assert.equal(entry.sources[0].originalFragment, 'page=2');
  assert.ok(entry.sources.every(source => source.fetchSkipped && source.documentType === 'pdf'));
});

test('图片可执行和归档文件有Search文字仍不接受，snippet或summary也不能代替PDF正文', async t => {
  for (const results of [
    ['png', 'exe', 'zip'].map(extension => ({ url: `https://www.python.org/file.${extension}`, content: '不是可用PDF文字' })),
    [{ url: 'https://www.python.org/a.pdf', snippet: '不是正文' },
      { url: 'https://www.python.org/b.pdf', summary: '不是正文' }, { url: 'https://www.python.org/c.pdf', content: ' \n ' }],
  ]) {
    const f = await harness(t, { fetchImpl: async url => { assert.equal(url, SEARCH); return json({ results }); } });
    const { body: { entry } } = await f.retrieve();
    assert.equal(entry.status, 'failed'); assert.equal(entry.errorCode, 'NO_PUBLIC_SOURCES');
    assert.equal(entry.sources.length, 0); assert.equal(entry.localRecovery, undefined);
    assert.equal(entry.referenceAvailable, false); assert.equal(entry.usage.fetchCalls, 0); assert.equal(f.calls.length, 1);
  }
});

function archivedFixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beikao-saved-pdf-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = { version: 1, id: 'saved-v2-failed', requestId: 'saved-v2-request', questionId: question.id,
    questionFingerprint: retrievalQuestionFingerprint(question), questionRevision: 0,
    status: 'failed', errorCode: 'NO_PUBLIC_SOURCES', error: '原失败理由必须原样保留',
    createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', modelRequested: false,
    query: '原查询', usage: { searchCalls: 1, fetchCalls: 0, estimatedCostCny: 0.005 }, sources: [],
    searchResults: [{ url: 'https://www.python.org/reference.pdf#page=5', title: '已存Search结果', content: '  原PDF文字\n  ' }],
    ...overrides };
  const file = path.join(directory, 'retrieval-archive', createHash('sha256').update(question.id).digest('hex'), `${entry.questionFingerprint}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `\n${JSON.stringify(entry, null, 2)}\n`);
  const bytes = fs.readFileSync(file);
  const store = createRetrievalArchive({ dataDir: directory, getQuestion: () => question, getQuestions: () => [question],
    getSettings: () => ({ baseUrl: 'https://api.deepseek.com/v1', key: KEY }),
    atomicJson: () => assert.fail('读取档案不得写文件'), fetchImpl: () => assert.fail('读取档案不得联网') });
  return { entry, store, file, bytes, directory };
}

test('旧v2失败只读显示本地PDF恢复，实际父字节SHA准确且终态错误费用与raw不变', async t => {
  const f = archivedFixture(t);
  const history = f.store.history(question.id).entries[0];
  const cached = await f.store.retrieve({ question, requestId: 'new-id-must-not-request' });
  assert.equal(cached.cached, true); assert.deepEqual(cached.entry, history);
  for (const field of ['id', 'status', 'errorCode', 'error', 'updatedAt', 'createdAt', 'sources', 'searchResults', 'usage']) {
    assert.deepEqual(history[field], f.entry[field], field);
  }
  assert.equal(history.currentFingerprintMatch, true); assert.equal(history.localRecoverySourceCount, 1);
  assert.equal(history.referenceAvailable, true); assert.equal(history.localRecovery.sources[0].content, f.entry.searchResults[0].content);
  assert.equal(history.localRecovery.parentArchiveSha256, createHash('sha256').update(f.bytes).digest('hex'));
  assert.equal(history.localRecovery.networkRequested, false); assert.equal(history.localRecovery.modelRequested, false);
  assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  const persisted = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(persisted.localRecovery, undefined); assert.equal(persisted.referenceAvailable, undefined);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), [path.basename(f.file)]);
});

test('status恢复计数在启动时索引，重复检查不重读档案正文也不改变失败计数', t => {
  const f = archivedFixture(t);
  t.mock.method(fs, 'readFileSync', () => assert.fail('status不得反复读取已索引档案'));
  for (let i = 0; i < 3; i++) {
    const status = f.store.status();
    assert.equal(status.failed, 1); assert.equal(status.completed, 0); assert.equal(status.archived, 1);
    assert.equal(status.entries[0].localRecoverySourceCount, 1); assert.equal(status.entries[0].referenceAvailable, true);
    assert.equal(status.entries[0].sources, undefined); assert.equal(status.entries[0].searchResults, undefined);
    assert.equal(status.entries[0].localRecovery, undefined);
  }
});

test('既有v2成功档案保持当前身份原字节且不派生恢复、不重发或升级规则', async t => {
  const f = archivedFixture(t, { status: 'completed', sources: [{ id: 'S1', url: URL_A, content: '已保存的完整网页正文' }] });
  assert.equal(RETRIEVAL_RULE_VERSION, 2);
  const expectedFingerprint = createHash('sha256').update(JSON.stringify([2, questionFingerprint(question), question.category, question.knowledgePoint])).digest('hex');
  assert.equal(retrievalQuestionFingerprint(question), expectedFingerprint);
  const cached = await f.store.retrieve({ question, requestId: 'do-not-refetch-v2-completed' });
  assert.equal(cached.cached, true); assert.equal(cached.entry.status, 'completed'); assert.equal(cached.entry.currentFingerprintMatch, true);
  assert.equal(cached.entry.localRecovery, undefined); assert.equal(cached.entry.localRecoverySourceCount, 0);
  assert.deepEqual(cached.entry.sources, f.entry.sources); assert.deepEqual(fs.readFileSync(f.file), f.bytes);
});
