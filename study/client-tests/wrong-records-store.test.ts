import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { emptyProgress, useStudyStore } from '@/store/modules/study';
import * as api from '@/api/study';
import type { QuestionProgress, StudyBootstrap, StudySession, WrongRecordsBatchResponse } from '@/api/study/types';
import { createStudyApi } from '../server/api.mjs';

vi.mock('@/api/study', () => ({
  loadStudy: vi.fn(), createStudySession: vi.fn(), updateStudySession: vi.fn(), getStudySession: vi.fn(),
  checkStudyQuestion: vi.fn(), finishStudySession: vi.fn(), updateQuestionProgress: vi.fn(), updateWrongRecordsBatch: vi.fn(),
}));

const time = '2026-10-21T00:00:00.000Z';
const later = '2026-10-21T01:00:00.000Z';
const cleanups: Array<() => Promise<void>> = [];
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const progress = (changes: Partial<QuestionProgress> = {}): QuestionProgress => ({
  ...emptyProgress(), attempts: 5, correctCount: 2, wrongCount: 3, lastAnswer: ['B'], lastCorrect: false,
  lastAnsweredAt: time, favorite: true, note: '应保留的学习笔记', reason: '知识混淆', aiNote: '应保留的完整 AI 解析', ...changes,
});
function session(changes: Partial<StudySession> = {}): StudySession {
  return { id: 'S-1', removed: false, revision: 0, mode: 'sequential', questionIds: ['Q-1', 'Q-2'], answers: { 'Q-1': ['B'] },
    submittedQuestionIds: [], createdAt: time, deadlineAt: null, status: 'active', cursor: 0, ...changes };
}
function snapshot(changes: Partial<StudyBootstrap> = {}): StudyBootstrap {
  const current = session();
  return copy({
    questions: ['Q-1', 'Q-2', 'Q-3'].map(id => ({ id, category: '理论基础', chapter: '基础', type: 'single' as const,
      difficulty: '基础' as const, stem: id, options: [{ id: 'A', text: '正确' }, { id: 'B', text: '错误' }],
      answer: ['A'], explanation: '题目解析', knowledgePoint: '知识点', source: '原创题' })),
    progress: { 'Q-1': progress(), 'Q-2': progress({ wrongCount: 2, wrongRemoved: true }), 'Q-3': progress({ wrongCount: 0 }) },
    sessions: [current], activeSession: current, ai: { configured: false, baseUrl: '', model: '', webUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh' },
    ...changes,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
async function settle() { for (let count = 0; count < 30; count++) await Promise.resolve(); }
async function ready(initial = snapshot()) {
  vi.mocked(api.loadStudy).mockResolvedValue(copy(initial));
  const store = useStudyStore();
  await store.bootstrap();
  vi.mocked(api.loadStudy).mockClear();
  return store;
}
beforeEach(() => { vi.resetAllMocks(); setActivePinia(createPinia()); });
afterEach(async () => { vi.unstubAllGlobals(); for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('错题移除与恢复的学习状态和竞态保护', () => {
  it('旧快照缺少 wrongRemoved 时默认为false，普通错题与已移除集合分别筛选', async () => {
    const old = snapshot();
    delete (old.progress['Q-1'] as Partial<QuestionProgress>).wrongRemoved;
    old.progress['Q-3'].wrongRemoved = true;
    const store = await ready(old);
    expect(emptyProgress().wrongRemoved).toBe(false);
    expect(store.progress['Q-1'].wrongRemoved).toBe(false);
    expect(store.wrongQuestions.map(q => q.id)).toEqual(['Q-1']);
    expect(store.removedWrongQuestions.map(q => q.id)).toEqual(['Q-2']);
    await store.refreshProgress();
    expect(store.progress['Q-1'].wrongRemoved).toBe(false);
  });

  it('成功响应前不移除题目，成功后只合并wrongRemoved而不覆盖旧响应中的正文与统计', async () => {
    const store = await ready();
    const held = deferred<WrongRecordsBatchResponse>();
    vi.mocked(api.updateWrongRecordsBatch).mockReturnValueOnce(held.promise);
    const removing = store.removeWrongRecords(['Q-1', 'Q-1']);
    await settle();
    expect(store.busy).toBe(true);
    expect(store.wrongQuestions.map(q => q.id)).toEqual(['Q-1']);
    expect(api.updateWrongRecordsBatch).toHaveBeenCalledWith({ removed: true, items: [{ questionId: 'Q-1', expected: { wrongRemoved: false, wrongCount: 3, lastAnsweredAt: time } }] });
    store.progress['Q-1'].aiNote = '等待删除时收到的更新解析';
    held.resolve({ progress: { 'Q-1': progress({ wrongRemoved: true, note: '过时笔记', aiNote: '过时解析', wrongCount: 1 }) }, changedCount: 1 });
    expect((await removing).changedCount).toBe(1);
    expect(store.busy).toBe(false);
    expect(store.wrongQuestions).toHaveLength(0);
    expect(store.removedWrongQuestions.map(q => q.id)).toEqual(['Q-1', 'Q-2']);
    expect(store.progress['Q-1']).toMatchObject({ wrongRemoved: true, wrongCount: 3, attempts: 5, note: '应保留的学习笔记', aiNote: '等待删除时收到的更新解析', reason: '知识混淆', favorite: true });
    expect(store.sessions[0].answers).toEqual({ 'Q-1': ['B'] });
  });

  it('恢复只改wrongRemoved，原笔记、错因、解析和答题次数均保留', async () => {
    const store = await ready();
    const before = copy(store.progress['Q-2']);
    vi.mocked(api.updateWrongRecordsBatch).mockResolvedValue({ progress: { 'Q-2': progress({ wrongRemoved: false, wrongCount: 0, note: '', reason: '', aiNote: '' }) }, changedCount: 1 });
    await store.restoreWrongRecords(['Q-2']);
    expect(api.updateWrongRecordsBatch).toHaveBeenCalledWith({ removed: false, items: [{ questionId: 'Q-2', expected: { wrongRemoved: true, wrongCount: 2, lastAnsweredAt: time } }] });
    expect(store.progress['Q-2']).toEqual({ ...before, wrongRemoved: false });
    expect(store.wrongQuestions.map(q => q.id)).toEqual(['Q-1', 'Q-2']);
    expect(store.removedWrongQuestions).toHaveLength(0);
  });

  it('空集合无请求，未知题目或没有错题记录的题目不会发起写入', async () => {
    const store = await ready();
    expect(await store.removeWrongRecords([])).toEqual({ progress: {}, changedCount: 0 });
    expect(await store.restoreWrongRecords([])).toEqual({ progress: {}, changedCount: 0 });
    await expect(store.removeWrongRecords(['unknown'])).rejects.toThrow('未知题目');
    await expect(store.removeWrongRecords(['Q-3'])).rejects.toThrow('尚无错题记录');
    expect(api.updateWrongRecordsBatch).not.toHaveBeenCalled();
    expect(store.busy).toBe(false);
  });

  it('网络失败不乐观隐藏记录，也不把请求自动重试', async () => {
    const store = await ready();
    const before = copy(store.progress);
    const failure = new Error('连接中断');
    vi.mocked(api.updateWrongRecordsBatch).mockRejectedValueOnce(failure);
    await expect(store.removeWrongRecords(['Q-1'])).rejects.toBe(failure);
    expect(store.progress).toEqual(before);
    expect(store.wrongQuestions.map(q => q.id)).toEqual(['Q-1']);
    expect(api.updateWrongRecordsBatch).toHaveBeenCalledTimes(1);
    expect(api.loadStudy).not.toHaveBeenCalled();
    expect(store.busy).toBe(false);
  });

  it('409只刷新canonical并原样抛出，不用最新错题次数自动重基线重试', async () => {
    const store = await ready();
    const fresh = snapshot({ progress: { 'Q-1': progress({ wrongCount: 4, lastAnsweredAt: later, aiNote: '另一页面的新解析' }) } });
    const failure = Object.assign(new Error('错题已重新作答'), { status: 409, code: 'WRITE_CONFLICT', current: fresh.progress });
    vi.mocked(api.updateWrongRecordsBatch).mockRejectedValueOnce(failure);
    vi.mocked(api.loadStudy).mockResolvedValueOnce(fresh);
    await expect(store.removeWrongRecords(['Q-1'])).rejects.toBe(failure);
    expect(api.updateWrongRecordsBatch).toHaveBeenCalledTimes(1);
    expect(api.loadStudy).toHaveBeenCalledTimes(1);
    expect(store.progress['Q-1']).toMatchObject({ wrongRemoved: false, wrongCount: 4, lastAnsweredAt: later, aiNote: '另一页面的新解析' });
    expect(store.wrongQuestions.map(q => q.id)).toEqual(['Q-1']);
    expect(store.busy).toBe(false);
  });

  it('冲突后的刷新也失败时仍抛原始409，原错题与内容继续保留', async () => {
    const store = await ready();
    const before = copy(store.progress);
    const original = Object.assign(new Error('原始批量冲突'), { status: 409, code: 'WRITE_CONFLICT' });
    vi.mocked(api.updateWrongRecordsBatch).mockRejectedValueOnce(original);
    vi.mocked(api.loadStudy).mockRejectedValueOnce(new Error('刷新失败'));
    await expect(store.removeWrongRecords(['Q-1'])).rejects.toBe(original);
    expect(store.progress).toEqual(before);
    expect(api.updateWrongRecordsBatch).toHaveBeenCalledTimes(1);
    expect(store.busy).toBe(false);
  });

  it('批量动作在调用时捕获基线，排在笔记保存之后也不会换成执行时新快照', async () => {
    const store = await ready();
    const held = deferred<QuestionProgress>();
    vi.mocked(api.updateQuestionProgress).mockReturnValueOnce(held.promise);
    vi.mocked(api.updateWrongRecordsBatch).mockResolvedValueOnce({ progress: { 'Q-1': progress({ wrongRemoved: true }) }, changedCount: 1 });
    const saving = store.patchProgress('Q-1', { note: '排队前的笔记保存' });
    const removing = store.removeWrongRecords(['Q-1']);
    await settle();
    expect(api.updateWrongRecordsBatch).not.toHaveBeenCalled();
    store.progress['Q-1'].wrongCount = 7;
    store.progress['Q-1'].lastAnsweredAt = later;
    held.resolve(progress({ note: '排队前的笔记保存' }));
    await Promise.all([saving, removing]);
    expect(api.updateWrongRecordsBatch).toHaveBeenCalledWith({ removed: true, items: [{ questionId: 'Q-1', expected: { wrongRemoved: false, wrongCount: 3, lastAnsweredAt: time } }] });
    expect(store.progress['Q-1']).toMatchObject({ wrongCount: 7, lastAnsweredAt: later, note: '排队前的笔记保存', wrongRemoved: true });
  });

  it('删除前发出的旧快照晚返回时会重读，不能把已删除错题重新放回列表', async () => {
    const store = await ready();
    const oldRead = deferred<StudyBootstrap>();
    const fresh = snapshot({ progress: { 'Q-1': progress({ wrongRemoved: true }), 'Q-2': progress({ wrongRemoved: true }) } });
    vi.mocked(api.loadStudy).mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(fresh);
    const refreshing = store.refreshProgress();
    await settle();
    vi.mocked(api.updateWrongRecordsBatch).mockResolvedValueOnce({ progress: { 'Q-1': progress({ wrongRemoved: true }) }, changedCount: 1 });
    await store.removeWrongRecords(['Q-1']);
    oldRead.resolve(snapshot());
    await refreshing;
    expect(api.loadStudy).toHaveBeenCalledTimes(2);
    expect(store.progress['Q-1'].wrongRemoved).toBe(true);
    expect(store.wrongQuestions).toHaveLength(0);
  });

  it('删除正在进行时的刷新等写入结束才读取服务器快照', async () => {
    const store = await ready();
    const held = deferred<WrongRecordsBatchResponse>();
    vi.mocked(api.updateWrongRecordsBatch).mockReturnValueOnce(held.promise);
    const removing = store.removeWrongRecords(['Q-1']);
    const refreshing = store.refreshProgress();
    await settle();
    expect(api.loadStudy).not.toHaveBeenCalled();
    vi.mocked(api.loadStudy).mockResolvedValueOnce(snapshot({ progress: { 'Q-1': progress({ wrongRemoved: true }) } }));
    held.resolve({ progress: { 'Q-1': progress({ wrongRemoved: true }) }, changedCount: 1 });
    await Promise.all([removing, refreshing]);
    expect(api.loadStudy).toHaveBeenCalledTimes(1);
    expect(store.progress['Q-1'].wrongRemoved).toBe(true);
  });

  it('409刷新先释放自身队列并等待后续笔记保存，不死锁且不覆盖笔记', async () => {
    const store = await ready();
    const held = deferred<QuestionProgress>();
    vi.mocked(api.updateWrongRecordsBatch).mockRejectedValueOnce(Object.assign(new Error('错题发生变化'), { status: 409 }));
    vi.mocked(api.updateQuestionProgress).mockReturnValueOnce(held.promise);
    const removing = store.removeWrongRecords(['Q-1']).catch(failure => failure);
    const saving = store.patchProgress('Q-1', { note: '冲突后排队的新笔记' });
    await settle();
    expect(api.updateQuestionProgress).toHaveBeenCalledTimes(1);
    expect(api.loadStudy).not.toHaveBeenCalled();
    vi.mocked(api.loadStudy).mockResolvedValueOnce(snapshot({ progress: { 'Q-1': progress({ note: '冲突后排队的新笔记', wrongCount: 4 }) } }));
    held.resolve(progress({ note: '冲突后排队的新笔记' }));
    await saving;
    expect((await removing).status).toBe(409);
    expect(store.progress['Q-1']).toMatchObject({ note: '冲突后排队的新笔记', wrongRemoved: false, wrongCount: 4 });
    expect(store.busy).toBe(false);
  });

  it('已移除的错题再次答错后按服务端wrongRemoved=false恢复，判分不覆盖解析笔记', async () => {
    const store = await ready(snapshot({ progress: { 'Q-1': progress({ wrongRemoved: true }) } }));
    vi.mocked(api.checkStudyQuestion).mockResolvedValueOnce({
      session: session({ submittedQuestionIds: ['Q-1'] }), correct: false, answer: ['A'], explanation: '题目解析',
      progress: progress({ attempts: 6, wrongCount: 4, wrongRemoved: false, mastered: false, note: '', aiNote: '' }),
    });
    await store.checkCurrent();
    expect(store.wrongQuestions.map(q => q.id)).toEqual(['Q-1']);
    expect(store.removedWrongQuestions).toHaveLength(0);
    expect(store.progress['Q-1']).toMatchObject({ attempts: 6, wrongCount: 4, wrongRemoved: false, note: '应保留的学习笔记', aiNote: '应保留的完整 AI 解析' });
  });

  it('真实API请求携带removed与每题原始基线，409的细节照常保留', async () => {
    const actual = await vi.importActual<typeof import('@/api/study')>('@/api/study');
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const payload = { removed: true, items: [{ questionId: 'Q-1', expected: { wrongRemoved: false, wrongCount: 3, lastAnsweredAt: time } }] };
    const current = { 'Q-1': progress({ wrongCount: 4 }) };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ progress: { 'Q-1': progress({ wrongRemoved: true }) }, changedCount: 1 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '错题记录发生变化', code: 'WRITE_CONFLICT', current }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await actual.updateWrongRecordsBatch(payload)).changedCount).toBe(1);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/study-api/wrong-records/batch', expect.objectContaining({ method: 'POST', body: JSON.stringify(payload) }));
    await expect(actual.updateWrongRecordsBatch(payload)).rejects.toMatchObject({ status: 409, code: 'WRITE_CONFLICT', current });
  });
});

// The same production handler and data file back both stores; the fixture does not
// implement CAS itself or touch the user's active learning profile.
async function twoFileBackedClients() {
  const directory = await mkdtemp(join(tmpdir(), 'yankao-wrong-store-'));
  const dataDir = join(directory, 'data');
  const questionsPath = join(directory, 'questions.json');
  await mkdir(dataDir);
  await writeFile(questionsPath, JSON.stringify(snapshot().questions), 'utf8');
  await writeFile(join(dataDir, 'learning-state.json'), JSON.stringify({ version: 1, progress: { 'Q-1': progress() }, sessions: [] }), 'utf8');
  const server = createStudyApi({ dataDir, questionsPath });
  cleanups.push(async () => {
    await server.close();
    const owned = resolve(directory);
    if (!owned.startsWith(resolve(tmpdir()) + sep) || !owned.split(sep).at(-1)?.startsWith('yankao-wrong-store-')) throw new Error('拒绝删除非测试目录');
    await rm(owned, { recursive: true, force: true });
  });
  async function request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const req = { url: `/study-api${path}`, method, headers: { host: '127.0.0.1:18103', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    let text = '';
    const res = { statusCode: 200, setHeader() {}, end(value: string) { text = value; } };
    await server.handle(req, res);
    const data = JSON.parse(text);
    if (res.statusCode >= 400) throw Object.assign(new Error(data.error || data.message), { status: res.statusCode, code: data.code, current: data.current });
    return data;
  }
  const current = await request('/sessions', 'POST', { mode: 'sequential', count: 2, minutes: 10, questionIds: ['Q-1', 'Q-2'] });
  await request(`/sessions/${current.id}`, 'PATCH', { questionId: 'Q-1', answer: ['B'], expectedAnswer: [] });
  vi.mocked(api.loadStudy).mockImplementation(() => request('/bootstrap'));
  vi.mocked(api.updateWrongRecordsBatch).mockImplementation(payload => request('/wrong-records/batch', 'POST', payload));
  vi.mocked(api.updateQuestionProgress).mockImplementation((id, payload) => request(`/questions/${id}`, 'PATCH', payload));
  vi.mocked(api.checkStudyQuestion).mockImplementation((id, questionId, answer, expectedAnswer) => request(`/sessions/${id}/check`, 'POST', { questionId, answer, expectedAnswer }));
  setActivePinia(createPinia());
  const first = useStudyStore();
  await first.bootstrap();
  setActivePinia(createPinia());
  const second = useStudyStore();
  await second.bootstrap();
  return { first, second, request, sessionId: current.id,
    disk: async () => JSON.parse(await readFile(join(dataDir, 'learning-state.json'), 'utf8')) };
}

describe('两个真实客户端对同一文件后端移除和恢复错题', () => {
  it('真实批量移除和恢复保持笔记解析、错题次数及练习记录完整', async () => {
    const h = await twoFileBackedClients();
    const before = await h.disk();
    expect((await h.first.removeWrongRecords(['Q-1'])).changedCount).toBe(1);
    let disk = await h.disk();
    expect(disk.progress['Q-1']).toEqual({ ...before.progress['Q-1'], wrongRemoved: true });
    expect(disk.sessions).toEqual(before.sessions);
    await h.second.refreshProgress();
    expect(h.second.wrongQuestions).toHaveLength(0);
    expect(h.second.removedWrongQuestions.map(q => q.id)).toEqual(['Q-1']);
    expect((await h.second.restoreWrongRecords(['Q-1'])).changedCount).toBe(1);
    disk = await h.disk();
    expect(disk.progress['Q-1']).toEqual(before.progress['Q-1']);
    expect(disk.sessions).toEqual(before.sessions);
    expect(h.second.wrongQuestions.map(q => q.id)).toEqual(['Q-1']);
  });

  it('旧标签移除被真实CAS拒绝，答错后的旧恢复也不得覆盖新错题状态', async () => {
    const h = await twoFileBackedClients();
    await h.first.removeWrongRecords(['Q-1']);
    await expect(h.second.removeWrongRecords(['Q-1'])).rejects.toMatchObject({ status: 409, code: 'WRITE_CONFLICT' });
    expect(h.second.progress['Q-1'].wrongRemoved).toBe(true);
    expect((await h.disk()).progress['Q-1'].wrongRemoved).toBe(true);
    await h.second.checkCurrent();
    expect(h.second.progress['Q-1']).toMatchObject({ wrongRemoved: false, wrongCount: 4 });
    await expect(h.first.restoreWrongRecords(['Q-1'])).rejects.toMatchObject({ status: 409, code: 'WRITE_CONFLICT' });
    expect(h.first.progress['Q-1']).toMatchObject({ wrongRemoved: false, wrongCount: 4 });
    const disk = await h.disk();
    expect(disk.progress['Q-1']).toMatchObject({ wrongRemoved: false, wrongCount: 4, note: '应保留的学习笔记', aiNote: '应保留的完整 AI 解析' });
    expect(h.first.wrongQuestions.map(q => q.id)).toEqual(['Q-1']);
  });

  it('真实判分排在移除前时仍使用点击移除时的旧基线，不能将本次新错题隐藏', async () => {
    const h = await twoFileBackedClients();
    const releaseReply = deferred<void>();
    vi.mocked(api.checkStudyQuestion).mockImplementationOnce(async (id, questionId, answer, expectedAnswer) => {
      const result = await h.request(`/sessions/${id}/check`, 'POST', { questionId, answer, expectedAnswer });
      await releaseReply.promise;
      return result;
    });
    const grading = h.first.checkCurrent();
    await settle();
    expect((await h.disk()).progress['Q-1'].wrongCount).toBe(4);
    const removing = h.first.removeWrongRecords(['Q-1']).catch(failure => failure);
    releaseReply.resolve();
    await grading;
    expect((await removing).status).toBe(409);
    expect(api.updateWrongRecordsBatch).toHaveBeenCalledTimes(1);
    expect(api.updateWrongRecordsBatch).toHaveBeenCalledWith({ removed: true, items: [{ questionId: 'Q-1', expected: { wrongRemoved: false, wrongCount: 3, lastAnsweredAt: time } }] });
    expect((await h.disk()).progress['Q-1']).toMatchObject({ wrongRemoved: false, wrongCount: 4 });
    expect(h.first.wrongQuestions.map(q => q.id)).toEqual(['Q-1']);
    expect(h.first.busy).toBe(false);
  });
});
