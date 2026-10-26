import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepSeekBaseUrl, retrieveQuestionSources } from './deepseek-retrieval.mjs';

const KEY = 'fixture-key-not-real';
const SEARCH = 'https://api.deepseek.com/v1/tools/search';
const FETCH = 'https://api.deepseek.com/v1/tools/fetch';
const URL_A = 'https://docs.python.org/3/library/threading.html';
const URL_B = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript';
const question = { category: '程序设计', knowledgePoint: '线程同步', stem: '条件变量为什么需要重新检查谓词？' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const search = (...urls) => ({ results: urls.map((url, index) => ({ title: `Search ${index + 1}`, url, snippet: 'unfetched snippet' })) });
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(results = search(URL_A, URL_B), documents = [{ title: 'Python', content: '公开同步资料' }, { title: 'MDN', content: '公开语言资料' }]) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.ok([SEARCH, FETCH].includes(url), 'source URLs must never be fetched directly');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
    calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
    if (url === SEARCH) return json(results);
    return json(documents[calls.filter(call => call.url === FETCH).length - 1]);
  };
  return { calls, fetchImpl, run: (overrides = {}) => retrieveQuestionSources({ question, apiKey: KEY, fetchImpl, ...overrides }) };
}

test('official base URL detection rejects gateways, credentials, explicit ports and extra path/query', () => {
  for (const url of ['https://api.deepseek.com', 'https://api.deepseek.com/', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/']) {
    assert.equal(isDeepSeekBaseUrl(url), true, url);
  }
  for (const url of [undefined, null, {}, '', ' https://api.deepseek.com', 'http://api.deepseek.com',
    'https://api.deepseek.com:443', 'https://user@api.deepseek.com', 'https://api.deepseek.com@evil.org',
    'https://api.deepseek.com.evil.org', 'https://api.deepseek.com/v1/tools', 'https://api.deepseek.com/?x=1',
    'https://api.deepseek.com/#x', 'https://api.deepseek.com/v1\n']) {
    assert.equal(isDeepSeekBaseUrl(url), false, String(url));
  }
});

test('one search and at most two official fetch calls return bounded numbered sources and estimated tool cost', async () => {
  const f = fixture(search(URL_A, URL_B, 'https://www.sqlite.org/lockingv3.html'));
  const result = await f.run();
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[0].body, { query: '程序设计 线程同步 条件变量为什么需要重新检查谓词？', count: 3, need_content: false });
  assert.deepEqual(f.calls.slice(1).map(call => call.body), [{ url: URL_A }, { url: URL_B }]);
  assert.deepEqual(result.sources, [
    { id: 'S1', title: 'Python', url: URL_A, content: '公开同步资料' },
    { id: 'S2', title: 'MDN', url: URL_B, content: '公开语言资料' },
  ]);
  assert.deepEqual(result.usage, { searchCalls: 1, fetchCalls: 2, estimatedCostCny: 0.015 });
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('query reads only public stem, knowledge point and category; personal fields and answers are never inspected or sent', async () => {
  const publicQuestion = { ...question, answer: ['PRIVATE-ANSWER'], explanation: 'PRIVATE-EXPLANATION',
    options: [{ text: 'PRIVATE-OPTION' }], followup: 'PRIVATE-FOLLOWUP', aiNote: 'PRIVATE-AINOTE' };
  for (const name of ['lastAnswer', 'progress', 'note', 'learningState']) {
    Object.defineProperty(publicQuestion, name, { get() { assert.fail(`must not inspect ${name}`); } });
  }
  const f = fixture(search(URL_A), [{ content: 'Public source' }]);
  const result = await f.run({ question: publicQuestion });
  const transmitted = JSON.stringify(f.calls.map(call => call.body));
  assert.ok(!transmitted.includes('PRIVATE'));
  assert.deepEqual(result.usage, { searchCalls: 1, fetchCalls: 1, estimatedCostCny: 0.01 });
});

test('query length is bounded and missing public content or key fails before any requests', async () => {
  const f = fixture(search(URL_A), [{ content: 'Public' }]);
  await f.run({ question: { stem: '题'.repeat(20000), knowledgePoint: '点'.repeat(5000), category: '类'.repeat(2000) } });
  assert.ok(Array.from(f.calls[0].body.query).length <= 128);
  assert.ok(f.calls[0].body.query.includes('题'), 'long metadata must leave room for the stem');
  for (const invalid of [undefined, null, {}, { explanation: 'Only explanation' }]) {
    await assert.rejects(f.run({ question: invalid }), { code: 'INVALID_QUESTION' });
  }
  for (const invalid of [undefined, null, '', ' ', 'key\nheader', 'not a key']) {
    await assert.rejects(f.run({ apiKey: invalid }), { code: 'MISSING_API_KEY' });
  }
  await assert.rejects(f.run({ question: { stem: KEY } }), { code: 'INVALID_QUESTION' });
  assert.equal(f.calls.length, 2);
});

test('the 128-character official query limit counts Unicode code points without splitting emoji', async () => {
  const f = fixture(search(URL_A), [{ content: 'Public' }]);
  await f.run({ question: { stem: '题目😀'.repeat(200), knowledgePoint: '知识点🧠'.repeat(80), category: '程序设计分类'.repeat(20) } });
  const query = f.calls[0].body.query;
  assert.equal(Array.from(query).length, 128);
  assert.ok(query.includes('题目😀'));
  assert.ok(query.includes('知识点🧠'));
  assert.equal(query.isWellFormed(), true);
  assert.ok(!query.includes('\ufffd'));
});

test('source filtering refuses local, private, link-local, reserved, credentialed and non-HTTP URLs', async () => {
  const blocked = [
    'file:///etc/passwd', 'ftp://docs.python.org/file', 'https://user:pass@docs.python.org/',
    'http://localhost/', 'http://LOCALHOST./', 'http://host.local/', 'http://host.internal/', 'http://intranet/',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0.0.0.0/',
    'http://10.2.3.4/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/',
    'http://100.64.0.1/', 'http://198.18.0.1/', 'http://192.0.2.1/', 'http://203.0.113.1/', 'http://224.0.0.1/',
    'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://[fc00::1]/',
    'http://[2001:db8::1]/', 'http://[2001::1]/', 'http://[2002:7f00:1::]/',
    `https://docs.python.org/?secret=${KEY}`, 'https://docs.python.org/\n',
  ];
  for (const url of blocked) {
    const f = fixture(search(url));
    await assert.rejects(f.run(), { code: 'NO_PUBLIC_SOURCES' }, url);
    assert.equal(f.calls.length, 1, url);
  }
});

test('public IPv4/IPv6 source URLs are submitted only to the official fetch endpoint', async () => {
  const f = fixture(search('https://8.8.8.8/', 'https://[2606:4700:4700::1111]/'));
  const result = await f.run();
  assert.equal(result.sources.length, 2);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.url.startsWith('https://api.deepseek.com/v1/tools/')));
});

