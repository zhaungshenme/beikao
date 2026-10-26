import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import { emptyProgress, useStudyStore } from '@/store/modules/study';
import * as api from '@/api/study';
import type { QuestionAnswerChanges, StudyBootstrap, StudyQuestion, StudySession } from '@/api/study/types';
import { createStudyApi } from '../server/api.mjs';

vi.mock('@/api/study', () => ({
  loadStudy: vi.fn(), loadQuestionAnswerHistory: vi.fn(), saveQuestionAnswer: vi.fn(), restoreQuestionAnswer: vi.fn(),
  createStudySession: vi.fn(), updateStudySession: vi.fn(), checkStudyQuestion: vi.fn(), finishStudySession: vi.fn(),
  updateQuestionProgress: vi.fn(), getStudySession: vi.fn(),
}));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const question = (revision = 0): StudyQuestion => ({
  id: 'Q-1', category: '测试', chapter: '答案维护', type: 'single', difficulty: '基础', stem: '独立测试题',
  options: [{ id: 'A', text: '原答案' }, { id: 'B', text: '纠正答案' }], answer: [revision % 2 ? 'B' : 'A'],
  explanation: `第 ${revision} 版解析`, answerRevision: revision, knowledgePoint: '知识点', source: '测试夹具',
});
const session = (changes: Partial<StudySession> = {}): StudySession => ({
  id: 'session-1', removed: false, revision: 0, mode: 'sequential', questionIds: ['Q-1'], answers: { 'Q-1': ['B'] },
  submittedQuestionIds: [], createdAt: '2026-10-22T00:00:00.000Z', deadlineAt: null, status: 'active', cursor: 0, ...changes,
});
function snapshot(revision = 0, selected = session()): StudyBootstrap {
  return copy({ questions: [question(revision)], progress: { 'Q-1': { ...emptyProgress(), note: '保留笔记', aiNote: '保留旧解析' } }, sessions: [selected], activeSession: selected.status === 'active' ? selected : null, ai: { configured: false, baseUrl: '', model: '', webUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh' } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function settle() { for (let count = 0; count < 30; count++) await Promise.resolve(); }
async function ready(revision = 0, selected = session()) {
  vi.mocked(api.loadStudy).mockResolvedValue(snapshot(revision, selected));
  const store = useStudyStore(); await store.bootstrap(); vi.mocked(api.loadStudy).mockClear();
  return store;
}
const changes = (expectedRevision = 0): QuestionAnswerChanges => ({ answer: ['B'], explanation: '经核对的新解析', note: '依据已核对', expectedRevision });
beforeEach(() => { vi.resetAllMocks(); setActivePinia(createPinia()); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fileBackedClients() {
  const directory = await mkdtemp(join(tmpdir(), 'yankao-answer-store-'));
  const dataDir = join(directory, 'data'), questionsPath = join(directory, 'questions.json');
  await mkdir(dataDir); await writeFile(questionsPath, JSON.stringify([question()]));
  const server = createStudyApi({ dataDir, questionsPath });
  cleanups.push(async () => {
    await server.close();
    const owned = resolve(directory);
    if (!owned.startsWith(resolve(tmpdir()) + sep) || !owned.split(sep).at(-1)?.startsWith('yankao-answer-store-')) throw new Error('拒绝删除非测试目录');
    await rm(owned, { recursive: true, force: true });
  });
  async function request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const req = { url: `/study-api${path}`, method, headers: { host: '127.0.0.1:18103', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    let text = '';
    const res = { statusCode: 200, setHeader() {}, end(value: string) { text = value; } };
    await server.handle(req, res);
    const result = JSON.parse(text);
    if (res.statusCode >= 400) throw Object.assign(new Error(result.error || result.message), { status: res.statusCode, code: result.code, current: result.current });
    return result;
  }
  vi.mocked(api.loadStudy).mockImplementation(() => request('/bootstrap'));
  vi.mocked(api.createStudySession).mockImplementation(body => request('/sessions', 'POST', body));
  vi.mocked(api.getStudySession).mockImplementation(id => request(`/sessions/${id}`));
  vi.mocked(api.updateStudySession).mockImplementation((id, body) => request(`/sessions/${id}`, 'PATCH', body));
  vi.mocked(api.checkStudyQuestion).mockImplementation((id, questionId, answer, expectedAnswer, expectedQuestionRevision) => request(`/sessions/${id}/check`, 'POST', { questionId, answer, expectedAnswer, expectedQuestionRevision }));
  vi.mocked(api.finishStudySession).mockImplementation((id, expectedAnswers, expectedQuestionRevisions) => request(`/sessions/${id}/finish`, 'POST', { expectedAnswers, expectedQuestionRevisions }));
  vi.mocked(api.saveQuestionAnswer).mockImplementation((id, body) => request(`/questions/${id}/answer`, 'PUT', body));
  vi.mocked(api.restoreQuestionAnswer).mockImplementation((id, body) => request(`/questions/${id}/answer/restore`, 'POST', body));
  vi.mocked(api.loadQuestionAnswerHistory).mockImplementation(id => request(`/questions/${id}/answer-history`));
  const created = await request('/sessions', 'POST', { mode: 'sequential', count: 1, minutes: 10, questionIds: ['Q-1'] });
  await request(`/sessions/${created.id}`, 'PATCH', { questionId: 'Q-1', answer: ['B'], expectedAnswer: [] });
  setActivePinia(createPinia()); const first = useStudyStore(); await first.bootstrap();
  setActivePinia(createPinia()); const second = useStudyStore(); await second.bootstrap();
  return { first, second, request, disk: async () => JSON.parse(await readFile(join(dataDir, 'learning-state.json'), 'utf8')), bank: () => readFile(questionsPath, 'utf8') };
}

describe('标准答案纠正与旧成绩视图的并发保护', () => {
  it('纠正保存后即使刷新拿到旧题库，也不回滚新答案或已有笔记', async () => {
    const store = await ready();
    vi.mocked(api.saveQuestionAnswer).mockResolvedValue({ question: question(1) });
    const result = await store.correctQuestionAnswer('Q-1', changes());
    expect(api.saveQuestionAnswer).toHaveBeenCalledExactlyOnceWith('Q-1', changes());
    expect(result.answerRevision).toBe(1);
    expect(store.questionMap['Q-1']).toMatchObject({ answer: ['B'], answerRevision: 1, explanation: '第 1 版解析' });
    expect(store.progress['Q-1']).toMatchObject({ note: '保留笔记', aiNote: '保留旧解析' });
    expect(store.busy).toBe(false);
  });

  it('旧 bootstrap 在纠正完成后晚到，重读也不能把版本 1 降到版本 0', async () => {
    const store = await ready();
    const old = deferred<StudyBootstrap>();
    vi.mocked(api.loadStudy).mockReturnValueOnce(old.promise).mockResolvedValue(snapshot());
    const refresh = store.bootstrap(); await settle();
    vi.mocked(api.saveQuestionAnswer).mockResolvedValue({ question: question(1) });
    await store.correctQuestionAnswer('Q-1', changes());
    old.resolve(snapshot()); await refresh;
    expect(store.questionMap['Q-1'].answerRevision).toBe(1);
    expect(store.questionMap['Q-1'].answer).toEqual(['B']);
  });

  it('恢复使用当前版本作 CAS 并接受递增的新版本，迟到的历史读取不能回退', async () => {
    const store = await ready(1);
    const oldHistory = deferred<any>();
    vi.mocked(api.loadQuestionAnswerHistory).mockReturnValueOnce(oldHistory.promise);
    const history = store.syncQuestionAnswer('Q-1');
    vi.mocked(api.restoreQuestionAnswer).mockResolvedValue({ question: question(2) });
    await store.restoreQuestionAnswerVersion('Q-1', 'original-Q-1', 1);
    oldHistory.resolve({ question: question(0), entries: [] });
    const read = await history;
    expect(api.restoreQuestionAnswer).toHaveBeenCalledExactlyOnceWith('Q-1', { historyId: 'original-Q-1', expectedRevision: 1 });
    expect(store.questionMap['Q-1'].answerRevision).toBe(2);
    expect(read.question.answerRevision).toBe(2);
  });

  it('其他页面纠正后普通刷新也同步冻结判分快照，旧成绩不会配上新标准', async () => {
    const graded = session({ status: 'completed', submittedQuestionIds: ['Q-1'], score: 0, correctCount: 0 });
    const store = await ready(0, graded);
    store.viewHistory(store.sessions[0]);
    const frozen = { questionId: 'Q-1', correct: false, answer: ['A'], userAnswer: ['B'], explanation: '第 0 版解析', questionRevision: 0 };
    vi.mocked(api.loadStudy).mockResolvedValue(snapshot(1, session({ ...graded, revision: 1, gradedResults: { 'Q-1': frozen } })));
    await store.refreshProgress();
    expect(store.questionMap['Q-1'].answer).toEqual(['B']);
    expect(store.currentSession?.gradedResults?.['Q-1']).toEqual(frozen);
    expect(store.currentSession?.score).toBe(0);
  });

  it('另一页更正导致保存冲突时只请求一次，保留作答与本页纠正参数', async () => {
    const store = await ready();
    const draft = changes();
    const failure = Object.assign(new Error('另一页面已更新'), { status: 409, code: 'WRITE_CONFLICT', current: question(2) });
    vi.mocked(api.saveQuestionAnswer).mockRejectedValue(failure);
    await expect(store.correctQuestionAnswer('Q-1', draft)).rejects.toBe(failure);
    expect(api.saveQuestionAnswer).toHaveBeenCalledTimes(1);
    expect(draft).toEqual(changes());
    expect(store.activeSession?.answers['Q-1']).toEqual(['B']);
    expect(store.hasAnswerConflicts).toBe(false);
    expect(store.questionMap['Q-1'].answerRevision).toBe(2);
  });

  it('判分发送所见的标准版本，标准更新冲突不会误报用户作答冲突或自动重提', async () => {
    const store = await ready(1);
    const failure = Object.assign(new Error('标准答案已更新，请确认新标准后提交'), { status: 409, code: 'QUESTION_UPDATED', current: question(2) });
    vi.mocked(api.checkStudyQuestion).mockRejectedValue(failure);
    await expect(store.checkCurrent()).rejects.toBe(failure);
    expect(api.checkStudyQuestion).toHaveBeenCalledExactlyOnceWith('session-1', 'Q-1', ['B'], ['B'], 1);
    expect(store.hasAnswerConflicts).toBe(false);
    expect(store.activeSession?.answers['Q-1']).toEqual(['B']);
    expect(store.questionMap['Q-1'].answerRevision).toBe(2);
    expect(store.busy).toBe(false);
  });

  it('交卷整体版本冲突同步全部新标准并保留整卷，不触发自动重交', async () => {
    const store = await ready(1, session({ mode: 'exam' }));
    const failure = Object.assign(new Error('标准答案已更新，请确认后重新交卷'), { status: 409, code: 'QUESTION_UPDATED', current: { questions: [question(2)] } });
    vi.mocked(api.finishStudySession).mockRejectedValue(failure);
    await expect(store.finish()).rejects.toBe(failure);
    expect(api.finishStudySession).toHaveBeenCalledExactlyOnceWith('session-1', { 'Q-1': ['B'] }, { 'Q-1': 1 });
    expect(store.hasAnswerConflicts).toBe(false);
    expect(store.activeSession?.status).toBe('active');
    expect(store.activeSession?.answers['Q-1']).toEqual(['B']);
    expect(store.questionMap['Q-1'].answerRevision).toBe(2);
  });

  it('保存成功而记录刷新断线时仍确认保存成功，不诱导重复纠正', async () => {
    const completed = session({ status: 'completed', submittedQuestionIds: ['Q-1'], score: 0, correctCount: 0 });
    const store = await ready(0, completed);
    store.viewHistory(store.sessions[0]);
    vi.mocked(api.saveQuestionAnswer).mockResolvedValue({ question: question(1) });
    vi.mocked(api.loadStudy).mockRejectedValue(new Error('断线'));
    await expect(store.correctQuestionAnswer('Q-1', changes())).resolves.toMatchObject({ answerRevision: 1 });
    expect(store.questionMap['Q-1'].answerRevision).toBe(1);
    expect(store.currentSession?.gradedResults?.['Q-1']).toMatchObject({ correct: false, answer: ['A'], questionRevision: 0 });
    expect(store.currentSession?.score).toBe(0);
    expect(store.error).toContain('标准答案已保存');
    expect(store.busy).toBe(false);
  });

  it('标准冲突后刷新断线也不能让同页旧复盘误用新答案', async () => {
    const pending = session();
    const completed = session({ id: 'old-session', status: 'completed', submittedQuestionIds: ['Q-1'], score: 0, correctCount: 0 });
    const initial = snapshot(); initial.sessions.push(completed);
    vi.mocked(api.loadStudy).mockResolvedValue(initial);
    const store = useStudyStore(); await store.bootstrap();
    vi.mocked(api.loadStudy).mockRejectedValue(new Error('断线'));
    vi.mocked(api.checkStudyQuestion).mockRejectedValue(Object.assign(new Error('标准更新'), { status: 409, code: 'QUESTION_UPDATED', current: question(1) }));
    await expect(store.checkCurrent()).rejects.toMatchObject({ code: 'QUESTION_UPDATED' });
    expect(store.questionMap['Q-1'].answerRevision).toBe(1);
    const historic = store.sessions.find(item => item.id === 'old-session')!;
    expect(historic.gradedResults?.['Q-1']).toMatchObject({ correct: false, answer: ['A'], questionRevision: 0 });
    expect(historic.score).toBe(0);
    expect(store.activeSession?.answers).toEqual(pending.answers);
    expect(store.hasAnswerConflicts).toBe(false);
  });
});

describe('标准答案纠正贯通真实文件后端与两个独立客户端', () => {
  it('旧页面首次判分被新版标准拦截，确认后再次提交按新标准判分且只累计一次', async () => {
    const h = await fileBackedClients();
    const originalBank = await h.bank();
    await h.first.correctQuestionAnswer('Q-1', changes());
    await expect(h.second.checkCurrent()).rejects.toMatchObject({ status: 409, code: 'QUESTION_UPDATED' });
    expect(h.second.hasAnswerConflicts).toBe(false);
    expect(h.second.activeSession?.answers['Q-1']).toEqual(['B']);
    expect((await h.disk()).progress['Q-1']).toBeUndefined();
    const checked = await h.second.checkCurrent();
    expect(checked).toMatchObject({ correct: true, answer: ['B'], questionRevision: 1 });
    expect(checked?.session.gradedResults?.['Q-1']).toMatchObject({ answer: ['B'], questionRevision: 1 });
    const finished = await h.second.finish();
    expect(finished?.session).toMatchObject({ score: 100, correctCount: 1 });
    expect((await h.disk()).progress['Q-1']).toMatchObject({ attempts: 1, correctCount: 1 });
    expect(await h.bank()).toBe(originalBank);
  });

  it('已完成的旧成绩在纠正及恢复后保留旧判分，新练习使用当前标准', async () => {
    const h = await fileBackedClients();
    await h.second.checkCurrent();
    const finished = await h.second.finish();
    expect(finished?.session.score).toBe(0);
    await h.first.correctQuestionAnswer('Q-1', changes());
    await h.second.refreshProgress();
    expect(h.second.questionMap['Q-1'].answer).toEqual(['B']);
    expect(h.second.currentSession?.gradedResults?.['Q-1']).toMatchObject({ correct: false, answer: ['A'], questionRevision: 0 });
    expect(h.second.currentSession?.score).toBe(0);
    const history = await h.first.syncQuestionAnswer('Q-1');
    const original = history.entries.find(entry => entry.revision === 0)!;
    await h.first.restoreQuestionAnswerVersion('Q-1', original.id, 1);
    await h.second.refreshProgress();
    expect(h.second.questionMap['Q-1']).toMatchObject({ answer: ['A'], answerRevision: 2 });
    expect(h.second.currentSession?.score).toBe(0);
    expect(h.second.currentSession?.gradedResults?.['Q-1'].questionRevision).toBe(0);
    await h.second.startSession({ mode: 'sequential', count: 1, minutes: 10, questionIds: ['Q-1'] });
    await h.second.persistAnswer('Q-1', ['A']);
    expect(await h.second.checkCurrent()).toMatchObject({ correct: true, questionRevision: 2 });
  });

  it('两个编辑器的旧基线纠正被服务端拒绝，不覆盖前页答案且恢复仍有完整历史', async () => {
    const h = await fileBackedClients();
    await h.first.correctQuestionAnswer('Q-1', changes());
    const bytes = JSON.stringify(await h.disk());
    await expect(h.second.correctQuestionAnswer('Q-1', { ...changes(), answer: ['A'], explanation: '旧编辑器的修改' })).rejects.toMatchObject({ status: 409, code: 'WRITE_CONFLICT' });
    expect(JSON.stringify(await h.disk())).toBe(bytes);
    expect(h.second.questionMap['Q-1']).toMatchObject({ answer: ['B'], answerRevision: 1 });
    expect(h.second.activeSession?.answers['Q-1']).toEqual(['B']);
    const history = await h.second.syncQuestionAnswer('Q-1');
    expect(history.entries.map(entry => entry.revision)).toEqual([1, 0]);
  });

  it('真实保存响应已携带冻结成绩，后续刷新断线仍可安全展示新标准与旧成绩', async () => {
    const h = await fileBackedClients();
    await h.second.checkCurrent(); await h.second.finish();
    vi.mocked(api.loadStudy).mockRejectedValue(new Error('保存之后断线'));
    await h.second.correctQuestionAnswer('Q-1', changes());
    expect(h.second.currentSession?.gradedResults?.['Q-1']).toMatchObject({ correct: false, answer: ['A'], questionRevision: 0 });
    expect(h.second.currentSession?.score).toBe(0);
    expect(h.second.questionMap['Q-1']).toMatchObject({ answer: ['B'], answerRevision: 1 });
    expect(h.second.error).toContain('标准答案已保存');
    const disk = await h.disk();
    expect(disk.sessions[0].score).toBe(0);
    expect(disk.sessions[0].gradedResults['Q-1']).toMatchObject({ correct: false, answer: ['A'], questionRevision: 0 });
  });
});
