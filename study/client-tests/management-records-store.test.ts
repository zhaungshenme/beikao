import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { emptyProgress, useStudyStore } from '@/store/modules/study';
import * as api from '@/api/study';
import type { StudyBootstrap, StudySession } from '@/api/study/types';

vi.mock('@/api/study', () => ({
  loadStudy: vi.fn(), createStudySession: vi.fn(), updateStudySession: vi.fn(), getStudySession: vi.fn(),
  checkStudyQuestion: vi.fn(), finishStudySession: vi.fn(), updateQuestionProgress: vi.fn(),
  updateQuestionRecordsBatch: vi.fn(), updateSessionRecordsBatch: vi.fn(),
}));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const session = (changes: Partial<StudySession> = {}): StudySession => ({
  id: 'session-A', removed: false, revision: 0, mode: 'sequential', questionIds: ['Q-1', 'Q-2'],
  answers: {}, submittedQuestionIds: [], createdAt: '2026-10-21T00:00:00.000Z', deadlineAt: null,
  status: 'active', cursor: 0, ...changes,
});
function snapshot(changes: Partial<StudyBootstrap> = {}): StudyBootstrap {
  const active = session();
  return copy({
    questions: ['Q-1', 'Q-2'].map(id => ({
      id, category: '理论基础', chapter: '第一章', type: 'single' as const, difficulty: '基础' as const,
      stem: `练习题 ${id}`, options: [{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }],
      answer: ['A'], explanation: '题目解析', knowledgePoint: '知识点', source: '原创',
    })),
    progress: { 'Q-1': { ...emptyProgress(), attempts: 2, wrongCount: 2, favorite: true, note: '笔记', aiNote: '完整解析' } },
    sessions: [active], activeSession: active,
    ai: { configured: false, baseUrl: '', model: '', webUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh' }, ...changes,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function ready(initial = snapshot()) {
  vi.mocked(api.loadStudy).mockResolvedValue(copy(initial));
  const store = useStudyStore();
  await store.bootstrap();
  vi.mocked(api.loadStudy).mockClear();
  return store;
}
beforeEach(() => { vi.resetAllMocks(); setActivePinia(createPinia()); });

describe('管理记录的本地展示、删除恢复和版本边界', () => {
  it('旧快照默认元数据，删除题目只隐藏可用集合并保留学习本体，恢复重新出现', async () => {
    const old = snapshot();
    delete (old.sessions[0] as any).removed; delete (old.sessions[0] as any).revision;
    delete (old.activeSession as any).removed; delete (old.activeSession as any).revision;
    const store = await ready(old);
    expect(store.questionRecords['Q-1']).toEqual({ removed: false, revision: 0 });
    expect(store.sessions[0]).toMatchObject({ removed: false, revision: 0 });
    const before = copy({ progress: store.progress, sessions: store.sessions });
    vi.mocked(api.updateQuestionRecordsBatch)
      .mockResolvedValueOnce({ removed: true, changedCount: 1, questionRecords: { 'Q-1': { removed: true, revision: 1 } } })
      .mockResolvedValueOnce({ removed: false, changedCount: 1, questionRecords: { 'Q-1': { removed: false, revision: 2 } } });
    await store.removeQuestionRecords(['Q-1', 'Q-1']);
    expect(api.updateQuestionRecordsBatch).toHaveBeenCalledWith({ removed: true, items: [{ questionId: 'Q-1', expected: { removed: false, revision: 0 } }] });
    expect(store.availableQuestions.map(q => q.id)).toEqual(['Q-2']);
    expect(store.removedQuestions.map(q => q.id)).toEqual(['Q-1']);
    expect(store.questions).toHaveLength(2); expect(store.questionMap['Q-1']).toBeDefined();
    expect(store.wrongQuestions).toHaveLength(0); expect(store.favoriteQuestions).toHaveLength(0);
    expect({ progress: store.progress, sessions: store.sessions }).toEqual(before);
    await store.restoreQuestionRecords(['Q-1']);
    expect(store.availableQuestions).toHaveLength(2);
    expect(store.wrongQuestions.map(q => q.id)).toEqual(['Q-1']);
    expect(store.favoriteQuestions.map(q => q.id)).toEqual(['Q-1']);
    expect(store.categories).toEqual(['理论基础']);
  });

  it('删除和恢复学习记录只合并metadata，清除选中项，旧引用不能复活已删除记录', async () => {
    const initial = session({ answers: { 'Q-1': ['B'] }, revision: 3 });
    const store = await ready(snapshot({ sessions: [initial], activeSession: initial }));
    const oldReference = store.sessions[0];
    store.viewHistory(oldReference);
    vi.mocked(api.updateSessionRecordsBatch)
      .mockResolvedValueOnce({ removed: true, changedCount: 1, sessions: [session({ removed: true, revision: 4, answers: {} })] })
      .mockResolvedValueOnce({ removed: false, changedCount: 1, sessions: [session({ revision: 5, answers: {} })] });
    await store.removeSessionRecords(['session-A']);
    expect(store.activeSession).toBeNull(); expect(store.viewedSession).toBeNull();
    expect(store.visibleSessions).toHaveLength(0); expect(store.removedSessions).toHaveLength(1);
    expect(store.sessions[0].answers).toEqual({ 'Q-1': ['B'] });
    expect(() => store.resumeSession(oldReference)).toThrow('已移除');
    expect(() => store.viewHistory(oldReference)).toThrow('已移除');
    await store.restoreSessionRecords(['session-A']);
    expect(store.visibleSessions[0]).toMatchObject({ removed: false, revision: 5, answers: { 'Q-1': ['B'] } });
    expect(store.progress['Q-1']).toMatchObject({ note: '笔记', aiNote: '完整解析' });
  });

  it('空选择不发请求，未知ID和超过500项在发送前拒绝', async () => {
    const store = await ready();
    expect((await store.removeQuestionRecords([])).changedCount).toBe(0);
    expect((await store.restoreSessionRecords([])).changedCount).toBe(0);
    await expect(store.removeQuestionRecords(['unknown'])).rejects.toThrow('不存在');
    await expect(store.removeSessionRecords(['unknown'])).rejects.toThrow('不存在');
    await expect(store.removeQuestionRecords(Array.from({ length: 501 }, (_, n) => `Q-${n}`))).rejects.toThrow('500');
    await expect(store.removeSessionRecords(Array.from({ length: 501 }, (_, n) => `S-${n}`))).rejects.toThrow('500');
    expect(api.updateQuestionRecordsBatch).not.toHaveBeenCalled(); expect(api.updateSessionRecordsBatch).not.toHaveBeenCalled();
  });

  it('删除基线在点击时捕获，等待已发答案保存后仍发旧revision，冲突只刷新不重试', async () => {
    const store = await ready();
    const held = deferred<StudySession>();
    vi.mocked(api.updateStudySession).mockReturnValueOnce(held.promise);
    const saving = store.persistAnswer('Q-1', ['B']);
    await settle();
    const updated = session({ answers: { 'Q-1': ['B'] }, revision: 1 });
    const failure = Object.assign(new Error('版本冲突'), { status: 409, code: 'WRITE_CONFLICT' });
    vi.mocked(api.updateSessionRecordsBatch).mockRejectedValueOnce(failure);
    vi.mocked(api.loadStudy).mockResolvedValueOnce(snapshot({ sessions: [updated], activeSession: updated }));
    const removing = store.removeSessionRecords(['session-A']).catch(e => e);
    await settle(); expect(api.updateSessionRecordsBatch).not.toHaveBeenCalled();
    held.resolve(updated); await saving;
    expect(await removing).toBe(failure);
    expect(api.updateSessionRecordsBatch).toHaveBeenCalledExactlyOnceWith({ removed: true, items: [{ sessionId: 'session-A', expected: { removed: false, revision: 0 } }] });
    expect(store.sessions[0]).toMatchObject({ revision: 1, removed: false, answers: { 'Q-1': ['B'] } });
    expect(store.busy).toBe(false);
  });

  it('新完整响应更新真实正文和revision，后到的旧完整快照不能拼接新revision与旧答案', async () => {
    const store = await ready();
    vi.mocked(api.updateStudySession).mockResolvedValueOnce(session({ revision: 2, answers: { 'Q-1': ['B'], 'Q-2': ['A'] } }));
    await store.persistAnswer('Q-1', ['B']);
    expect(store.sessions[0]).toMatchObject({ revision: 2, answers: { 'Q-1': ['B'], 'Q-2': ['A'] } });
    vi.mocked(api.loadStudy).mockResolvedValueOnce(snapshot({ sessions: [session({ revision: 1 })], activeSession: session({ revision: 1 }) }));
    await store.bootstrap();
    expect(store.activeSession).toMatchObject({ revision: 2, answers: { 'Q-1': ['B'], 'Q-2': ['A'] } });
    expect(store.sessions[0]).toMatchObject({ revision: 2, answers: { 'Q-1': ['B'], 'Q-2': ['A'] } });
  });

  it('早期答案响应保留后续乐观答案和游标，最终完整版本一致', async () => {
    const store = await ready();
    const held = deferred<StudySession>();
    vi.mocked(api.updateStudySession).mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce(session({ revision: 2, answers: { 'Q-1': ['A'] } }))
      .mockResolvedValueOnce(session({ revision: 3, answers: { 'Q-1': ['A'] }, cursor: 1 }));
    const first = store.persistAnswer('Q-1', ['B']);
    const second = store.persistAnswer('Q-1', ['A']);
    const navigation = store.navigate(1);
    held.resolve(session({ revision: 1, answers: { 'Q-1': ['B'] } }));
    await first;
    expect(store.activeSession).toMatchObject({ cursor: 1, answers: { 'Q-1': ['A'] } });
    await Promise.all([second, navigation]);
    expect(api.updateStudySession).toHaveBeenNthCalledWith(2, 'session-A', { questionId: 'Q-1', answer: ['A'], expectedAnswer: ['B'] });
    expect(store.sessions[0]).toMatchObject({ revision: 3, cursor: 1, answers: { 'Q-1': ['A'] } });
  });

  it('progress-only删除tombstone采用完整正文，随后旧快照不能恢复删除状态', async () => {
    const store = await ready();
    const removed = session({ removed: true, revision: 2, answers: { 'Q-2': ['B'] } });
    vi.mocked(api.loadStudy).mockResolvedValueOnce(snapshot({ sessions: [removed], activeSession: null })).mockResolvedValueOnce(snapshot());
    await store.refreshProgress(); await store.bootstrap();
    expect(store.sessions[0]).toMatchObject({ removed: true, revision: 2, answers: { 'Q-2': ['B'] } });
    expect(store.activeSession).toBeNull();
  });

  for (const action of ['answer', 'check', 'finish'] as const) {
    it(`SESSION_REMOVED ${action}失败清除选择且不伪造答案冲突，刷新失败仍阻止继续写`, async () => {
      const store = await ready();
      const current = session({ removed: true, revision: 1 });
      const failure = Object.assign(new Error('已移除'), { status: 409, code: 'SESSION_REMOVED', current });
      vi.mocked(api.loadStudy).mockRejectedValue(new Error('刷新中断'));
      const fn = action === 'answer' ? api.updateStudySession : action === 'check' ? api.checkStudyQuestion : api.finishStudySession;
      vi.mocked(fn).mockRejectedValueOnce(failure);
      const result = action === 'answer' ? store.persistAnswer('Q-1', ['B']) : action === 'check' ? store.checkCurrent() : store.finish();
      await expect(result).rejects.toBe(failure);
      expect(store.activeSession).toBeNull(); expect(store.viewedSession).toBeNull();
      expect(store.sessions[0]).toMatchObject({ removed: true, revision: 1 });
      expect(store.answerConflicts).toEqual({});
      await store.persistAnswer('Q-2', ['A']);
      expect(() => store.resumeSession(current)).toThrow('已移除');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  }

  it('QUESTION_REMOVED创建失败刷新题库后原样抛出，不自动重建练习', async () => {
    const store = await ready();
    const failure = Object.assign(new Error('题目已移除'), { status: 409, code: 'QUESTION_REMOVED' });
    vi.mocked(api.createStudySession).mockRejectedValueOnce(failure);
    vi.mocked(api.loadStudy).mockResolvedValueOnce(snapshot({ questionRecords: { 'Q-1': { removed: true, revision: 1 } } }));
    await expect(store.startSession({ mode: 'sequential', count: 1, minutes: 10, questionIds: ['Q-1'] })).rejects.toBe(failure);
    expect(api.createStudySession).toHaveBeenCalledTimes(1); expect(api.loadStudy).toHaveBeenCalledTimes(1);
    expect(store.availableQuestions.map(q => q.id)).toEqual(['Q-2']);
    expect(store.busy).toBe(false);
  });
});
