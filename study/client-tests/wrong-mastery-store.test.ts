import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { emptyProgress, useStudyStore } from '@/store/modules/study';
import * as api from '@/api/study';
import type { QuestionProgress, StudyBootstrap, StudySession, WrongMasteryBatchResponse } from '@/api/study/types';
import { createStudyApi } from '../server/api.mjs';

vi.mock('@/api/study', () => ({
  loadStudy: vi.fn(), createStudySession: vi.fn(), updateStudySession: vi.fn(), getStudySession: vi.fn(),
  checkStudyQuestion: vi.fn(), finishStudySession: vi.fn(), updateQuestionProgress: vi.fn(), updateWrongMasteryBatch: vi.fn(),
}));
const time = '2026-10-22T00:00:00.000Z', later = '2026-10-22T01:00:00.000Z';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const progress = (changes: Partial<QuestionProgress> = {}): QuestionProgress => ({
  ...emptyProgress(), attempts: 4, wrongCount: 3, correctCount: 1, lastAnswer: ['B'], lastCorrect: false,
  lastAnsweredAt: time, note: '原笔记', reason: '易混点', aiNote: '原AI解析', favorite: true, ...changes,
});
const questions = ['Q-1', 'Q-2', 'Q-3'].map(id => ({ id, category: '独立测试', chapter: '掌握状态', type: 'single' as const, difficulty: '基础' as const,
  stem: id, options: [{ id: 'A', text: '正确' }, { id: 'B', text: '错误' }], answer: ['A'], explanation: '原解析', knowledgePoint: '理论', source: '测试夹具' }));
