import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { emptyProgress, useStudyStore } from '@/store/modules/study';
import { createBridgeController } from '@/store/modules/studyBridge';
import * as api from '@/api/study';
import type { QuestionProgress, StudyBootstrap, StudySession } from '@/api/study/types';
import { createStudyApi } from '../server/api.mjs';

vi.mock('@/api/study', () => ({
  loadStudy: vi.fn(), createStudySession: vi.fn(), updateStudySession: vi.fn(),
  checkStudyQuestion: vi.fn(), finishStudySession: vi.fn(), updateQuestionProgress: vi.fn(), getStudySession: vi.fn(),
}));

const copy = <T>(value: T): T => structuredClone(value);
const cleanups: Array<() => Promise<void>> = [];
const progress = (changes: Partial<QuestionProgress> = {}) => ({ ...emptyProgress(), aiNote: '已保存的完整解析', ...changes });
const session = (changes: Partial<StudySession> = {}): StudySession => ({
  id: 'session-A', removed: false, revision: 0, mode: 'sequential', questionIds: ['Q-1', 'Q-2'], answers: {}, submittedQuestionIds: [],
  createdAt: '2026-10-21T00:00:00.000Z', deadlineAt: null, status: 'active', cursor: 0, ...changes,
});
function snapshot(changes: Partial<StudyBootstrap> = {}): StudyBootstrap {
  const active = session();
  return copy({
    questions: ['Q-1', 'Q-2'].map(id => ({
      id, category: '理论基础', chapter: '第一章', type: 'single' as const, difficulty: '基础' as const,
      stem: `练习题 ${id}`, options: [{ id: 'A', text: '选项 A' }, { id: 'B', text: '选项 B' }],
      answer: ['A'], explanation: '题库解析', knowledgePoint: '知识点', source: '原创',
    })),
    progress: { 'Q-1': progress() }, sessions: [active], activeSession: active,
    ai: { configured: false, baseUrl: '', model: '', webUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh' }, ...changes,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function ready(initial = snapshot()) {
  vi.mocked(api.loadStudy).mockResolvedValue(copy(initial));
  const store = useStudyStore();
  await store.bootstrap();
  vi.mocked(api.loadStudy).mockClear();
  return store;
}
beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('学习快照与本地保存的真实异步竞态', () => {
  it('较旧 refreshProgress 晚返回也不会盖掉较新解析', async () => {
    const store = await ready();
    const oldRead = deferred<StudyBootstrap>();
    const newRead = deferred<StudyBootstrap>();
    vi.mocked(api.loadStudy).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const first = store.refreshProgress();
    await settle();
    const second = store.refreshProgress();
    await settle();
    newRead.resolve(snapshot({ progress: { 'Q-1': progress({ aiNote: '新任务 B 的完整解析' }) } }));
    await second;
    oldRead.resolve(snapshot({ progress: { 'Q-1': progress({ aiNote: '旧任务 A 的解析' }) } }));
    await first;
    expect(store.progress['Q-1'].aiNote).toBe('新任务 B 的完整解析');
    expect(api.loadStudy).toHaveBeenCalledTimes(2);
  });

  it('快照发出后的笔记保存会淘汰旧快照，并重新读取后才算同步完成', async () => {
    const store = await ready();
    const oldRead = deferred<StudyBootstrap>();
    const fresh = snapshot({ progress: { 'Q-1': progress({ note: '刚保存的笔记', aiNote: '最新完整解析' }) } });
    vi.mocked(api.loadStudy).mockReturnValueOnce(oldRead.promise).mockResolvedValue(copy(fresh));
    const refresh = store.refreshProgress();
    await settle();
    vi.mocked(api.updateQuestionProgress).mockResolvedValue(progress({ note: '刚保存的笔记' }));
    await store.patchProgress('Q-1', { note: '刚保存的笔记' });
    oldRead.resolve(snapshot());
    await refresh;
    expect(api.loadStudy).toHaveBeenCalledTimes(2);
    expect(store.progress['Q-1']).toMatchObject({ note: '刚保存的笔记', aiNote: '最新完整解析' });
  });

  it('读取等待正在保存的字段，旧 patch 整条响应也不会擦除已有 AI 解析', async () => {
    const store = await ready();
    const save = deferred<QuestionProgress>();
    const read = deferred<StudyBootstrap>();
    vi.mocked(api.updateQuestionProgress).mockReturnValueOnce(save.promise);
    vi.mocked(api.loadStudy).mockReturnValueOnce(read.promise);
    const patch = store.patchProgress('Q-1', { note: '新笔记' });
    await settle();
    const refresh = store.refreshProgress();
    await settle();
    expect(api.loadStudy).not.toHaveBeenCalled();
    save.resolve(progress({ note: '新笔记', aiNote: '旧响应携带的过时解析', attempts: 0 }));
    await patch;
    expect(store.progress['Q-1']).toMatchObject({ note: '新笔记', aiNote: '已保存的完整解析' });
    read.resolve(snapshot({ progress: { 'Q-1': progress({ note: '新笔记' }) } }));
    await refresh;
    expect(api.loadStudy).toHaveBeenCalledTimes(1);
  });

  it('连续保存同一字段按用户操作顺序发送，前次响应不能落在后次之后', async () => {
    const store = await ready();
    const firstSave = deferred<QuestionProgress>();
    vi.mocked(api.updateQuestionProgress).mockReturnValueOnce(firstSave.promise).mockResolvedValueOnce(progress({ note: '第二次笔记' }));
    const first = store.patchProgress('Q-1', { note: '第一次笔记' });
    const second = store.patchProgress('Q-1', { note: '第二次笔记' });
    await settle();
    expect(api.updateQuestionProgress).toHaveBeenCalledTimes(1);
    firstSave.resolve(progress({ note: '第一次笔记' }));
    await Promise.all([first, second]);
    expect(api.updateQuestionProgress).toHaveBeenNthCalledWith(2, 'Q-1', { note: '第二次笔记', expected: { note: '' } });
    expect(store.progress['Q-1'].note).toBe('第二次笔记');
  });

  it('旧 bootstrap 不能回滚期间已经保存的答案与游标', async () => {
    const store = await ready();
    const oldRead = deferred<StudyBootstrap>();
    const saved = session({ answers: { 'Q-1': ['B'] }, cursor: 1 });
    vi.mocked(api.loadStudy).mockReturnValueOnce(oldRead.promise).mockResolvedValue(snapshot({ sessions: [saved], activeSession: saved }));
    vi.mocked(api.updateStudySession).mockResolvedValue(copy(saved));
    const bootstrap = store.bootstrap();
    await settle();
    await Promise.all([store.persistAnswer('Q-1', ['B']), store.navigate(1)]);
    oldRead.resolve(snapshot());
    await bootstrap;
    expect(api.loadStudy).toHaveBeenCalledTimes(2);
    expect(store.activeSession).toMatchObject({ answers: { 'Q-1': ['B'] }, cursor: 1 });
    expect(store.saveState).toBe('saved');
  });

  it('两个 bootstrap 响应逆序时，旧响应不替换题库、配置、会话或学习进度', async () => {
    const store = await ready();
    const oldRead = deferred<StudyBootstrap>();
    const newRead = deferred<StudyBootstrap>();
    vi.mocked(api.loadStudy).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const first = store.bootstrap();
    await settle();
    const second = store.bootstrap();
    await settle();
    const fresh = snapshot({ activeSession: session({ id: 'session-B' }), ai: { configured: true, baseUrl: 'https://example.invalid', model: 'new', webUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh' } });
    fresh.questions[0].stem = '较新题干';
    fresh.progress['Q-1'].aiNote = '新解析';
    newRead.resolve(fresh);
    await second;
    oldRead.resolve(snapshot());
    await first;
    expect(store.questions[0].stem).toBe('较新题干');
    expect(store.ai.model).toBe('new');
    expect(store.activeSession?.id).toBe('session-B');
    expect(store.progress['Q-1'].aiNote).toBe('新解析');
    expect(store.loading).toBe(false);
  });

  it('409 冲突读取释放当前队列后等待后续保存，不会等待自身而死锁', async () => {
    const store = await ready();
    const nextSave = deferred<StudySession>();
    const completed = session({ status: 'completed', answers: { 'Q-1': ['B'], 'Q-2': ['A'] }, submittedQuestionIds: ['Q-1', 'Q-2'] });
    vi.mocked(api.updateStudySession)
      .mockRejectedValueOnce(Object.assign(new Error('本轮已经结束'), { status: 409 }))
      .mockReturnValueOnce(nextSave.promise);
    vi.mocked(api.loadStudy).mockResolvedValue(snapshot({ sessions: [completed], activeSession: null }));
    const first = store.persistAnswer('Q-1', ['B']).catch(error => error);
    const second = store.persistAnswer('Q-2', ['A']);
    await settle();
    expect(api.updateStudySession).toHaveBeenCalledTimes(2);
    expect(api.loadStudy).not.toHaveBeenCalled();
    nextSave.resolve(session({ answers: { 'Q-1': ['B'], 'Q-2': ['A'] } }));
    expect((await first).status).toBe(409);
    await second;
    expect(api.loadStudy).toHaveBeenCalledTimes(1);
    expect(store.activeSession).toBeNull();
    expect(store.viewedSession?.status).toBe('completed');
    expect(store.saveState).toBe('saved');
  });

  it('判分只更新判分字段，保留保存过的解析、笔记和收藏', async () => {
    const initial = snapshot({ progress: { 'Q-1': progress({ note: '我的笔记', favorite: true, mastered: true }) } });
    const store = await ready(initial);
    vi.mocked(api.checkStudyQuestion).mockResolvedValue({
      session: session({ submittedQuestionIds: ['Q-1'] }), correct: false, answer: ['A'], explanation: '解析',
      progress: progress({ attempts: 1, wrongCount: 1, lastCorrect: false, mastered: false, aiNote: '过时解析', note: '', favorite: false }),
    });
    await store.checkCurrent();
    expect(store.progress['Q-1']).toMatchObject({ attempts: 1, wrongCount: 1, mastered: false, note: '我的笔记', favorite: true, aiNote: '已保存的完整解析' });
  });

  it('控制器完成同步与笔记保存并发时，等待最新快照后才标记解析已保存', async () => {
    const store = await ready();
    const save = deferred<QuestionProgress>();
    const read = deferred<StudyBootstrap>();
    vi.mocked(api.updateQuestionProgress).mockReturnValueOnce(save.promise);
    vi.mocked(api.loadStudy).mockReturnValueOnce(read.promise);
    vi.stubGlobal('document', { hidden: false, removeEventListener: vi.fn() });
    vi.stubGlobal('window', { removeEventListener: vi.fn() });
    const completed = { id: 'AI-B', questionId: 'Q-1', status: 'completed' as const, text: '最新的完整解析', sequence: 6 };
    const bridge = createBridgeController({
      api: {
        getBridgeStatus: vi.fn(async () => ({ connected: true, version: '1.3.0', lastSeenAt: null })),
        getBridgeOverview: vi.fn(async () => ({ activeJob: null, latestJob: completed, serverTime: '', limits: { totalTimeoutMs: 240000, idleTimeoutMs: 120000 } })),
        getBridgeJob: vi.fn(), createBridgeJob: vi.fn(), cancelBridgeJob: vi.fn(),
      },
      getSavedText: id => store.progress[id]?.aiNote || '', syncProgress: () => store.refreshProgress(),
    });
    try {
      const patch = store.patchProgress('Q-1', { note: '解析时保存的笔记' });
      const sync = bridge.refresh();
      await settle();
      expect(bridge.job.value?.status).toBe('completed');
      expect(bridge.run.value?.progressSynced).toBe(false);
      expect(api.loadStudy).not.toHaveBeenCalled();
      save.resolve(progress({ note: '解析时保存的笔记' }));
      await patch;
      read.resolve(snapshot({ progress: { 'Q-1': progress({ note: '解析时保存的笔记', aiNote: completed.text }) } }));
      await sync;
      expect(bridge.run.value?.progressSynced).toBe(true);
      expect(store.progress['Q-1']).toMatchObject({ note: '解析时保存的笔记', aiNote: completed.text });
    } finally { bridge.dispose(); }
  });
});

// Two actual Pinia stores share the real file-backed HTTP handler. No CAS decisions are
// recreated in a mock: a rejected stale write must leave the real learning-state.json intact.
async function twoClients(initialAnswer?: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'yankao-client-cas-'));
  const dataDir = join(directory, 'data');
  const questionsPath = join(directory, 'questions.json');
  await writeFile(questionsPath, JSON.stringify(snapshot().questions), 'utf8');
  const server = createStudyApi({ dataDir, questionsPath });
  cleanups.push(async () => {
    await server.close();
    const owned = resolve(directory);
    if (!owned.startsWith(resolve(tmpdir()) + sep) || !owned.split(sep).at(-1)?.startsWith('yankao-client-cas-')) throw new Error('拒绝删除非测试目录');
    await rm(owned, { recursive: true, force: true });
  });
  async function request(path: string, method = 'GET', body?: any): Promise<any> {
    const req = {
      url: `/study-api${path}`, method,
      headers: { host: '127.0.0.1:18103', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
    };
    let text = '';
    const res = { statusCode: 200, setHeader() {}, end(value: string) { text = value; } };
    await server.handle(req, res);
    const data = JSON.parse(text);
    if (res.statusCode >= 400) throw Object.assign(new Error(data.error || data.message), { status: res.statusCode, code: data.code, current: data.current, historyId: data.historyId });
    return data;
  }
  const remote = await request('/sessions', 'POST', { mode: 'sequential', count: 2, minutes: 10, questionIds: ['Q-1', 'Q-2'] });
  if (initialAnswer) await request(`/sessions/${remote.id}`, 'PATCH', { questionId: 'Q-1', answer: initialAnswer, expectedAnswer: [] });
  vi.mocked(api.loadStudy).mockImplementation(() => request('/bootstrap'));
  vi.mocked(api.getStudySession).mockImplementation(id => request(`/sessions/${id}`));
  vi.mocked(api.updateQuestionProgress).mockImplementation((id, body) => request(`/questions/${id}`, 'PATCH', body));
  vi.mocked(api.updateStudySession).mockImplementation((id, body) => request(`/sessions/${id}`, 'PATCH', body));
  vi.mocked(api.checkStudyQuestion).mockImplementation((id, questionId, answer, expectedAnswer) => request(`/sessions/${id}/check`, 'POST', { questionId, answer, expectedAnswer }));
  vi.mocked(api.finishStudySession).mockImplementation((id, expectedAnswers) => request(`/sessions/${id}/finish`, 'POST', { expectedAnswers }));
  setActivePinia(createPinia());
  const first = useStudyStore();
  await first.bootstrap();
  setActivePinia(createPinia());
  const second = useStudyStore();
  await second.bootstrap();
  return { first, second, request, sessionId: remote.id, disk: async () => JSON.parse(await readFile(join(dataDir, 'learning-state.json'), 'utf8')) };
}

describe('两个真实学习客户端共用文件后端的写入冲突', () => {
  it('真实 API 层保留409的 code/current/historyId，历史恢复请求携带原始正文', async () => {
    const actual = await vi.importActual<typeof import('@/api/study')>('@/api/study');
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: '已在另一页面修改', code: 'WRITE_CONFLICT', current: { note: '服务器新版' }, historyId: 'history-conflict-1',
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(progress({ note: '恢复正文' }))));
    vi.stubGlobal('fetch', fetchMock);
    await expect(actual.updateQuestionProgress('Q-1', { note: '旧草稿', expected: { note: '' } })).rejects.toMatchObject({
      status: 409, code: 'WRITE_CONFLICT', current: { note: '服务器新版' }, historyId: 'history-conflict-1',
    });
    await actual.loadQuestionHistory('Q-1');
    await actual.restoreQuestionHistory('Q-1', { historyId: 'history-1', expected: '服务器新版' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/study-api/questions/Q-1/history', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/study-api/questions/Q-1/restore', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ historyId: 'history-1', expected: '服务器新版' }),
    }));
  });

  it('同题自动刷新后仍携带草稿原基线，拒绝用新快照替旧草稿授权覆盖', async () => {
    const h = await twoClients();
    const draftBase = { note: '' };
    await h.first.patchProgress('Q-1', { note: '第一页的新笔记' }, { note: '' });
    await h.second.refreshProgress();
    expect(h.second.progress['Q-1'].note).toBe('第一页的新笔记');
    await expect(h.second.patchProgress('Q-1', { note: '第二页的旧草稿' }, draftBase)).rejects.toMatchObject({ status: 409, code: 'WRITE_CONFLICT', current: { note: '第一页的新笔记' } });
    expect(api.updateQuestionProgress).toHaveBeenLastCalledWith('Q-1', { note: '第二页的旧草稿', expected: { note: '' } });
    expect((await h.disk()).progress['Q-1'].note).toBe('第一页的新笔记');
  });

  it('仅发送相对绑定基线改变的字段，不把未编辑的错因一起覆盖', async () => {
    const h = await twoClients();
    await h.first.patchProgress('Q-1', { reason: '概念不清' });
    await h.second.patchProgress('Q-1', { note: '只编辑笔记', reason: '' }, { note: '', reason: '' });
    expect(api.updateQuestionProgress).toHaveBeenLastCalledWith('Q-1', { note: '只编辑笔记', expected: { note: '' } });
    expect((await h.disk()).progress['Q-1']).toMatchObject({ note: '只编辑笔记', reason: '概念不清' });
    const count = vi.mocked(api.updateQuestionProgress).mock.calls.length;
    await h.second.patchProgress('Q-1', { note: '只编辑笔记' }, { note: '只编辑笔记' });
    expect(api.updateQuestionProgress).toHaveBeenCalledTimes(count);
  });

  it('同题答案409后保留本地选择、阻断后续同题队列和判分，显式重载才允许新基线', async () => {
    const h = await twoClients();
    await h.first.persistAnswer('Q-1', ['A']);
    const firstTry = h.second.persistAnswer('Q-1', ['B']).catch(error => error);
    const queuedTry = h.second.persistAnswer('Q-1', ['A']).catch(error => error);
    expect((await firstTry).status).toBe(409);
    expect((await queuedTry).status).toBe(409);
    expect(api.updateStudySession).toHaveBeenCalledTimes(2);
    expect(h.second.activeSession?.answers['Q-1']).toEqual(['A']);
    expect(h.second.hasAnswerConflicts).toBe(true);
    await h.second.bootstrap();
    await expect(h.second.checkCurrent()).rejects.toMatchObject({ status: 409 });
    await expect(h.second.finish()).rejects.toMatchObject({ status: 409 });
    expect(api.checkStudyQuestion).not.toHaveBeenCalled();
    expect(api.finishStudySession).not.toHaveBeenCalled();
    expect((await h.disk()).sessions[0].answers['Q-1']).toEqual(['A']);
    await h.second.reloadServerSession();
    expect(h.second.hasAnswerConflicts).toBe(false);
    await h.second.persistAnswer('Q-1', ['B']);
    expect(api.updateStudySession).toHaveBeenLastCalledWith(h.sessionId, { questionId: 'Q-1', answer: ['B'], expectedAnswer: ['A'] });
    expect((await h.disk()).sessions[0].answers['Q-1']).toEqual(['B']);
  });

  it('同一客户端顺序答案使用前一次确认基线，连续选择不会与自己的保存冲突', async () => {
    const h = await twoClients();
    const first = h.first.persistAnswer('Q-1', ['A']);
    const second = h.first.persistAnswer('Q-1', ['B']);
    await Promise.all([first, second]);
    expect(api.updateStudySession).toHaveBeenNthCalledWith(1, h.sessionId, { questionId: 'Q-1', answer: ['A'], expectedAnswer: [] });
    expect(api.updateStudySession).toHaveBeenNthCalledWith(2, h.sessionId, { questionId: 'Q-1', answer: ['B'], expectedAnswer: ['A'] });
    expect((await h.disk()).sessions[0].answers['Q-1']).toEqual(['B']);
    expect(h.first.hasAnswerConflicts).toBe(false);
  });

  it('首次判分拒绝旧标签答案，不把其旧答案覆盖到另一标签已保存版本', async () => {
    const h = await twoClients(['B']);
    await h.first.persistAnswer('Q-1', ['A']);
    await expect(h.second.checkCurrent()).rejects.toMatchObject({ status: 409, code: 'WRITE_CONFLICT' });
    expect(api.checkStudyQuestion).toHaveBeenCalledWith(h.sessionId, 'Q-1', ['B'], ['B']);
    const disk = await h.disk();
    expect(disk.sessions[0].answers['Q-1']).toEqual(['A']);
    expect(disk.sessions[0].submittedQuestionIds).toEqual([]);
    await h.second.bootstrap();
    expect(h.second.activeSession?.answers['Q-1']).toEqual(['B']);
    expect(h.second.answerConflicts[h.sessionId]['Q-1'].serverAnswer).toEqual(['A']);
  });

  it('交卷校验整卷已确认答案，旧卷拒绝判分并在明确重载后正常完成', async () => {
    const h = await twoClients(['A']);
    await h.first.persistAnswer('Q-1', ['B']);
    await expect(h.second.finish()).rejects.toMatchObject({ status: 409, code: 'WRITE_CONFLICT' });
    expect(api.finishStudySession).toHaveBeenLastCalledWith(h.sessionId, { 'Q-1': ['A'] });
    expect((await h.disk()).sessions[0].status).toBe('active');
    await h.second.reloadServerSession();
    await h.second.finish();
    expect(api.finishStudySession).toHaveBeenLastCalledWith(h.sessionId, { 'Q-1': ['B'] });
    expect((await h.disk()).sessions[0].status).toBe('completed');
  });
});
