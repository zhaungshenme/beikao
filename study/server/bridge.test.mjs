import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createStudyApi } from './api.mjs';

async function workerHarness(t, questions = []) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yankao-worker-test-'));
  const bank = path.join(directory, 'questions.json');
  await writeFile(bank, JSON.stringify(questions));
  let currentTime = Date.UTC(2026, 9, 20, 8);
  const dataDir = path.join(directory, 'state');
  let server;
  let base;
  async function start() {
    const api = createStudyApi({ allowLegacyWebBridge: true, dataDir, questionsPath: bank, now: () => currentTime });
    server = createServer(api.handle);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}/study-api`;
  }
  async function stop() {
    if (!server?.listening) return;
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }
  t.after(stop);
  await start();
  async function response(url, body) {
    const result = await fetch(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.status, body: await result.json() };
  }
  return {
    get now() { return currentTime; },
    dataDir, bank,
    advance(milliseconds) { currentTime += milliseconds; },
    async restart() { await stop(); await start(); },
    async savedStateText() { return readFile(path.join(dataDir, 'learning-state.json'), 'utf8'); },
    response,
    async request(url, body) {
      const result = await response(url, body);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    },
  };
}

const streamingQuestion = {
  id: 'BRIDGE-STREAM', category: '网络', chapter: '基础', type: 'single', difficulty: '基础',
  stem: 'HTTPS 默认端口？', options: [{ id: 'A', text: '443' }, { id: 'B', text: '80' }],
  answer: ['A'], explanation: '默认使用443。', knowledgePoint: 'HTTPS',
};
const previousExplanation = '原先已经核验并保存的完整 AI 解析。';
const zhipuWorker = worker => ({ provider: 'zhipu', version: null, ...worker });

async function streamingHarness(t) {
  const app = await workerHarness(t, [streamingQuestion]);
  const previous = await app.request('/bridge/jobs', { questionId: streamingQuestion.id });
  await app.request(`/bridge/jobs/${previous.id}/update`, { provider: 'zhipu', status: 'completed', text: previousExplanation });
  const savedBefore = await app.savedStateText();
  const job = await app.request('/bridge/jobs', { questionId: streamingQuestion.id, answer: ['B'] });
  return { app, job, savedBefore };
}

async function assertPreviousExplanation(app, savedBefore) {
  const bootstrap = await app.request('/bootstrap');
  assert.equal(bootstrap.progress[streamingQuestion.id].aiNote, previousExplanation);
  assert.equal(bootstrap.progress[streamingQuestion.id].attempts, 0);
  assert.equal(await app.savedStateText(), savedBefore, 'partial output must not alter the persisted learning file');
}

test('streaming snapshots are readable during generation and only completed output replaces the saved explanation', async t => {
  const { app, job, savedBefore } = await streamingHarness(t);
  const first = 'HTTPS 使用';
  const accumulated = 'HTTPS 使用 443 端口。';
  await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: first, sequence: 1 });
  const partial = await app.request(`/bridge/jobs/${job.id}`);
  assert.equal(partial.status, 'streaming');
  assert.equal(partial.text, first);
  await assertPreviousExplanation(app, savedBefore);

  await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: accumulated, sequence: 2 });
  const latest = await app.request(`/bridge/jobs/${job.id}`);
  assert.equal(latest.text, accumulated, 'updates contain the accumulated response, rather than another append-only fragment');
  const pending = await app.request('/bridge/pending?provider=zhipu');
  assert.equal(pending.jobs.find(item => item.id === job.id)?.text, accumulated);
  await assertPreviousExplanation(app, savedBefore);

  const finalText = `${accumulated} HTTP 默认使用 80 端口。`;
  const completed = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: finalText });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.text, finalText, 'a final reply from an older client remains compatible without sequence');
  assert.equal((await app.request('/bootstrap')).progress[streamingQuestion.id].aiNote, finalText);
  assert.equal(JSON.parse(await app.savedStateText()).progress[streamingQuestion.id].aiNote, finalText);
  await app.restart();
  assert.equal((await app.request('/bootstrap')).progress[streamingQuestion.id].aiNote, finalText);
});

test('restarting during a stream restores its journal without replacing the earlier complete explanation', async t => {
  const { app, job, savedBefore } = await streamingHarness(t);
  await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: '尚未生成完的临时解析' });
  await assertPreviousExplanation(app, savedBefore);
  await app.restart();
  await assertPreviousExplanation(app, savedBefore);
  const restored = await app.request(`/bridge/jobs/${job.id}`);
  assert.equal(restored.status, 'streaming');
  assert.equal(restored.text, '尚未生成完的临时解析');
  assert.equal((await app.request('/bridge/overview')).activeJob.id, job.id);
});

test('failed and timed-out streams retain their draft for inspection without saving it as the explanation', async t => {
  const { app, job, savedBefore } = await streamingHarness(t);
  const partial = '这段内容还没有得到完整回复确认。';
  await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: partial });
  const failed = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'failed', error: '网页连接中断' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.text, partial);
  assert.equal((await app.request(`/bridge/jobs/${job.id}`)).text, partial);
  await assertPreviousExplanation(app, savedBefore);

  const timeoutJob = await app.request('/bridge/jobs', { questionId: streamingQuestion.id });
  await app.request(`/bridge/jobs/${timeoutJob.id}/update`, { provider: 'zhipu', status: 'streaming', text: partial });
  app.advance(240001);
  const expired = await app.request(`/bridge/jobs/${timeoutJob.id}`);
  assert.equal(expired.status, 'failed');
  assert.match(expired.error, /超时/);
  assert.equal(expired.text, partial);
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs.length, 0);
  await assertPreviousExplanation(app, savedBefore);
  await app.restart();
  await assertPreviousExplanation(app, savedBefore);
});

test('late bridge updates cannot regress a live stream or overwrite a completed or failed job', async t => {
  const { app, job, savedBefore } = await streamingHarness(t);
  const partial = '当前已经显示的累计正文';
  await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: partial });
  for (const status of ['sent', 'running']) {
    const unchanged = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status, text: '过时正文' });
    assert.equal(unchanged.status, 'streaming');
    assert.equal(unchanged.text, partial);
  }
  await assertPreviousExplanation(app, savedBefore);

  const finalText = '新的完整最终解析';
  const completed = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: finalText });
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: '迟到的部分回复' }), completed);
  assert.equal((await app.request('/bootstrap')).progress[streamingQuestion.id].aiNote, finalText);
  const savedCompleted = await app.savedStateText();

  const failedJob = await app.request('/bridge/jobs', { questionId: streamingQuestion.id });
  await app.request(`/bridge/jobs/${failedJob.id}/update`, { provider: 'zhipu', status: 'streaming', text: partial });
  const failed = await app.request(`/bridge/jobs/${failedJob.id}/update`, { provider: 'zhipu', status: 'failed', error: '停止生成' });
  assert.deepEqual(await app.request(`/bridge/jobs/${failedJob.id}/update`, { provider: 'zhipu', status: 'streaming', text: '失败后迟到正文' }), failed);
  assert.equal((await app.request('/bootstrap')).progress[streamingQuestion.id].aiNote, finalText);
  assert.equal(await app.savedStateText(), savedCompleted);
});

test('bridge text accepts the 20000-character boundary and rejects larger streams or final replies without truncation', async t => {
  const { app, job, savedBefore } = await streamingHarness(t);
  const maximumText = '析'.repeat(20000);
  const tooLong = `${maximumText}多`;
  const accepted = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: maximumText });
  assert.equal(accepted.text, maximumText);
  for (const status of ['streaming', 'completed']) {
    const rejected = await app.response(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status, text: tooLong });
    assert.equal(rejected.status, 413, `${status} must reject oversized output`);
    assert.equal(typeof rejected.body.error, 'string');
    const unchanged = await app.request(`/bridge/jobs/${job.id}`);
    assert.equal(unchanged.status, 'streaming');
    assert.equal(unchanged.text, maximumText);
    await assertPreviousExplanation(app, savedBefore);
  }
  const completed = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: maximumText });
  assert.equal(completed.text, maximumText);
  await app.restart();
  assert.equal((await app.request('/bootstrap')).progress[streamingQuestion.id].aiNote, maximumText);
});

test('out-of-order or duplicate sequences cannot replace a newer draft or prematurely persist a final reply', async t => {
  const { app, job, savedBefore } = await streamingHarness(t);
  const current = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: '当前最新累计正文', sequence: 3 });
  for (const sequence of [1, 3]) {
    for (const status of ['streaming', 'completed']) {
      const unchanged = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status, text: '较旧的回复内容', sequence });
      assert.deepEqual(unchanged, current, `${status} sequence ${sequence} must not replace sequence 3`);
    }
  }
  await assertPreviousExplanation(app, savedBefore);

  const next = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: '当前最新累计正文及新句子', sequence: 4 });
  assert.equal(next.sequence, 4);
  assert.equal(next.text, '当前最新累计正文及新句子');
  const completed = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '最终完整解析', sequence: 5 });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.sequence, 5);
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: '终态后迟到的正文', sequence: 6 }), completed);
  await app.restart();
  assert.equal((await app.request('/bootstrap')).progress[streamingQuestion.id].aiNote, '最终完整解析');
});

test('invalid sequence or empty response updates leave the current draft and saved explanation untouched', async t => {
  const { app, job, savedBefore } = await streamingHarness(t);
  const current = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: '有效的部分回复', sequence: 1 });
  for (const status of ['streaming', 'completed']) {
    for (const sequence of [0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
      const rejected = await app.response(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status, text: '不应该生效的正文', sequence });
      assert.equal(rejected.status, 400, `${status}: invalid sequence ${String(sequence)}`);
      assert.deepEqual(await app.request(`/bridge/jobs/${job.id}`), current);
    }
    for (const text of [undefined, null, '', '   ', ['文字']]) {
      const rejected = await app.response(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status, text, sequence: 2 });
      assert.equal(rejected.status, 400, `${status}: missing or empty text`);
      assert.deepEqual(await app.request(`/bridge/jobs/${job.id}`), current);
    }
  }
  await assertPreviousExplanation(app, savedBefore);
});

test('explicit zhipu relay reports connectivity independently from worker readiness', async t => {
  const app = await workerHarness(t);
  const offline = zhipuWorker({ connected: false, state: 'offline', jobId: null, message: '', lastSeenAt: null });
  assert.deepEqual(await app.request('/bridge/status'), { activeProvider: 'zhipu', provider: 'zhipu', availableProviders: ['zhipu', 'deepseek'], connected: false, lastSeenAt: null, version: null, worker: offline });

  const legacy = await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.0-test' });
  assert.equal(legacy.connected, true);
  assert.equal(legacy.version, '1.0-test');
  assert.equal(legacy.lastSeenAt, new Date(app.now).toISOString());
  assert.deepEqual(legacy.worker, offline);
  assert.deepEqual(await app.request('/bridge/status'), legacy);
});

test('bridge worker reports idle and running states using the worker observation timestamp', async t => {
  const app = await workerHarness(t);
  const lastSeenAt = new Date(app.now - 500).toISOString();
  const idleWorker = { provider: 'zhipu', connected: true, state: 'idle', jobId: null, message: '等待题目', lastSeenAt };
  const idle = await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.1.0', worker: idleWorker });
  assert.equal(idle.connected, true);
  assert.deepEqual(idle.worker, zhipuWorker(idleWorker));

  app.advance(1000);
  const runningWorker = { provider: 'zhipu', connected: true, state: 'running', jobId: 'question-job-1', message: '正在等待回答', lastSeenAt: new Date(app.now).toISOString() };
  const running = await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.1.0', worker: runningWorker });
  assert.deepEqual(running.worker, zhipuWorker(runningWorker));
  assert.deepEqual((await app.request('/bridge/status')).worker, zhipuWorker(runningWorker));

  app.advance(1000);
  const legacy = await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.0-test' });
  assert.equal(legacy.connected, true);
  assert.deepEqual(legacy.worker, zhipuWorker(runningWorker), 'an older client must not clear a still-fresh worker observation');
});

test('worker expires at 15 seconds even while local bridge heartbeats continue', async t => {
  const app = await workerHarness(t);
  const lastSeenAt = new Date(app.now).toISOString();
  await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.1.0', worker: { provider: 'zhipu', connected: true, state: 'running', jobId: 'job-1', message: '生成中', lastSeenAt } });
  app.advance(14999);
  const almostExpired = await app.request('/bridge/status');
  assert.equal(almostExpired.connected, true);
  assert.equal(almostExpired.worker.connected, true);

  app.advance(1);
  const expired = await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.1.0' });
  assert.equal(expired.connected, true, 'local helper is still sending heartbeats');
  assert.equal(expired.lastSeenAt, new Date(app.now).toISOString());
  assert.deepEqual(expired.worker, zhipuWorker({ connected: false, state: 'offline', jobId: null, message: '', lastSeenAt }));

  app.advance(15000);
  const disconnected = await app.request('/bridge/status');
  assert.equal(disconnected.connected, false);
  assert.deepEqual(disconnected.worker, expired.worker);
});

test('worker heartbeat rejects future or invalid timestamps and does not coerce connectivity fields', async t => {
  const app = await workerHarness(t);
  const invalidTimes = ['not-a-date', new Date(app.now + 1).toISOString(), new Date(0).toISOString(), -1, null, undefined];
  for (const lastSeenAt of invalidTimes) {
    const status = await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.1.0', worker: { provider: 'zhipu', connected: true, state: 'running', jobId: 'job-1', message: '生成中', lastSeenAt } });
    assert.equal(status.connected, true);
    assert.deepEqual(status.worker, zhipuWorker({ connected: false, state: 'offline', jobId: null, message: '', lastSeenAt: null }), `invalid timestamp: ${String(lastSeenAt)}`);
  }

  const lastSeenAt = new Date(app.now).toISOString();
  for (const connected of [false, 'true', 1, null]) {
    const status = await app.request('/bridge/heartbeat', { provider: 'zhipu', worker: { provider: 'zhipu', connected, state: 'running', jobId: 'job-1', message: '生成中', lastSeenAt } });
    assert.deepEqual(status.worker, zhipuWorker({ connected: false, state: 'offline', jobId: null, message: '', lastSeenAt }));
  }
  for (const state of ['unrecognized-state', 'offline', null]) {
    const status = await app.request('/bridge/heartbeat', { provider: 'zhipu', worker: { provider: 'zhipu', connected: true, state, lastSeenAt } });
    assert.equal(status.worker.connected, false);
    assert.equal(status.worker.state, 'offline');
  }
});

test('worker status limits free text and drops fields that have invalid types', async t => {
  const app = await workerHarness(t);
  const lastSeenAt = new Date(app.now).toISOString();
  const status = await app.request('/bridge/heartbeat', { provider: 'zhipu',
    version: 'v'.repeat(80),
    worker: { provider: 'zhipu', connected: true, state: 'waiting-login', jobId: 'j'.repeat(150), message: '等'.repeat(350), lastSeenAt, extra: 'ignored' },
  });
  assert.equal(status.version, 'v'.repeat(50));
  assert.deepEqual(status.worker, zhipuWorker({ connected: true, state: 'waiting-login', jobId: 'j'.repeat(100), message: '等'.repeat(300), lastSeenAt }));

  const malformed = await app.request('/bridge/heartbeat', { provider: 'zhipu', worker: { provider: 'zhipu', connected: true, state: 'idle', jobId: { id: 'job-1' }, message: ['text'], lastSeenAt } });
  assert.deepEqual(malformed.worker, zhipuWorker({ connected: true, state: 'idle', jobId: null, message: '', lastSeenAt }));
});

const diagnosticSample = (at, jobId = 'job-1') => ({ version: 1, jobId, phase: 'capture-done', at, visibility: 'hidden',
  milestones: { 'submitted-marker': at - 1000, 'observer-installed': at - 500 },
  events: [{ phase: 'capture-done', at, sequence: 2, anchorCount: 5, replyCount: 1, followingCount: 1, visibility: 'hidden' }], maxTimerDelayMs: 59000 });

test('worker diagnostics retain bounded metadata when offline and discard free text', async t => {
  const app = await workerHarness(t);
  const sample = diagnosticSample(app.now);
  sample.prompt = 'private prompt'; sample.text = 'private reply'; sample.answer = ['B'];
  sample.milestones['private prompt'] = app.now;
  sample.milestones['send-return'] = app.now + 1;
  sample.events = Array.from({ length: 20 }, (_, sequence) => ({ ...sample.events[0], sequence, prompt: 'private prompt', text: 'private reply', answer: ['B'] }));
  const status = await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.4.2', worker: { provider: 'zhipu',
    connected: true, state: 'running', jobId: 'job-1', lastSeenAt: new Date(app.now).toISOString(), diagnostics: sample,
  } });
  const safe = status.worker.diagnostics;
  assert.equal(safe.events.length, 12);
  assert.equal(safe.events[0].sequence, 8);
  assert.equal(safe.events[11].followingCount, 1);
  assert.deepEqual(Object.keys(safe.milestones), ['submitted-marker', 'observer-installed']);
  assert.doesNotMatch(JSON.stringify(safe), /private prompt|private reply|"answer"|"prompt"|"text"/);
  app.advance(15000);
  const offline = await app.request('/bridge/status');
  assert.equal(offline.worker.connected, false);
  assert.deepEqual(offline.worker.diagnostics, safe, 'last known observations survive loss of worker heartbeats');
  const older = diagnosticSample(app.now - 16000);
  const stale = await app.request('/bridge/heartbeat', { provider: 'zhipu', worker: { provider: 'zhipu', state: 'offline', diagnostics: older } });
  assert.deepEqual(stale.worker.diagnostics, safe, 'a delayed older observation cannot replace newer evidence');
  const sameMillisecond = { ...diagnosticSample(safe.at), phase: 'job-ended' };
  const sameTime = await app.request('/bridge/heartbeat', { provider: 'zhipu', worker: { provider: 'zhipu', state: 'offline', diagnostics: sameMillisecond } });
  assert.deepEqual(sameTime.worker.diagnostics, safe, 'equal timestamps cannot establish a newer observation');
  const future = diagnosticSample(Number.MAX_SAFE_INTEGER);
  const invalidFuture = await app.request('/bridge/heartbeat', { provider: 'zhipu', worker: { provider: 'zhipu', state: 'offline', diagnostics: future } });
  assert.deepEqual(invalidFuture.worker.diagnostics, safe, 'future timestamps cannot poison subsequent diagnostic ordering');
  const newer = diagnosticSample(app.now);
  newer.events.push({ phase: 'job-ended', at: app.now + 1 });
  const recovered = await app.request('/bridge/heartbeat', { provider: 'zhipu', worker: { provider: 'zhipu', state: 'offline', diagnostics: newer } });
  assert.equal(recovered.worker.diagnostics.at, app.now);
  assert.equal(recovered.worker.diagnostics.events.length, 1, 'events later than their snapshot are discarded');
});

test('invalid diagnostic shapes never become public worker metadata', async t => {
  const app = await workerHarness(t);
  for (const patch of [{ version: 2 }, { phase: 'raw prompt' }, { at: -1 }, { at: 1.5 }, { at: app.now + 1 }, { visibility: 'secret' },
    { jobId: {} }, { milestones: [] }, { events: {} }, { maxTimerDelayMs: -1 }]) {
    const status = await app.request('/bridge/heartbeat', { provider: 'zhipu', worker: { provider: 'zhipu', connected: true, state: 'idle',
      lastSeenAt: new Date(app.now).toISOString(), diagnostics: { ...diagnosticSample(app.now), ...patch } } });
    assert.equal(status.worker.connected, true);
    assert.equal(status.worker.diagnostics, undefined, JSON.stringify(patch));
  }
});

test('diagnostic heartbeats cannot keep a stalled job alive or overwrite its saved explanation', async t => {
  const { app, job, savedBefore } = await streamingHarness(t);
  await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'running' });
  const original = await app.request(`/bridge/jobs/${job.id}`);
  for (const delay of [60000, 59999]) {
    app.advance(delay);
    await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.4.2', worker: { provider: 'zhipu', connected: true, state: 'running', jobId: job.id,
      lastSeenAt: new Date(app.now).toISOString(), diagnostics: diagnosticSample(app.now, job.id) } });
    assert.equal((await app.request(`/bridge/jobs/${job.id}`)).lastProgressAt, original.lastProgressAt);
  }
  app.advance(2);
  const expired = await app.request(`/bridge/jobs/${job.id}`);
  assert.equal(expired.status, 'failed');
  assert.equal(expired.failureCode, 'no-progress');
  await assertPreviousExplanation(app, savedBefore);
});

test('web bridge serializes work, persists completed explanation, and rejects stale or cross-site results', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yankao-bridge-test-'));
  const bank = path.join(directory, 'questions.json');
  const question = { id: 'BRIDGE-TEST', category: '网络', chapter: '基础', type: 'single', difficulty: '基础', stem: 'HTTPS 默认端口？', options: [{ id: 'A', text: '443' }, { id: 'B', text: '80' }], answer: ['A'], explanation: '默认使用443。', knowledgePoint: 'HTTPS' };
  await writeFile(bank, JSON.stringify([question]));
  const dataDir = path.join(directory, 'state');
  const api = createStudyApi({ allowLegacyWebBridge: true, dataDir, questionsPath: bank });
  const server = createServer(api.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/study-api`;
  const request = async (url, body, headers = {}) => {
    const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/bridge/status')).body.connected, false);
  assert.equal((await request('/bridge/heartbeat', { provider: 'zhipu', version: '1.0-test' })).body.connected, true);
  const { body: job } = await request('/bridge/jobs', { questionId: question.id, answer: ['B'] });
  assert.equal(job.status, 'queued');
  assert.match(job.prompt, /我的答案：B/);
  assert.match(job.prompt, /题库标准答案：A/);
  assert.equal((await request('/bridge/jobs', { questionId: question.id })).status, 409);
  assert.equal((await request('/bridge/pending?provider=zhipu')).body.jobs.length, 1);
  assert.equal((await request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: 'spoof' }, { Origin: 'https://chatglm.cn' })).status, 403);
  assert.equal((await request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'sent' })).body.status, 'sent');
  assert.equal((await request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'running' })).body.status, 'running');
  assert.equal((await request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '端口443用于HTTPS，端口80常用于HTTP。' })).body.status, 'completed');
  assert.equal((await request('/bridge/pending?provider=zhipu')).body.jobs.length, 0);
  assert.equal((await request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'failed', error: 'stale event' })).body.status, 'completed');
  const { body: bootstrap } = await request('/bootstrap');
  assert.equal(bootstrap.progress[question.id].aiNote, '端口443用于HTTPS，端口80常用于HTTP。');
  assert.equal(bootstrap.progress[question.id].attempts, 0);
  const restartApi = createStudyApi({ allowLegacyWebBridge: true, dataDir, questionsPath: bank });
  assert.equal(typeof restartApi.handle, 'function');
  assert.equal((await request('/bridge/jobs', { questionId: question.id })).status, 200);
});