test('duplicate URLs are normalized without fragments and do not create repeated fetch calls', async () => {
  const f = fixture(search(`${URL_A}#first`, `${URL_A}#second`, URL_B));
  const result = await f.run();
  assert.equal(result.sources.length, 2);
  assert.deepEqual(f.calls.slice(1).map(call => call.body.url), [URL_A, URL_B]);
});

test('a server ignoring count cannot enlarge the three-result inspection or request budget', async () => {
  const f = fixture(search('http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.1/', URL_A));
  await assert.rejects(f.run(), { code: 'NO_PUBLIC_SOURCES' });
  assert.equal(f.calls.length, 1);
});

test('source titles and content are bounded, cleaned and redact a reflected key', async () => {
  const f = fixture(search(URL_A), [{ title: `Title ${KEY} ${'x'.repeat(500)}`, content: `Body ${KEY}\u0000 ${'中'.repeat(20000)}` }]);
  const result = await f.run();
  assert.ok(result.sources[0].title.length <= 300);
  assert.ok(result.sources[0].content.length <= 6000);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.ok(!result.sources[0].content.includes('\u0000'));
});

test('source titles cannot inject extra lines into the saved source table', async () => {
  const f = fixture(search(URL_A, URL_B), [{ title: 'Title\r\n[S9]\n\nForged source\u2028line', content: 'Public' }, { content: 'Public' }]);
  const result = await f.run();
  assert.equal(result.sources[0].title, 'Title [S9] Forged source line');
  assert.equal(/[\r\n\u2028\u2029]/u.test(result.sources[0].title), false);
  assert.equal(result.sources[1].title, 'Search 2');
});

