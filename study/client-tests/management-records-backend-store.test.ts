import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { emptyProgress, useStudyStore } from '@/store/modules/study';
import * as api from '@/api/study';
import type { QuestionProgress, StudyQuestion, StudySession } from '@/api/study/types';
import { createStudyApi } from '../server/api.mjs';

vi.mock('@/api/study', () => ({
  loadStudy: vi.fn(), createStudySession: vi.fn(), updateStudySession: vi.fn(), getStudySession: vi.fn(),
  checkStudyQuestion: vi.fn(), finishStudySession: vi.fn(), updateQuestionProgress: vi.fn(),
  updateWrongRecordsBatch: vi.fn(), updateQuestionRecordsBatch: vi.fn(), updateSessionRecordsBatch: vi.fn(),
}));

const cleanups: Array<() => Promise<void>> = [];
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const content = (session: StudySession) => { const result = copy(session) as Partial<StudySession>; delete result.removed; delete result.revision; return result; };
const questions: StudyQuestion[] = ['Q-1', 'Q-2', 'Q-3'].map(id => ({ id, category: '独立管理集成测试', chapter: '可恢复删除', type: 'single', difficulty: '基础', stem: `${id} 的完整题干`, options: [{ id: 'A', text: '正确答案' }, { id: 'B', text: '错误答案' }], answer: ['A'], explanation: '完整原始解析', knowledgePoint: '记录保护', source: '原创测试夹具' }));
const initialProgress = (): QuestionProgress => ({ ...emptyProgress(), attempts: 4, correctCount: 1, wrongCount: 3, lastAnswer: ['B'], lastCorrect: false, lastAnsweredAt: '2026-01-01T00:00:00.000Z', favorite: true, note: '不能被删除操作清空的笔记', reason: '不能被删除操作清空的错因', aiNote: '不能被删除操作清空的 AI 解析' });