test('a lost create response is recovered by request identity before and after a service restart', async t => {
  const app = await workerHarness(t, [streamingQuestion]);
  const payload = { requestId: 'retry-request-123', questionId: streamingQuestion.id, answer: ['B'], question: '请简明解释' };
  const original = await app.request('/bridge/jobs', payload);
  assert.deepEqual(await app.request('/bridge/jobs', payload), original);
  assert.equal((await app.request('/bridge/pending?provider=zhipu')).jobs.length, 1);
  await app.restart();
  assert.deepEqual(await app.request('/bridge/jobs', payload), original);
  const conflict = await app.response('/bridge/jobs', { ...payload, answer: ['A'] });
  assert.equal(conflict.status, 409);
  assert.equal((await app.request('/bridge/overview')).activeJob.id, original.id);
  for (const requestId of ['', 'short', '../not-a-request', 123]) {
    assert.equal((await app.response('/bridge/jobs', { ...payload, requestId })).status, 400);
  }
  const completed = await app.request(`/bridge/jobs/${original.id}/update`, { provider: 'zhipu', status: 'completed', text: '确认完整的回复', sequence: 1 });
  await app.restart();
  assert.deepEqual(await app.request('/bridge/jobs', payload), completed, 'retrying an acknowledged request must not send it again');
  assert.equal((await app.request('/bridge/overview')).latestJob.id, original.id);
});