const session = (): StudySession => ({ id: 'S-1', removed: false, revision: 0, mode: 'sequential', questionIds: ['Q-1'], answers: { 'Q-1': ['B'] }, submittedQuestionIds: [], createdAt: time, deadlineAt: null, status: 'active', cursor: 0 });
function snapshot(changes: Partial<StudyBootstrap> = {}): StudyBootstrap {
  const current = session();
  return copy({ questions, progress: { 'Q-1': progress(), 'Q-2': progress({ mastered: true }), 'Q-3': progress({ wrongCount: 0 }) }, sessions: [current], activeSession: current, ai: { configured: false, baseUrl: '', model: '', webUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh' }, ...changes });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function settle() { for (let count = 0; count < 30; count++) await Promise.resolve(); }
async function ready(initial = snapshot()) {
  vi.mocked(api.loadStudy).mockResolvedValue(copy(initial));
  const store = useStudyStore(); await store.bootstrap(); vi.mocked(api.loadStudy).mockClear(); return store;
}
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.resetAllMocks(); setActivePinia(createPinia()); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('错题掌握状态只更新授权字段并保护新判分', () => {
  it('去重并携带点击时四字段基线，保存前不提前变状态，保存后保留新正文与统计', async () => {
    const store = await ready();
    const saved = deferred<WrongMasteryBatchResponse>();
    vi.mocked(api.updateWrongMasteryBatch).mockReturnValue(saved.promise);
    const marking = store.markWrongMastered(['Q-1', 'Q-1']); await settle();
    expect(store.progress['Q-1'].mastered).toBe(false);
    expect(store.busy).toBe(true);
    expect(api.updateWrongMasteryBatch).toHaveBeenCalledExactlyOnceWith({ mastered: true, items: [{ questionId: 'Q-1', expected: { mastered: false, wrongRemoved: false, wrongCount: 3, lastAnsweredAt: time } }] });
    store.progress['Q-1'].note = '保存中更新的笔记'; store.progress['Q-1'].aiNote = '保存中更新的解析';
    saved.resolve({ changedCount: 1, progress: { 'Q-1': progress({ mastered: true, wrongCount: 1, attempts: 1, note: '过时笔记', aiNote: '过时解析' }) } });
    expect((await marking).changedCount).toBe(1);
    expect(store.progress['Q-1']).toMatchObject({ mastered: true, wrongRemoved: false, wrongCount: 3, attempts: 4, note: '保存中更新的笔记', aiNote: '保存中更新的解析', reason: '易混点', favorite: true });
    expect(store.busy).toBe(false);
  });

  it('取消掌握同样使用精确基线，仅改变mastered', async () => {
    const store = await ready();
    const before = copy(store.progress['Q-2']);
    vi.mocked(api.updateWrongMasteryBatch).mockResolvedValue({ changedCount: 1, progress: { 'Q-2': progress({ mastered: false }) } });
    await store.markWrongPending(['Q-2']);
    expect(api.updateWrongMasteryBatch).toHaveBeenCalledExactlyOnceWith({ mastered: false, items: [{ questionId: 'Q-2', expected: { mastered: true, wrongRemoved: false, wrongCount: 3, lastAnsweredAt: time } }] });
    expect(store.progress['Q-2']).toEqual({ ...before, mastered: false });
  });

  it.each([
    { wrongCount: 4, lastAnsweredAt: later, mastered: false },
    { wrongCount: 3, lastAnsweredAt: later, mastered: false },
    { wrongRemoved: true, mastered: false },
  ])('较新学习/删除状态 %j 到达后，迟到掌握响应不能覆盖', async fresh => {
    const store = await ready();
    const saved = deferred<WrongMasteryBatchResponse>();
    vi.mocked(api.updateWrongMasteryBatch).mockReturnValue(saved.promise);
    const marking = store.markWrongMastered(['Q-1']); await settle();
    Object.assign(store.progress['Q-1'], fresh);
    saved.resolve({ changedCount: 1, progress: { 'Q-1': progress({ mastered: true }) } }); await marking;
    expect(store.progress['Q-1']).toMatchObject(fresh);
    expect(store.progress['Q-1'].mastered).toBe(false);
  });

  it('发出前的旧快照晚返回时会重读，不能恢复掌握前状态', async () => {
    const store = await ready();
    const held = deferred<StudyBootstrap>();
    const fresh = snapshot({ progress: { 'Q-1': progress({ mastered: true }) } });
    vi.mocked(api.loadStudy).mockReturnValueOnce(held.promise).mockResolvedValue(fresh);
    const reading = store.refreshProgress(); await settle();
    vi.mocked(api.updateWrongMasteryBatch).mockResolvedValue({ changedCount: 1, progress: fresh.progress });
    await store.markWrongMastered(['Q-1']); held.resolve(snapshot()); await reading;
    expect(api.loadStudy).toHaveBeenCalledTimes(2);
    expect(store.progress['Q-1'].mastered).toBe(true);
  });

  it('409只刷新一次并抛出原冲突，不重试覆盖新的答错状态', async () => {
    const store = await ready();
    const error = Object.assign(new Error('新答错使旧操作失效'), { status: 409, code: 'WRITE_CONFLICT' });
    vi.mocked(api.updateWrongMasteryBatch).mockRejectedValue(error);
    vi.mocked(api.loadStudy).mockResolvedValue(snapshot({ progress: { 'Q-1': progress({ wrongCount: 4, lastAnsweredAt: later }) } }));
    await expect(store.markWrongMastered(['Q-1'])).rejects.toBe(error);
    expect(api.updateWrongMasteryBatch).toHaveBeenCalledTimes(1);
    expect(api.loadStudy).toHaveBeenCalledTimes(1);
    expect(store.progress['Q-1']).toMatchObject({ mastered: false, wrongCount: 4, lastAnsweredAt: later });
    expect(store.busy).toBe(false);
  });

  it('写盘失败不改变状态或正文，并释放操作中状态', async () => {
    const store = await ready(); const before = copy(store.progress);
    vi.mocked(api.updateWrongMasteryBatch).mockRejectedValue(new Error('写盘失败'));
    await expect(store.markWrongMastered(['Q-1'])).rejects.toThrow('写盘失败');
    expect(store.progress).toEqual(before); expect(store.busy).toBe(false);
  });

  it('无选择不请求；未知、无错题或已删除题目整批在前端拒绝', async () => {
    const store = await ready();
    expect(await store.markWrongMastered([])).toEqual({ progress: {}, changedCount: 0 });
    await expect(store.markWrongMastered(['Q-1', 'missing'])).rejects.toThrow();
    await expect(store.markWrongMastered(['Q-1', 'Q-3'])).rejects.toThrow();
    store.progress['Q-1'].wrongRemoved = true;
    await expect(store.markWrongMastered(['Q-1'])).rejects.toThrow();
    store.progress['Q-1'].wrongRemoved = false; store.questionRecords['Q-1'] = { removed: true, revision: 1 };
    await expect(store.markWrongMastered(['Q-1'])).rejects.toThrow();
    expect(api.updateWrongMasteryBatch).not.toHaveBeenCalled();
  });
});

async function fileBackedClients() {
  const directory = await mkdtemp(join(tmpdir(), 'yankao-mastery-store-'));
  const dataDir = join(directory, 'data'), questionsPath = join(directory, 'questions.json');
  await mkdir(dataDir); await writeFile(questionsPath, JSON.stringify(questions));
  await writeFile(join(dataDir, 'learning-state.json'), JSON.stringify({ version: 1, progress: { 'Q-1': progress(), 'Q-2': progress() }, sessions: [] }));
  const server = createStudyApi({ dataDir, questionsPath });
  cleanups.push(async () => {
    await server.close(); const owned = resolve(directory);
    if (!owned.startsWith(resolve(tmpdir()) + sep) || !owned.split(sep).at(-1)?.startsWith('yankao-mastery-store-')) throw new Error('拒绝删除非测试目录');
    await rm(owned, { recursive: true, force: true });
  });
  async function request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const req = { url: `/study-api${path}`, method, headers: { host: '127.0.0.1:18103', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    let text = ''; const res = { statusCode: 200, setHeader() {}, end(value: string) { text = value; } };
    await server.handle(req, res); const result = JSON.parse(text);
    if (res.statusCode >= 400) throw Object.assign(new Error(result.error || result.message), { status: res.statusCode, code: result.code, current: result.current });
    return result;
  }
  vi.mocked(api.loadStudy).mockImplementation(() => request('/bootstrap'));
  vi.mocked(api.createStudySession).mockImplementation(body => request('/sessions', 'POST', body));
  vi.mocked(api.updateStudySession).mockImplementation((id, body) => request(`/sessions/${id}`, 'PATCH', body));
  vi.mocked(api.checkStudyQuestion).mockImplementation((id, questionId, answer, expectedAnswer, expectedQuestionRevision) => request(`/sessions/${id}/check`, 'POST', { questionId, answer, expectedAnswer, expectedQuestionRevision }));
  vi.mocked(api.updateWrongMasteryBatch).mockImplementation(body => request('/wrong-records/mastery', 'POST', body));
  setActivePinia(createPinia()); const first = useStudyStore(); await first.bootstrap();
  setActivePinia(createPinia()); const second = useStudyStore(); await second.bootstrap();
  return { first, second, request, disk: async () => JSON.parse(await readFile(join(dataDir, 'learning-state.json'), 'utf8')) };
}

describe('两个客户端与真实文件后端贯通掌握状态链路', () => {
  it('批量标记后错题重练排除已掌握，取消后重新进入且正文不变', async () => {
    const h = await fileBackedClients(); const before = await h.disk();
    await h.first.markWrongMastered(['Q-1', 'Q-2']);
    expect(h.first.progress['Q-1'].mastered).toBe(true);
    await expect(h.first.startSession({ mode: 'wrong', count: 5, minutes: 10 })).rejects.toThrow();
    await h.first.markWrongPending(['Q-1']);
    const study = await h.first.startSession({ mode: 'wrong', count: 5, minutes: 10 });
    expect(study.questionIds).toEqual(['Q-1']);
    const after = await h.disk();
    expect(after.progress['Q-1']).toEqual(before.progress['Q-1']);
    expect(after.progress['Q-2']).toEqual({ ...before.progress['Q-2'], mastered: true });
  });

  it('旧页尚未见新答错时标掌握整批失败，同批其他题也不受影响', async () => {
    const h = await fileBackedClients();
    const study = await h.first.startSession({ mode: 'sequential', count: 1, minutes: 10, questionIds: ['Q-1'] });
    await h.first.persistAnswer('Q-1', ['B']); await h.first.checkCurrent();
    expect(h.first.progress['Q-1'].wrongCount).toBe(4);
    await expect(h.second.markWrongMastered(['Q-1', 'Q-2'])).rejects.toMatchObject({ status: 409, code: 'WRITE_CONFLICT' });
    expect(h.second.progress['Q-1']).toMatchObject({ mastered: false, wrongCount: 4 });
    expect((await h.disk()).progress['Q-2'].mastered).toBe(false);
    expect((await h.disk()).sessions.find((item: StudySession) => item.id === study.id).submittedQuestionIds).toEqual(['Q-1']);
  });

  it('标记掌握后再次答错自动回到待巩固，旧页取消掌握也不能静默覆盖新结果', async () => {
    const h = await fileBackedClients();
    await h.first.markWrongMastered(['Q-1']); await h.second.refreshProgress();
    const study = await h.first.startSession({ mode: 'sequential', count: 1, minutes: 10, questionIds: ['Q-1'] });
    await h.first.persistAnswer('Q-1', ['B']); await h.first.checkCurrent();
    expect(h.first.progress['Q-1']).toMatchObject({ mastered: false, wrongCount: 4 });
    await expect(h.second.markWrongPending(['Q-1'])).rejects.toMatchObject({ status: 409, code: 'WRITE_CONFLICT' });
    expect(h.second.progress['Q-1']).toMatchObject({ mastered: false, wrongCount: 4 });
    expect((await h.disk()).progress['Q-1']).toMatchObject({ mastered: false, wrongCount: 4, note: '原笔记', aiNote: '原AI解析' });
    expect((await h.disk()).sessions.find((item: StudySession) => item.id === study.id)).toBeDefined();
  });
});