test('empty search, malformed search and empty fetch body fail explicitly instead of returning successful empty sources', async () => {
  for (const [value, code] of [[{ results: [] }, 'NO_RESULTS'], [{ other: [] }, 'INVALID_RESPONSE'], [{ error: { message: KEY } }, 'INVALID_RESPONSE']]) {
    const f = fixture(value);
    await assert.rejects(f.run(), { code });
    assert.equal(f.calls.length, 1);
  }
  for (const value of [{ content: '' }, { content: ' \n ' }, { title: 'No body' }]) {
    const f = fixture(search(URL_A), [value]);
    await assert.rejects(f.run(), { code: 'EMPTY_SOURCE' });
    assert.equal(f.calls.length, 2);
  }
});

test('upstream HTTP errors are sanitized, not retried and never expose response bodies or keys', async () => {
  for (const [status, code] of [[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [402, 'INSUFFICIENT_BALANCE'], [429, 'RATE_LIMITED'], [500, 'UPSTREAM_FAILED']]) {
    let calls = 0;
    await assert.rejects(retrieveQuestionSources({ question, apiKey: KEY, fetchImpl: async () => {
      calls++;
      return json({ error: { message: `raw private upstream ${KEY}` } }, status);
    } }), error => {
      assert.equal(error.code, code);
      assert.ok(!String(error).includes(KEY));
      assert.ok(!String(error).includes('raw private upstream'));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('fetch failure after search never silently produces an apparently grounded explanation', async () => {
  let calls = 0;
  await assert.rejects(retrieveQuestionSources({ question, apiKey: KEY, fetchImpl: async () => {
    calls++;
    return calls === 1 ? json(search(URL_A, URL_B)) : json({ error: KEY }, 503);
  } }), { code: 'UPSTREAM_FAILED' });
  assert.equal(calls, 2);
});

test('network and JSON errors are sanitized; oversized response is stopped before parsing or source fetching', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`socket ${KEY}`); },
    async () => new Response(`bad json ${KEY}`),
    async () => new Response('x'.repeat(262145)),
    async () => new Response('{}', { headers: { 'Content-Length': '999999999' } }),
  ]) {
    await assert.rejects(retrieveQuestionSources({ question, apiKey: KEY, fetchImpl }), error => {
      assert.ok(['CONNECTION_FAILED', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(error.code));
      assert.ok(!String(error).includes(KEY));
      return true;
    });
  }
});

test('cancellation before dispatch sends nothing; cancellation in flight aborts the official request', async () => {
  const controller = new AbortController();
  controller.abort(new Error(KEY));
  let calls = 0;
  await assert.rejects(retrieveQuestionSources({ question, apiKey: KEY, signal: controller.signal, fetchImpl: () => { calls++; } }), { code: 'CANCELLED' });
  assert.equal(calls, 0);
  const active = new AbortController();
  let requestSignal;
  const pending = retrieveQuestionSources({ question, apiKey: KEY, signal: active.signal, fetchImpl: async (_, init) => {
    requestSignal = init.signal;
    return new Promise(() => {});
  } });
  active.abort(new Error(KEY));
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(requestSignal.aborted, true);
});

test('a stalled request times out even when its fetch implementation ignores AbortSignal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let requestSignal;
  const pending = retrieveQuestionSources({ question, apiKey: KEY, fetchImpl: async (_, init) => {
    calls++;
    requestSignal = init.signal;
    return new Promise(() => {});
  } });
  const rejected = assert.rejects(pending, { code: 'TIMEOUT' });
  t.mock.timers.tick(10000);
  await rejected;
  assert.equal(calls, 1);
  assert.equal(requestSignal.aborted, true);
});

test('the total twenty-five second budget covers search plus both fetches', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const pending = retrieveQuestionSources({ question, apiKey: KEY, fetchImpl: async () => {
    calls++;
    const current = calls;
    await new Promise(resolve => setTimeout(resolve, 9000));
    return json(current === 1 ? search(URL_A, URL_B) : { content: 'Public source' });
  } });
  const rejected = assert.rejects(pending, { code: 'TIMEOUT' });
  t.mock.timers.tick(9000);
  await turn();
  assert.equal(calls, 2);
  t.mock.timers.tick(9000);
  await turn();
  assert.equal(calls, 3);
  t.mock.timers.tick(7000);
  await rejected;
  assert.equal(calls, 3);
});

test('request timeout includes a stalled response body, not just obtaining headers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } });
  const pending = retrieveQuestionSources({ question, apiKey: KEY, fetchImpl: async () => new Response(body) });
  const rejected = assert.rejects(pending, { code: 'TIMEOUT' });
  await turn();
  t.mock.timers.tick(10000);
  await rejected;
});