test('cancelling a stream is durable, keeps previous notes and prevents every late update from completing it', async t => {
  const { app, job, savedBefore } = await streamingHarness(t);
  const partial = '生成中的片段';
  await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: partial, sequence: 2 });
  const cancelled = await app.request(`/bridge/jobs/${job.id}/cancel`, {});
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.failureCode, 'cancelled');
  assert.equal(cancelled.text, partial);
  await assertPreviousExplanation(app, savedBefore);
  await app.restart();
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}`), cancelled);
  for (const status of ['sent', 'running', 'streaming', 'completed', 'failed']) {
    assert.deepEqual(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status, text: '迟到的回复', sequence: 3 }), cancelled);
  }
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}/cancel`, {}), cancelled);
  await assertPreviousExplanation(app, savedBefore);
  const next = await app.request('/bridge/jobs', { questionId: streamingQuestion.id });
  assert.notEqual(next.id, job.id, 'ending the wait frees the queue');
  assert.equal((await app.request('/bridge/overview')).activeJob.id, next.id);
});

test('repeated transport heartbeats and identical streamed text cannot postpone the no-progress deadline', async t => {
  const { app, job, savedBefore } = await streamingHarness(t);
  const first = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: '未变的正文', sequence: 1 });
  app.advance(60000);
  const duplicate = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: first.text, sequence: 2 });
  assert.notEqual(duplicate.updatedAt, first.updatedAt);
  assert.equal(duplicate.lastProgressAt, first.lastProgressAt);
  await app.request('/bridge/heartbeat', { provider: 'zhipu', version: '1.2.0' });
  await app.restart();
  app.advance(59999);
  assert.equal((await app.request('/bridge/overview')).activeJob.id, job.id);
  app.advance(1);
  const overview = await app.request('/bridge/overview');
  assert.equal(overview.activeJob, null);
  assert.equal(overview.latestJob.id, job.id);
  assert.equal(overview.latestJob.failureCode, 'no-progress');
  assert.equal(overview.latestJob.text, first.text);
  assert.deepEqual(overview.limits, { totalTimeoutMs: 240000, idleTimeoutMs: 120000 });
  assert.equal(overview.serverTime, new Date(app.now).toISOString());
  await assertPreviousExplanation(app, savedBefore);
});