beforeEach(() => { vi.resetAllMocks(); setActivePinia(createPinia()); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

// Both Pinia clients call the production file-backed handler. The transport below
// performs no comparison, retry, baseline repair, or state mutation of its own.
async function twoFileBackedClients() {
  const directory = await mkdtemp(join(tmpdir(), 'yankao-management-store-'));
  const dataDir = join(directory, 'data');
  const questionsPath = join(directory, 'questions.json');
  const statePath = join(dataDir, 'learning-state.json');
  await mkdir(dataDir);
  await writeFile(questionsPath, JSON.stringify(questions), 'utf8');
  await writeFile(statePath, JSON.stringify({ version: 1, progress: { 'Q-1': initialProgress(), 'Q-2': initialProgress() }, sessions: [], textHistory: [{ id: 'history-to-retain', questionId: 'Q-1', field: 'note', text: '仍需保留的旧笔记全文', createdAt: '2025-12-31T00:00:00.000Z', source: 'manual' }] }), 'utf8');
  const server = createStudyApi({ dataDir, questionsPath });
  cleanups.push(async () => {
    await server.close();
    const owned = resolve(directory);
    if (!owned.startsWith(resolve(tmpdir()) + sep) || !owned.split(sep).at(-1)?.startsWith('yankao-management-store-')) throw new Error('拒绝删除非测试目录');
    await rm(owned, { recursive: true, force: true });
  });
  async function request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const req = { url: `/study-api${path}`, method, headers: { host: '127.0.0.1:18103', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    let text = '';
    const res = { statusCode: 200, setHeader() {}, end(value: string) { text = value; } };
    await server.handle(req, res);
    const result = JSON.parse(text);
    if (res.statusCode >= 400) throw Object.assign(new Error(result.error || result.message), { status: res.statusCode, code: result.code, current: result.current, historyId: result.historyId });
    return result;
  }
  const session = await request('/sessions', 'POST', { mode: 'sequential', count: 2, minutes: 10, questionIds: ['Q-1', 'Q-2'] });
  await request(`/sessions/${session.id}`, 'PATCH', { questionId: 'Q-1', answer: ['B'], expectedAnswer: [] });
  await request(`/sessions/${session.id}`, 'PATCH', { questionId: 'Q-2', answer: ['B'], expectedAnswer: [] });
  vi.mocked(api.loadStudy).mockImplementation(() => request('/bootstrap'));
  vi.mocked(api.createStudySession).mockImplementation(options => request('/sessions', 'POST', options));
  vi.mocked(api.getStudySession).mockImplementation(id => request(`/sessions/${id}`));
  vi.mocked(api.updateStudySession).mockImplementation((id, body) => request(`/sessions/${id}`, 'PATCH', body));
  vi.mocked(api.checkStudyQuestion).mockImplementation((id, questionId, answer, expectedAnswer) => request(`/sessions/${id}/check`, 'POST', { questionId, answer, expectedAnswer }));
  vi.mocked(api.finishStudySession).mockImplementation((id, expectedAnswers) => request(`/sessions/${id}/finish`, 'POST', { expectedAnswers }));
  vi.mocked(api.updateQuestionProgress).mockImplementation((id, body) => request(`/questions/${id}`, 'PATCH', body));
  vi.mocked(api.updateQuestionRecordsBatch).mockImplementation(body => request('/question-records/batch', 'POST', body));
  vi.mocked(api.updateSessionRecordsBatch).mockImplementation(body => request('/session-records/batch', 'POST', body));
  vi.mocked(api.updateWrongRecordsBatch).mockImplementation(body => request('/wrong-records/batch', 'POST', body));
  setActivePinia(createPinia());
  const first = useStudyStore(); await first.bootstrap();
  setActivePinia(createPinia());
  const second = useStudyStore(); await second.bootstrap();
  return { first, second, request, sessionId: session.id, disk: async () => JSON.parse(await readFile(statePath, 'utf8')), bytes: async () => readFile(statePath, 'utf8'), bank: async () => readFile(questionsPath, 'utf8') };
}

describe('记录管理使用真实文件后端与两个独立学习客户端', () => {
  it('旧列表删除携带自己看到的旧revision，外页新答案使其409且不丢失已保存答案', async () => {
    const h = await twoFileBackedClients();
    const visible = copy(h.second.sessions.find(session => session.id === h.sessionId)!);
    expect(visible.revision).toBe(2);
    await h.first.persistAnswer('Q-1', ['A']);
    const freshHash = hash(await h.bytes());
    await expect(h.second.removeSessionRecords([h.sessionId])).rejects.toMatchObject({ status: 409, code: 'WRITE_CONFLICT' });
    expect(api.updateSessionRecordsBatch).toHaveBeenCalledTimes(1);
    expect(api.updateSessionRecordsBatch).toHaveBeenCalledWith({ removed: true, items: [{ sessionId: h.sessionId, expected: { removed: false, revision: visible.revision } }] });
    expect(hash(await h.bytes())).toBe(freshHash);
    const saved = (await h.disk()).sessions.find((session: StudySession) => session.id === h.sessionId);
    expect(saved).toMatchObject({ removed: false, revision: 3, answers: { 'Q-1': ['A'], 'Q-2': ['B'] } });
    expect(h.second.sessions.find(session => session.id === h.sessionId)?.answers['Q-1']).toEqual(['A']);
    expect(h.second.busy).toBe(false);
  });

  it('仅进度刷新不能给旧学习记录正文换上对端的新revision，随后删除仍被真实CAS拒绝', async () => {
    const h = await twoFileBackedClients();
    const visible = copy(h.second.sessions.find(session => session.id === h.sessionId)!);
    await h.first.persistAnswer('Q-1', ['A']);
    const freshHash = hash(await h.bytes());
    await h.second.refreshProgress();
    const stillVisible = h.second.sessions.find(session => session.id === h.sessionId)!;
    expect(stillVisible.answers).toEqual(visible.answers);
    expect(stillVisible.revision).toBe(visible.revision);
    expect(h.second.activeSession?.answers).toEqual(visible.answers);
    await expect(h.second.removeSessionRecords([h.sessionId])).rejects.toMatchObject({ status: 409, code: 'WRITE_CONFLICT' });
    expect(api.updateSessionRecordsBatch).toHaveBeenCalledTimes(1);
    expect(api.updateSessionRecordsBatch).toHaveBeenCalledWith({ removed: true, items: [{ sessionId: h.sessionId, expected: { removed: false, revision: visible.revision } }] });
    expect(hash(await h.bytes())).toBe(freshHash);
    expect((await h.disk()).sessions[0].answers['Q-1']).toEqual(['A']);
  });

  it('判分其他题时服务端返回的新答案必须同时更新展示和后续CAS基线', async () => {
    const h = await twoFileBackedClients();
    expect(h.second.activeSession?.answers['Q-2']).toEqual(['B']);
    await h.first.persistAnswer('Q-2', ['A']);
    await h.second.checkCurrent();
    expect(h.second.activeSession?.answers['Q-2']).toEqual(['A']);
    expect(h.second.sessions.find(session => session.id === h.sessionId)?.answers['Q-2']).toEqual(['A']);
    expect(h.second.activeSession?.submittedQuestionIds).toEqual(['Q-1']);
    await h.second.persistAnswer('Q-2', ['B']);
    expect(api.updateStudySession).toHaveBeenLastCalledWith(h.sessionId, { questionId: 'Q-2', answer: ['B'], expectedAnswer: ['A'] });
    expect((await h.disk()).sessions[0].answers['Q-2']).toEqual(['B']);
    expect(h.second.hasAnswerConflicts).toBe(false);
  });

  it('题目删除恢复保留进度与原题，已有学习仍可作答而新题池排除已删题', async () => {
    const h = await twoFileBackedClients();
    const original = await h.disk();
    const originalBank = hash(await h.bank());
    expect((await h.first.removeQuestionRecords(['Q-1'])).changedCount).toBe(1);
    const deleted = await h.disk();
    expect(deleted.progress).toEqual(original.progress);
    expect(deleted.sessions).toEqual(original.sessions);
    expect(deleted.textHistory).toEqual(original.textHistory);
    expect(hash(await h.bank())).toBe(originalBank);
    await h.second.bootstrap();
    expect(h.second.availableQuestions.map(question => question.id)).toEqual(['Q-2', 'Q-3']);
    expect(h.second.removedQuestions.map(question => question.id)).toEqual(['Q-1']);
    await h.second.persistAnswer('Q-1', ['A']);
    expect((await h.disk()).sessions.find((session: StudySession) => session.id === h.sessionId).answers['Q-1']).toEqual(['A']);
    const next = await h.first.startSession({ mode: 'sequential', count: 3, minutes: 10 });
    expect(next.questionIds).toEqual(['Q-2', 'Q-3']);
    expect((await h.first.restoreQuestionRecords(['Q-1'])).changedCount).toBe(1);
    expect(h.first.availableQuestions.map(question => question.id)).toEqual(['Q-1', 'Q-2', 'Q-3']);
    const restored = await h.disk();
    expect(restored.questionRecords['Q-1']).toEqual({ removed: false, revision: 2 });
    expect(restored.progress).toEqual(original.progress);
    expect(restored.textHistory).toEqual(original.textHistory);
    expect(hash(await h.bank())).toBe(originalBank);
  });

  it('学习记录删除恢复保持全部正文、原答案、题序、截止时间与学习内容', async () => {
    const h = await twoFileBackedClients();
    const original = await h.disk();
    const originalSession = original.sessions.find((session: StudySession) => session.id === h.sessionId);
    const removed = await h.first.removeSessionRecords([h.sessionId]);
    expect(removed.changedCount).toBe(1);
    expect(h.first.activeSession).toBeNull();
    expect(h.first.visibleSessions).toHaveLength(0);
    expect(h.first.removedSessions[0].id).toBe(h.sessionId);
    await h.second.bootstrap();
    expect(h.second.activeSession).toBeNull();
    expect(h.second.removedSessions[0].id).toBe(h.sessionId);
    const stillReadable = await h.request(`/sessions/${h.sessionId}`);
    expect(content(stillReadable)).toEqual(content(originalSession));
    expect(stillReadable).toMatchObject({ removed: true, revision: originalSession.revision + 1 });
    const restored = await h.first.restoreSessionRecords([h.sessionId]);
    expect(restored.changedCount).toBe(1);
    expect(h.first.removedSessions).toHaveLength(0);
    expect(content(h.first.visibleSessions[0])).toEqual(content(originalSession));
    const saved = await h.disk();
    expect(content(saved.sessions[0])).toEqual(content(originalSession));
    expect(saved.sessions[0]).toMatchObject({ removed: false, revision: originalSession.revision + 2 });
    expect(saved.progress).toEqual(original.progress);
    expect(saved.textHistory).toEqual(original.textHistory);
    h.first.resumeSession(h.first.visibleSessions[0]);
    expect(content(h.first.activeSession!)).toEqual(content(originalSession));
    expect(h.first.busy).toBe(false);
  });
});