test('real progress extends only the idle deadline and never the total task deadline', async t => {
  const app = await workerHarness(t, [streamingQuestion]);
  const job = await app.request('/bridge/jobs', { questionId: streamingQuestion.id });
  app.advance(110000);
  const first = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: '第一段', sequence: 1 });
  assert.equal(first.lastProgressAt, new Date(app.now).toISOString());
  app.advance(110000);
  const second = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'streaming', text: '第一段及第二段', sequence: 2 });
  assert.equal(second.lastProgressAt, new Date(app.now).toISOString());
  app.advance(20000);
  const expired = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '超过总期限的完整回复', sequence: 3 });
  assert.equal(expired.status, 'failed');
  assert.equal(expired.failureCode, 'total-timeout');
  assert.equal(expired.text, second.text);
  assert.equal((await app.request('/bootstrap')).progress[streamingQuestion.id].aiNote, '');
  await app.restart();
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}`), expired);
});

test('backward phase reports cannot regress a running task or refresh its progress clock', async t => {
  const app = await workerHarness(t, [streamingQuestion]);
  const job = await app.request('/bridge/jobs', { questionId: streamingQuestion.id });
  const running = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'running' });
  app.advance(60000);
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'sent' }), running);
  const repeated = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'running' });
  assert.equal(repeated.lastProgressAt, running.lastProgressAt);
  app.advance(60000);
  assert.equal((await app.request(`/bridge/jobs/${job.id}`)).failureCode, 'no-progress');
});

test('an invalid journal fails explicitly without replacing the original journal or learning state', async t => {
  const { app, savedBefore } = await streamingHarness(t);
  const journalPath = path.join(app.dataDir, 'bridge-jobs.json');
  const validJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  const invalidJournals = [
    '{broken',
    JSON.stringify({ version: 2, jobs: [] }),
    JSON.stringify({ version: 1, jobs: [{ ...validJournal.jobs[0], status: 'unknown' }] }),
    JSON.stringify({ version: 1, jobs: [{ ...validJournal.jobs[0], questionId: 'missing-question' }] }),
    JSON.stringify({ version: 1, jobs: [validJournal.jobs[0], validJournal.jobs[0]] }),
  ];
  for (const original of invalidJournals) {
    await writeFile(journalPath, original);
    assert.throws(() => createStudyApi({ allowLegacyWebBridge: true, dataDir: app.dataDir, questionsPath: app.bank }), /解析任务记录损坏.*未覆盖原文件/);
    assert.equal(await readFile(journalPath, 'utf8'), original);
    assert.equal(await app.savedStateText(), savedBefore);
  }
});

test('journal records with older missing timestamps recover using their creation time', async t => {
  const app = await workerHarness(t, [streamingQuestion]);
  const job = await app.request('/bridge/jobs', { questionId: streamingQuestion.id });
  const journalPath = path.join(app.dataDir, 'bridge-jobs.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  delete journal.jobs[0].updatedAt;
  delete journal.jobs[0].lastProgressAt;
  await writeFile(journalPath, JSON.stringify(journal));
  await app.restart();
  const restored = await app.request(`/bridge/jobs/${job.id}`);
  assert.equal(restored.updatedAt, restored.createdAt);
  assert.equal(restored.lastProgressAt, restored.createdAt);
});

test('failed note persistence cannot acknowledge task completion and the same final reply can be retried', async t => {
  const app = await workerHarness(t, [streamingQuestion]);
  const job = await app.request('/bridge/jobs', { questionId: streamingQuestion.id });
  const statePath = path.join(app.dataDir, 'learning-state.json');
  await mkdir(statePath);
  const result = await app.response(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '需要先落盘的最终解析', sequence: 1 });
  assert.equal(result.status, 500);
  assert.equal((await app.request(`/bridge/jobs/${job.id}`)).status, 'queued');
  assert.equal((await app.request('/bootstrap')).progress[streamingQuestion.id].aiNote, '');
  await rmdir(statePath);
  const completed = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '需要先落盘的最终解析', sequence: 1 });
  assert.equal(completed.status, 'completed');
  await app.restart();
  assert.equal((await app.request('/bootstrap')).progress[streamingQuestion.id].aiNote, completed.text);
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}`), completed);
});

test('failed journal persistence never exposes completed status and permits retrying its final acknowledgement', async t => {
  const app = await workerHarness(t, [streamingQuestion]);
  const job = await app.request('/bridge/jobs', { questionId: streamingQuestion.id });
  const journalPath = path.join(app.dataDir, 'bridge-jobs.json');
  const journalBackup = path.join(app.dataDir, 'bridge-jobs.backup.json');
  await rename(journalPath, journalBackup);
  await mkdir(journalPath);
  const failed = await app.response(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '学习记录先保存，任务确认需重试', sequence: 1 });
  assert.equal(failed.status, 500);
  assert.equal((await app.request(`/bridge/jobs/${job.id}`)).status, 'queued');
  await rmdir(journalPath);
  await rename(journalBackup, journalPath);
  const completed = await app.request(`/bridge/jobs/${job.id}/update`, { provider: 'zhipu', status: 'completed', text: '学习记录先保存，任务确认需重试', sequence: 1 });
  assert.equal(completed.status, 'completed');
  await app.restart();
  assert.deepEqual(await app.request(`/bridge/jobs/${job.id}`), completed);
});

test('the journal retains only the most recent hundred tasks and never drops the active task', async t => {
  const app = await workerHarness(t, [streamingQuestion]);
  let first;
  for (let index = 0; index < 100; index++) {
    const job = await app.request('/bridge/jobs', { questionId: streamingQuestion.id, requestId: `history-request-${index}` });
    first ??= job;
    await app.request(`/bridge/jobs/${job.id}/cancel`, {});
  }
  const active = await app.request('/bridge/jobs', { questionId: streamingQuestion.id });
  const journal = JSON.parse(await readFile(path.join(app.dataDir, 'bridge-jobs.json'), 'utf8'));
  assert.equal(journal.jobs.length, 100);
  assert.equal(journal.jobs.some(job => job.id === first.id), false);
  assert.equal(journal.jobs.some(job => job.id === active.id), true);
  await app.restart();
  assert.equal((await app.request('/bridge/overview')).activeJob.id, active.id);
});
