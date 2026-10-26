import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import * as api from '@/api/study';
import type { AiSettings, AnswerConflict, FinishResponse, ProgressChanges, ProgressExpected, QuestionAnswerChanges, QuestionAnswerResponse, QuestionProgress, QuestionRecordsBatchItem, QuestionRecordsBatchResponse, RecordMetadata, SessionOptions, SessionRecordsBatchItem, SessionRecordsBatchResponse, StudyQuestion, StudyRequestError, StudySession, WrongMasteryBatchItem, WrongMasteryBatchResponse, WrongRecordsBatchItem, WrongRecordsBatchResponse } from '@/api/study/types';

export const emptyProgress = (): QuestionProgress => ({ attempts: 0, correctCount: 0, wrongCount: 0, wrongRemoved: false, lastAnswer: [], lastCorrect: null, lastAnsweredAt: null, mastered: false, favorite: false, note: '', reason: '' });

/** 学习业务状态以本机服务为准；前端 Pinia 仅保留当前展示快照。 */
export const useStudyStore = defineStore('personal-study', () => {
  const questions = ref<StudyQuestion[]>([]);
  const questionRecords = ref<Record<string, RecordMetadata>>({});
  const progress = ref<Record<string, QuestionProgress>>({});
  const sessions = ref<StudySession[]>([]);
  const activeSession = ref<StudySession | null>(null);
  const viewedSession = ref<StudySession | null>(null);
  const lastResults = ref<FinishResponse['results']>([]);
  const webUrl = 'https://chatglm.cn/main/alltoolsdetail?lang=zh';
  const ai = ref<AiSettings>({ configured: false, baseUrl: '', model: '', webUrl, webProvider: 'zhipu', retrievalEnabled: false, retrievalAvailable: false });
  const loading = ref(false);
  const busy = ref(false);
  const error = ref('');
  const loaded = ref(false);
  const saveState = ref<'saved' | 'saving' | 'error'>('saved');
  const answerConflicts = ref<Record<string, Record<string, AnswerConflict>>>({});
  const hasAnswerConflicts = computed(() => !!Object.keys(answerConflicts.value[currentSession.value?.id || ''] || {}).length);
  const questionMap = computed(() => Object.fromEntries(questions.value.map(q => [q.id, q])));
  // Answer revisions are independent of read arrival order. An older bootstrap or
  // delayed correction response must never reinstall a superseded grading key.
  function mergeQuestionAnswer(incoming: StudyQuestion) {
    const index = questions.value.findIndex(question => question.id === incoming.id);
    const current = questions.value[index];
    if (current && (current.answerRevision ?? 0) > (incoming.answerRevision ?? 0)) return current;
    if (current && (current.answerRevision ?? 0) < (incoming.answerRevision ?? 0)) freezeVisibleGrades(current);
    const next = { ...incoming, answer: [...incoming.answer], answerRevision: incoming.answerRevision ?? 0 };
    if (index < 0) questions.value.push(next); else questions.value[index] = next;
    return next;
  }
  function freezeVisibleGrades(question: StudyQuestion) {
    // A conflict can carry a newer key while a subsequent network read fails.
    // Preserve the already visible historical criteria before installing that key.
    // This display snapshot stays in memory; the backend owns durable grading.
    for (const session of [...serverSessions.values(), ...sessions.value, activeSession.value, viewedSession.value]) {
      if (!session || !session.questionIds.includes(question.id) || (session.status !== 'completed' && !session.submittedQuestionIds.includes(question.id)) || session.gradedResults?.[question.id]) continue;
      const userAnswer = [...(session.answers[question.id] || [])];
      session.gradedResults = { ...session.gradedResults, [question.id]: {
        questionId: question.id, correct: sameAnswer(question.answer, userAnswer), answer: [...question.answer],
        userAnswer, explanation: question.explanation, questionRevision: question.answerRevision ?? 0,
      } };
    }
  }
  function mergeQuestionUpdateFailure(failure: StudyRequestError) {
    const current: any = failure.current;
    const updated = Array.isArray(current?.questions) ? current.questions : current?.id ? [current] : current?.question ? [current.question] : [];
    for (const question of updated) if (typeof question.id === 'string' && Array.isArray(question.options) && Array.isArray(question.answer)) mergeQuestionAnswer(question);
  }
  const availableQuestions = computed(() => questions.value.filter(q => !questionRecords.value[q.id]?.removed));
  const removedQuestions = computed(() => questions.value.filter(q => questionRecords.value[q.id]?.removed));
  const visibleSessions = computed(() => sessions.value.filter(session => !session.removed));
  const removedSessions = computed(() => sessions.value.filter(session => session.removed));
  const categories = computed(() => [...new Set(questions.value.map(q => q.category))]);
  const currentSession = computed(() => viewedSession.value && !viewedSession.value.removed ? viewedSession.value : activeSession.value && !activeSession.value.removed ? activeSession.value : null);
  const currentQuestion = computed(() => {
    const s = currentSession.value;
    return s ? questionMap.value[s.questionIds[s.cursor || 0]] : undefined;
  });
  const answeredCount = computed(() => Object.values(progress.value).filter(p => p.attempts > 0).length);
  const wrongQuestions = computed(() => availableQuestions.value.filter(q => (progress.value[q.id]?.wrongCount || 0) > 0 && !progress.value[q.id]?.wrongRemoved));
  const removedWrongQuestions = computed(() => availableQuestions.value.filter(q => (progress.value[q.id]?.wrongCount || 0) > 0 && progress.value[q.id]?.wrongRemoved));
  const favoriteQuestions = computed(() => availableQuestions.value.filter(q => progress.value[q.id]?.favorite));
  const accuracy = computed(() => {
    const values = Object.values(progress.value);
    const attempts = values.reduce((n, p) => n + (p.attempts || 0), 0);
    return attempts ? Math.round(values.reduce((n, p) => n + (p.correctCount || 0), 0) / attempts * 100) : 0;
  });
  const confirmedAnswers = new Map<string, Record<string, string[]>>();
  const knownSessionMetadata = new Map<string, RecordMetadata>();
  // Keep server bodies separate from optimistic answers: a revision always belongs
  // to the complete server version that supplied it, never an older visible body.
  const serverSessions = new Map<string, StudySession>();
  const normalizeMetadata = (record?: Partial<RecordMetadata>): RecordMetadata => ({ removed: record?.removed ?? false, revision: record?.revision ?? 0 });
  const normalizeSession = (session: StudySession): StudySession => ({ ...session, ...normalizeMetadata(session) });
  function applySessionMetadata(session: StudySession): RecordMetadata {
    const incoming = normalizeMetadata(session);
    const current = knownSessionMetadata.get(session.id);
    const metadata = current && current.revision > incoming.revision ? current : incoming;
    knownSessionMetadata.set(session.id, { ...metadata });
    const body = serverSessions.get(session.id);
    if (body && metadata.revision >= body.revision) serverSessions.set(session.id, { ...body, ...metadata });
    for (const target of [sessions.value.find(item => item.id === session.id), activeSession.value, viewedSession.value]) {
      if (target?.id === session.id) Object.assign(target, metadata);
    }
    if (metadata.removed) {
      if (activeSession.value?.id === session.id) activeSession.value = null;
      if (viewedSession.value?.id === session.id) viewedSession.value = null;
    }
    return metadata;
  }
  function sessionRemovedError(sessionId: string): StudyRequestError {
    return Object.assign(new Error('这条学习记录已移除，请先恢复记录后再继续。'), { status: 409, code: 'SESSION_REMOVED', current: sessions.value.find(session => session.id === sessionId) });
  }
  function requireSessionAvailable(sessionId: string) {
    if (knownSessionMetadata.get(sessionId)?.removed || sessions.value.find(session => session.id === sessionId)?.removed) throw sessionRemovedError(sessionId);
  }
  function rememberRemovedFailure(sessionId: string, failure: StudyRequestError) {
    if (failure.code !== 'SESSION_REMOVED') return;
    const current: any = failure.current;
    const remote = current?.id === sessionId ? current : current?.session || current?.[sessionId];
    const local = sessions.value.find(session => session.id === sessionId);
    if (remote?.id === sessionId) upsertSession({ ...remote, removed: true });
    else if (local) applySessionMetadata({ ...local, removed: true });
  }
  const answerDrafts = new Map<string, Map<string, { answer: string[]; sequence: number }>>();
  const cursorDrafts = new Map<string, { cursor: number; sequence: number }>();
  let answerSequence = 0;
  const copyAnswers = (answers: Record<string, string[]>) => Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, [...answer]]));
  const sameAnswer = (a: string[] = [], b: string[] = []) => [...new Set(a)].sort().join('\0') === [...new Set(b)].sort().join('\0');
  function serverBaseline(session: StudySession) {
    if (!confirmedAnswers.has(session.id)) confirmedAnswers.set(session.id, copyAnswers(session.answers));
    return confirmedAnswers.get(session.id)!;
  }
  function rememberServerSession(remote: StudySession) {
    const baseline = confirmedAnswers.get(remote.id) || {};
    for (const id of new Set([...Object.keys(baseline), ...Object.keys(remote.answers)])) {
      // An external refresh is never consent to rebase an unsaved choice or a conflict.
      if (answerDrafts.get(remote.id)?.has(id) || answerConflicts.value[remote.id]?.[id]) continue;
      if (remote.answers[id] !== undefined) baseline[id] = [...remote.answers[id]];
      else delete baseline[id];
    }
    confirmedAnswers.set(remote.id, baseline);
  }
  function mergeServerSession(remote: StudySession) {
    remote = normalizeSession(remote);
    const known = serverSessions.get(remote.id);
    if (known && (known.revision > remote.revision || (known.revision === remote.revision && known.removed && !remote.removed))) remote = known;
    else {
      const gradedResults = { ...remote.gradedResults };
      for (const [id, result] of Object.entries(known?.gradedResults || {})) {
        if (!gradedResults[id] && (remote.status === 'completed' || remote.submittedQuestionIds.includes(id)) && sameAnswer(result.userAnswer, remote.answers[id] || [])) gradedResults[id] = result;
      }
      remote = { ...remote, ...(Object.keys(gradedResults).length ? { gradedResults } : {}), answers: copyAnswers(remote.answers), submittedQuestionIds: [...remote.submittedQuestionIds] };
      serverSessions.set(remote.id, remote);
      knownSessionMetadata.set(remote.id, normalizeMetadata(remote));
    }
    rememberServerSession(remote);
    const merged = { ...remote, answers: copyAnswers(remote.answers) };
    for (const [id, conflict] of Object.entries(answerConflicts.value[remote.id] || {})) merged.answers[id] = [...conflict.localAnswer];
    for (const [id, draft] of answerDrafts.get(remote.id) || []) merged.answers[id] = [...draft.answer];
    if (cursorDrafts.has(remote.id)) merged.cursor = cursorDrafts.get(remote.id)!.cursor;
    return merged;
  }
  function conflictError(sessionId: string, questionId?: string): StudyRequestError {
    const conflict = questionId ? answerConflicts.value[sessionId]?.[questionId] : Object.values(answerConflicts.value[sessionId] || {})[0];
    return Object.assign(new Error(conflict?.message || '其他标签页修改了答案，请先重新载入服务端版本后再判分或交卷。'), { status: 409, code: conflict?.code || 'ANSWER_CONFLICT' });
  }
  function recordAnswerConflict(sessionId: string, questionId: string, failure: StudyRequestError) {
    const current: any = failure.current;
    const session = activeSession.value?.id === sessionId ? activeSession.value : sessions.value.find(item => item.id === sessionId);
    const localAnswer = answerDrafts.get(sessionId)?.get(questionId)?.answer || session?.answers[questionId] || [];
    const serverAnswer = Array.isArray(current) ? current : current?.answer || current?.answers?.[questionId] || current?.session?.answers?.[questionId];
    answerConflicts.value[sessionId] ||= {};
    answerConflicts.value[sessionId][questionId] = {
      questionId, localAnswer: [...localAnswer], serverAnswer: Array.isArray(serverAnswer) ? [...serverAnswer] : answerConflicts.value[sessionId]?.[questionId]?.serverAnswer,
      message: '其他标签页修改了答案，本地选择已保留；请重新载入服务端版本后再继续。', code: failure.code,
    };
  }
  function recordSessionConflict(session: StudySession, failure: StudyRequestError) {
    const current: any = failure.current;
    const remote = current?.answers || current?.session?.answers;
    const baseline = serverBaseline(session);
    const changed = session.questionIds.filter(id => !remote || !sameAnswer(baseline[id], remote[id]) || (id in baseline) !== (id in remote));
    for (const id of changed.length ? changed : session.questionIds) recordAnswerConflict(session.id, id, failure);
  }

  // A network response is a snapshot, not a newer version merely because it arrived last.
  // Reads wait for local saves and retry if a save began while the snapshot was travelling.
  let snapshotSequence = 0;
  let progressSnapshotSequence = 0;
  let questionsSnapshotSequence = 0;
  let sessionsSnapshotSequence = 0;
  let questionRecordsSnapshotSequence = 0;
  let sessionMetadataSnapshotSequence = 0;
  let bootstrapSnapshotSequence = 0;
  let bootstrapSequence = 0;
  let mutationVersion = 0;
  let selectionVersion = 0;
  const pendingMutations = new Set<Promise<void>>();
  function beginMutation() {
    mutationVersion++;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    pendingMutations.add(pending);
    return () => {
      mutationVersion++;
      pendingMutations.delete(pending);
      release();
    };
  }
  async function waitForMutations() {
    while (pendingMutations.size) await Promise.all([...pendingMutations]);
  }
  async function readSnapshot(options: { sessions?: boolean; bootstrap?: boolean } = {}) {
    for (;;) {
      await waitForMutations();
      const sequence = ++snapshotSequence;
      const version = mutationVersion;
      const selection = selectionVersion;
      const data = await api.loadStudy();
      const needsProgress = sequence > progressSnapshotSequence;
      const needsQuestions = sequence > questionsSnapshotSequence;
      // A refreshed grading key and its frozen historical results form one view.
      // Bringing only the new key into an old session would mislabel old answers.
      const answersAdvanced = data.questions.some(question => (question.answerRevision ?? 0) > (questionMap.value[question.id]?.answerRevision ?? 0));
      const needsSessions = (!!options.sessions || answersAdvanced) && sequence > sessionsSnapshotSequence;
      const needsQuestionRecords = sequence > questionRecordsSnapshotSequence;
      const needsSessionMetadata = sequence > sessionMetadataSnapshotSequence;
      const needsBootstrap = !!options.bootstrap && sequence > bootstrapSnapshotSequence;
      // A later read has already supplied every requested part. Never let this older one undo it.
      if (!needsProgress && !needsQuestions && !needsSessions && !needsQuestionRecords && !needsSessionMetadata && !needsBootstrap) return;
      if (version !== mutationVersion || pendingMutations.size) continue;
      if (needsProgress) { progress.value = Object.fromEntries(Object.entries(data.progress || {}).map(([id, value]) => [id, { ...value, wrongRemoved: value.wrongRemoved ?? false }])); progressSnapshotSequence = sequence; }
      if (needsQuestionRecords) {
        questionRecords.value = Object.fromEntries(data.questions.map(question => {
          const incoming = normalizeMetadata(data.questionRecords?.[question.id]);
          const current = questionRecords.value[question.id];
          return [question.id, current && current.revision > incoming.revision ? current : incoming];
        }));
        questionRecordsSnapshotSequence = sequence;
      }
      if (needsSessionMetadata) {
        // A progress refresh must not grant a new deletion baseline while still
        // displaying old answers. Only complete deletion tombstones propagate.
        if (!needsSessions) for (const remote of data.sessions || []) if (remote.removed) upsertSession(remote);
        sessionMetadataSnapshotSequence = sequence;
      }
      if (needsSessions) {
        sessions.value = (data.sessions || []).map(mergeServerSession);
        for (const session of sessions.value) syncSelectedSession(session);
        sessionsSnapshotSequence = sequence;
      }
      if (needsQuestions) {
        const known = questionMap.value;
        questions.value = data.questions.map(question => {
          const current = known[question.id];
          return current && (current.answerRevision ?? 0) > (question.answerRevision ?? 0) ? current : { ...question, answerRevision: question.answerRevision ?? 0 };
        });
        questionsSnapshotSequence = sequence;
      }
      if (needsBootstrap) {
        // The web bridge has a single destination; old snapshots cannot select a different route.
        const provider = data.ai?.webProvider === 'deepseek' ? 'deepseek' : 'zhipu';
        ai.value = { ...ai.value, ...data.ai, webProvider: provider,
          retrievalAvailable: data.ai?.retrievalAvailable === true,
          retrievalEnabled: data.ai?.retrievalAvailable === true && data.ai?.retrievalEnabled === true,
          webUrl: provider === 'deepseek' ? 'https://chat.deepseek.com/' : webUrl };
        // A newer session snapshot must not be replaced by an older bootstrap response.
        if (sequence >= sessionsSnapshotSequence && selection === selectionVersion) {
          const active = data.activeSession ? mergeServerSession(data.activeSession) : null;
          activeSession.value = active && !active.removed ? active : null;
        }
        bootstrapSnapshotSequence = sequence;
      }
      return;
    }
  }
  // Mutations of question progress are sent in order, including repeated note/favorite saves.
  let progressWriteQueue: Promise<void> = Promise.resolve();
  function queueProgressMutation<T>(action: () => Promise<T>) {
    const endMutation = beginMutation();
    const operation = progressWriteQueue.then(action).finally(endMutation);
    progressWriteQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  let busyCount = 0;
  function beginBusy() {
    busyCount++;
    busy.value = true;
    return () => { busyCount--; busy.value = busyCount > 0; };
  }

  function syncSelectedSession(session: StudySession) {
    if (activeSession.value?.id === session.id) {
      if (session.removed) activeSession.value = null;
      else if (session.status === 'completed') {
        activeSession.value = null;
        if (!viewedSession.value || viewedSession.value.id === session.id) viewedSession.value = session;
      } else activeSession.value = session;
    }
    if (viewedSession.value?.id === session.id) viewedSession.value = session.removed ? null : { ...session, cursor: viewedSession.value.cursor };
  }
  function upsertSession(remote: StudySession) {
    const session = mergeServerSession(remote);
    const index = sessions.value.findIndex(s => s.id === session.id);
    if (index < 0) sessions.value.unshift(session); else sessions.value[index] = session;
    syncSelectedSession(session);
    return session;
  }

  async function bootstrap() {
    const sequence = ++bootstrapSequence;
    loading.value = true;
    error.value = '';
    try {
      await readSnapshot({ sessions: true, bootstrap: true });
      loaded.value = true;
    } catch (e: any) { if (sequence === bootstrapSequence) error.value = e.message; throw e; }
    finally { if (sequence === bootstrapSequence) loading.value = false; }
  }

  async function startSession(options: SessionOptions) {
    const selection = ++selectionVersion;
    const endBusy = beginBusy();
    try {
      await writeQueue;
      await progressWriteQueue;
      const endMutation = beginMutation();
      try {
        const session = upsertSession(await api.createStudySession(options));
        if (selection === selectionVersion) {
          viewedSession.value = null;
          lastResults.value = [];
          activeSession.value = session.removed ? null : session;
        }
        return session;
      } finally { endMutation(); }
    } catch (failure: any) {
      if (failure.code === 'QUESTION_REMOVED') { try { await readSnapshot({ sessions: true, bootstrap: true }); } catch { /* Preserve the creation error. */ } }
      throw failure;
    } finally { endBusy(); }
  }

  // 答案与游标共用顺序队列。队列继续工作，但失败记录必须由该字段重试成功后清除。
  let writeQueue: Promise<void> = Promise.resolve();
  const pendingWrites = ref(0);
  const writeFailures = new Map<string, Error>();
  function updateSaveState() {
    saveState.value = writeFailures.size ? 'error' : pendingWrites.value ? 'saving' : 'saved';
  }
  async function syncConflict(sessionId: string) {
    await readSnapshot({ sessions: true });
    const removed = sessions.value.find(s => s.id === sessionId && s.removed);
    if (removed) {
      for (const key of writeFailures.keys()) if (key.startsWith(`${sessionId}:`)) writeFailures.delete(key);
      updateSaveState();
      return;
    }
    const completed = sessions.value.find(s => s.id === sessionId && s.status === 'completed');
    if (completed) {
      for (const key of writeFailures.keys()) if (key.startsWith(`${sessionId}:`)) writeFailures.delete(key);
      if (activeSession.value?.id === sessionId) {
        activeSession.value = null;
        viewedSession.value = completed;
      } else if (viewedSession.value?.id === sessionId) viewedSession.value = completed;
    }
    updateSaveState();
  }
  function queueWrite(sessionId: string, field: string, data: { questionId?: string; answer?: string[]; cursor?: number }, draftSequence?: number) {
    const key = `${sessionId}:${field}`;
    const endMutation = beginMutation();
    pendingWrites.value += 1;
    updateSaveState();
    const operation = writeQueue.then(async () => {
      try {
        requireSessionAvailable(sessionId);
        if (data.questionId && answerConflicts.value[sessionId]?.[data.questionId]) throw conflictError(sessionId, data.questionId);
        const expectedAnswer = data.questionId ? [...(confirmedAnswers.get(sessionId)?.[data.questionId] || [])] : undefined;
        const saved = normalizeSession(await api.updateStudySession(sessionId, { ...data, ...(data.questionId ? { expectedAnswer } : {}) }));
        if (data.questionId) {
          const baseline = confirmedAnswers.get(sessionId) || {};
          baseline[data.questionId] = [...(saved.answers[data.questionId] || data.answer || [])];
          confirmedAnswers.set(sessionId, baseline);
          if (answerDrafts.get(sessionId)?.get(data.questionId)?.sequence === draftSequence) answerDrafts.get(sessionId)!.delete(data.questionId);
        }
        if (data.cursor !== undefined && cursorDrafts.get(sessionId)?.sequence === draftSequence) cursorDrafts.delete(sessionId);
        writeFailures.delete(key);
        // Merge only actual pending drafts over this complete confirmed version.
        upsertSession(saved);
      } catch (e: any) {
        if (e.code === 'SESSION_REMOVED') rememberRemovedFailure(sessionId, e);
        else if (e.status === 409 && data.questionId) recordAnswerConflict(sessionId, data.questionId, e);
        writeFailures.set(key, e);
        error.value = e.message;
        throw e;
      } finally {
        endMutation();
        pendingWrites.value -= 1;
        updateSaveState();
      }
    });
    writeQueue = operation.catch(() => undefined);
    // Conflict reads run after releasing this queue item, so later queued saves can finish first.
    return operation.catch(async (e: any) => {
      if (e.status === 409) {
        try { await syncConflict(sessionId); } catch { /* 保留原始写入错误，稍后可手动重新加载。 */ }
      }
      throw e;
    });
  }
  async function flushAnswers(sessionId: string) {
    await writeQueue;
    requireSessionAvailable(sessionId);
    if (Object.keys(answerConflicts.value[sessionId] || {}).length) throw conflictError(sessionId);
    if ([...writeFailures.keys()].some(key => key.startsWith(`${sessionId}:answer:`))) {
      throw new Error('有答案尚未保存成功，请重新选择该题答案后再提交。');
    }
    if (sessions.value.find(s => s.id === sessionId)?.status === 'completed') {
      throw new Error('本轮考试已结束，已同步为成绩与解析页面。');
    }
  }
  function persistAnswer(questionId: string, answer: string[]) {
    const session = activeSession.value;
    if (!session || session.status !== 'active') return Promise.resolve();
    try { requireSessionAvailable(session.id); } catch (failure) { return Promise.reject(failure); }
    if (session.submittedQuestionIds.includes(questionId)) return Promise.reject(new Error('该题已判分，不能修改答案。'));
    serverBaseline(session);
    const selected = [...answer];
    const sequence = ++answerSequence;
    if (!answerDrafts.has(session.id)) answerDrafts.set(session.id, new Map());
    answerDrafts.get(session.id)!.set(questionId, { answer: selected, sequence });
    session.answers[questionId] = selected;
    if (answerConflicts.value[session.id]?.[questionId]) {
      answerConflicts.value[session.id][questionId].localAnswer = [...selected];
      return Promise.reject(conflictError(session.id, questionId));
    }
    return queueWrite(session.id, `answer:${questionId}`, { questionId, answer: selected }, sequence);
  }

  async function navigate(index: number) {
    const session = currentSession.value;
    if (!session) return;
    session.cursor = Math.max(0, Math.min(index, session.questionIds.length - 1));
    if (session.status === 'active' && !viewedSession.value) {
      const sequence = ++answerSequence;
      cursorDrafts.set(session.id, { cursor: session.cursor, sequence });
      await queueWrite(session.id, 'cursor', { cursor: session.cursor }, sequence);
    }
  }

  async function checkCurrent() {
    const session = activeSession.value;
    const question = currentQuestion.value;
    if (!session || !question || session.mode === 'exam') return;
    const endBusy = beginBusy();
    try {
      await flushAnswers(session.id);
      return await queueProgressMutation(async () => {
        const args: [string, string, string[], string[]] = [session.id, question.id, session.answers[question.id] || [], [...(serverBaseline(session)[question.id] || [])]];
        const data = (question.answerRevision ?? 0) > 0
          ? await api.checkStudyQuestion(...args, question.answerRevision)
          : await api.checkStudyQuestion(...args);
        data.session = upsertSession(data.session);
        const currentProgress = progress.value[question.id] || data.progress;
        // Grading changes these fields only; a delayed full record must not erase an AI note.
        progress.value[question.id] = {
          ...currentProgress, attempts: data.progress.attempts, correctCount: data.progress.correctCount,
          wrongCount: data.progress.wrongCount, lastAnswer: data.progress.lastAnswer,
          wrongRemoved: data.progress.wrongRemoved ?? false,
          lastCorrect: data.progress.lastCorrect, lastAnsweredAt: data.progress.lastAnsweredAt,
          mastered: data.correct ? currentProgress.mastered : false,
        };
        return data;
      });
    } catch (e: any) {
      if (e.status === 409) {
        if (e.code === 'QUESTION_UPDATED') mergeQuestionUpdateFailure(e);
        else if (e.code === 'SESSION_REMOVED') rememberRemovedFailure(session.id, e);
        else if (!Object.keys(answerConflicts.value[session.id] || {}).length) recordAnswerConflict(session.id, question.id, e);
        try { await syncConflict(session.id); } catch { /* 保留原始错误。 */ }
      }
      throw e;
    } finally { endBusy(); }
  }

  async function finish() {
    const session = activeSession.value;
    if (!session) return;
    const selection = selectionVersion;
    const expectedQuestionRevisions = Object.fromEntries(session.questionIds.map(id => [id, questionMap.value[id]?.answerRevision ?? 0]));
    const endBusy = beginBusy();
    try {
      await flushAnswers(session.id);
      const data = await queueProgressMutation(async () => {
        const baseline = copyAnswers(serverBaseline(session));
        const completed = Object.values(expectedQuestionRevisions).some(revision => revision > 0)
          ? await api.finishStudySession(session.id, baseline, expectedQuestionRevisions)
          : await api.finishStudySession(session.id, baseline);
        completed.session = upsertSession(completed.session);
        lastResults.value = completed.results;
        if (activeSession.value?.id === session.id) activeSession.value = null;
        if (selection === selectionVersion && !completed.session.removed) viewedSession.value = completed.session;
        return completed;
      });
      try {
        await readSnapshot({ sessions: true });
      } catch (e: any) { error.value = `交卷已保存，但最新学习统计未刷新：${e.message}`; }
      return data;
    } catch (e: any) {
      if (e.status === 409) {
        if (e.code === 'QUESTION_UPDATED') mergeQuestionUpdateFailure(e);
        else if (e.code === 'SESSION_REMOVED') rememberRemovedFailure(session.id, e);
        else if (!Object.keys(answerConflicts.value[session.id] || {}).length) recordSessionConflict(session, e);
        try { await syncConflict(session.id); } catch { /* 保留原始错误。 */ }
      }
      throw e;
    } finally { endBusy(); }
  }

  async function patchProgress(id: string, data: ProgressChanges, expected?: ProgressExpected) {
    const current = progress.value[id] || emptyProgress();
    const baseline: ProgressExpected = {};
    const changes: ProgressChanges = {};
    for (const key of ['favorite', 'mastered', 'note', 'reason'] as const) {
      if (data[key] === undefined) continue;
      if (expected && expected[key] === undefined) throw new Error('缺少该字段原始版本，无法安全保存；请重新载入后再编辑。');
      const oldValue = expected ? expected[key] : current[key];
      if (data[key] !== oldValue) {
        Object.assign(changes, { [key]: data[key] });
        Object.assign(baseline, { [key]: oldValue });
      }
    }
    if (!Object.keys(changes).length) return current;
    return queueProgressMutation(async () => {
      const updated = await api.updateQuestionProgress(id, { ...changes, expected: baseline });
      const current = { ...(progress.value[id] || updated) };
      for (const key of ['favorite', 'mastered', 'note', 'reason'] as const) {
        if (changes[key] !== undefined) Object.assign(current, { [key]: updated[key] });
      }
      progress.value[id] = current;
      return updated;
    });
  }

  async function syncQuestionAnswer(id: string) {
    const data = await api.loadQuestionAnswerHistory(id);
    for (const session of data.sessions || []) upsertSession(session);
    const question = mergeQuestionAnswer(data.question);
    await readSnapshot({ sessions: true });
    return { ...data, question: questionMap.value[id] || question };
  }
  async function mutateQuestionAnswer(id: string, action: () => Promise<QuestionAnswerResponse>) {
    const endBusy = beginBusy();
    try {
      const result = await queueProgressMutation(async () => {
        const saved = await action();
        for (const session of saved.sessions || []) upsertSession(session);
        mergeQuestionAnswer(saved.question);
        return saved;
      });
      // The backend freezes affected past grades in the same transaction. Read
      // those sessions after releasing our mutation; pending user drafts survive.
      try { await readSnapshot({ sessions: true }); }
      catch (failure: any) { error.value = `标准答案已保存，但学习记录尚未刷新：${failure.message}`; }
      return result.question;
    } catch (failure: any) {
      if (failure.status === 409) {
        mergeQuestionUpdateFailure(failure);
        try { await readSnapshot({ sessions: true }); } catch { /* Preserve the correction conflict and caller's edit draft. */ }
      }
      throw failure;
    } finally { endBusy(); }
  }
  const correctQuestionAnswer = (id: string, data: QuestionAnswerChanges) => mutateQuestionAnswer(id, () => api.saveQuestionAnswer(id, data));
  const restoreQuestionAnswerVersion = (id: string, historyId: string, expectedRevision: number) => mutateQuestionAnswer(id, () => api.restoreQuestionAnswer(id, { historyId, expectedRevision }));

  async function changeWrongRecords(ids: string[], removed: boolean): Promise<WrongRecordsBatchResponse> {
    const selected = [...new Set(ids)];
    if (!selected.length) return { progress: {}, changedCount: 0 };
    const items: WrongRecordsBatchItem[] = selected.map(questionId => {
      const current = progress.value[questionId];
      if (!questionMap.value[questionId] || !current || current.wrongCount <= 0) throw new Error('所选题目包含未知题目或尚无错题记录，请刷新后再操作。');
      return { questionId, expected: { wrongRemoved: current.wrongRemoved ?? false, wrongCount: current.wrongCount, lastAnsweredAt: current.lastAnsweredAt ?? null } };
    });
    const endBusy = beginBusy();
    try {
      return await queueProgressMutation(async () => {
        const result = await api.updateWrongRecordsBatch({ removed, items });
        for (const { questionId } of items) {
          const updated = result.progress[questionId];
          if (updated) progress.value[questionId] = { ...(progress.value[questionId] || emptyProgress()), wrongRemoved: updated.wrongRemoved ?? false };
        }
        return result;
      });
    } catch (failure: any) {
      // Release this mutation before reading; a conflict must not wait for its own queue item.
      if (failure.status === 409) { try { await readSnapshot(); } catch { /* Preserve the original write conflict. */ } }
      throw failure;
    } finally { endBusy(); }
  }
  const removeWrongRecords = (ids: string[]) => changeWrongRecords(ids, true);
  const restoreWrongRecords = (ids: string[]) => changeWrongRecords(ids, false);

  async function changeWrongMastery(ids: string[], mastered: boolean): Promise<WrongMasteryBatchResponse> {
    const selected = [...new Set(ids)];
    if (!selected.length) return { progress: {}, changedCount: 0 };
    if (selected.length > 500) throw new Error('一次最多选择500道错题。');
    // Capture exactly the learning result visible at the click. Waiting in the
    // write queue is not permission to rebase this command onto a newer mistake.
    const items: WrongMasteryBatchItem[] = selected.map(questionId => {
      const current = progress.value[questionId];
      if (!questionMap.value[questionId] || questionRecords.value[questionId]?.removed || !current || current.wrongCount <= 0 || current.wrongRemoved) throw new Error('所选错题已移除或不存在，请刷新后再操作。');
      return { questionId, expected: { mastered: current.mastered ?? false, wrongRemoved: current.wrongRemoved ?? false, wrongCount: current.wrongCount, lastAnsweredAt: current.lastAnsweredAt ?? null } };
    });
    const endBusy = beginBusy();
    try {
      return await queueProgressMutation(async () => {
        const result = await api.updateWrongMasteryBatch({ mastered, items });
        for (const { questionId, expected } of items) {
          const updated = result.progress[questionId];
          const current = progress.value[questionId];
          if (!updated || !current) continue;
          // A late mastery response owns only this flag and only the learning
          // result it changed. A newer grading/removal/marking result wins.
          if ((current.mastered ?? false) !== expected.mastered || (current.wrongRemoved ?? false) !== expected.wrongRemoved || current.wrongCount !== expected.wrongCount || (current.lastAnsweredAt ?? null) !== expected.lastAnsweredAt) continue;
          progress.value[questionId] = { ...current, mastered: updated.mastered };
        }
        return result;
      });
    } catch (failure: any) {
      if (failure.status === 409) { try { await readSnapshot(); } catch { /* Keep the conflict; never silently reapply a stale mastery command. */ } }
      throw failure;
    } finally { endBusy(); }
  }
  const markWrongMastered = (ids: string[]) => changeWrongMastery(ids, true);
  const markWrongPending = (ids: string[]) => changeWrongMastery(ids, false);

  async function changeQuestionRecords(ids: string[], removed: boolean): Promise<QuestionRecordsBatchResponse> {
    const selected = [...new Set(ids)];
    if (!selected.length) return { removed, changedCount: 0, questionRecords: {} };
    if (selected.length > 500) throw new Error('一次最多选择500道题目。');
    const items: QuestionRecordsBatchItem[] = selected.map(questionId => {
      if (!questionMap.value[questionId]) throw new Error('所选题库题目不存在，请刷新后再操作。');
      return { questionId, expected: normalizeMetadata(questionRecords.value[questionId]) };
    });
    const endBusy = beginBusy();
    try {
      return await queueProgressMutation(async () => {
        const result = await api.updateQuestionRecordsBatch({ removed, items });
        for (const { questionId } of items) {
          const incoming = result.questionRecords[questionId];
          const current = questionRecords.value[questionId];
          if (incoming && (!current || incoming.revision >= current.revision)) questionRecords.value[questionId] = normalizeMetadata(incoming);
        }
        return result;
      });
    } catch (failure: any) {
      if (failure.status === 409) { try { await readSnapshot({ sessions: true }); } catch { /* Keep the original conflict. */ } }
      throw failure;
    } finally { endBusy(); }
  }
  async function changeSessionRecords(ids: string[], removed: boolean): Promise<SessionRecordsBatchResponse> {
    const selected = [...new Set(ids)];
    if (!selected.length) return { removed, changedCount: 0, sessions: [] };
    if (selected.length > 500) throw new Error('一次最多选择500条学习记录。');
    const items: SessionRecordsBatchItem[] = selected.map(sessionId => {
      const current = sessions.value.find(session => session.id === sessionId);
      if (!current) throw new Error('所选学习记录不存在，请刷新后再操作。');
      return { sessionId, expected: normalizeMetadata(current) };
    });
    const endBusy = beginBusy();
    try {
      return await queueProgressMutation(async () => {
        await writeQueue;
        const result = await api.updateSessionRecordsBatch({ removed, items });
        for (const { sessionId } of items) {
          const updated = result.sessions.find(session => session.id === sessionId);
          // A management response owns metadata only, never later optimistic answers or cursors.
          if (updated) applySessionMetadata(updated);
        }
        return result;
      });
    } catch (failure: any) {
      if (failure.status === 409) { try { await readSnapshot({ sessions: true }); } catch { /* Keep the original conflict. */ } }
      throw failure;
    } finally { endBusy(); }
  }
  const removeQuestionRecords = (ids: string[]) => changeQuestionRecords(ids, true);
  const restoreQuestionRecords = (ids: string[]) => changeQuestionRecords(ids, false);
  const removeSessionRecords = (ids: string[]) => changeSessionRecords(ids, true);
  const restoreSessionRecords = (ids: string[]) => changeSessionRecords(ids, false);

  async function reloadServerSession(sessionId = activeSession.value?.id || currentSession.value?.id) {
    if (!sessionId) return;
    const endBusy = beginBusy();
    try {
      await writeQueue;
      await progressWriteQueue;
      const endMutation = beginMutation();
      const version = mutationVersion;
      try {
        const remote = normalizeSession(await api.getStudySession(sessionId));
        if (version !== mutationVersion) throw new Error('重新载入期间有新的本地修改，已保留；请再次重新载入。');
        answerDrafts.delete(sessionId);
        cursorDrafts.delete(sessionId);
        delete answerConflicts.value[sessionId];
        const selected = upsertSession(remote);
        requireSessionAvailable(sessionId);
        confirmedAnswers.set(sessionId, copyAnswers(selected.answers));
        for (const key of writeFailures.keys()) if (key.startsWith(`${sessionId}:`)) writeFailures.delete(key);
        updateSaveState();
        return selected;
      } finally { endMutation(); }
    } finally { endBusy(); }
  }

  function viewHistory(session: StudySession) {
    requireSessionAvailable(session.id);
    const current = sessions.value.find(item => item.id === session.id) || session;
    if (current.removed) throw sessionRemovedError(session.id);
    selectionVersion++; viewedSession.value = { ...mergeServerSession(serverSessions.get(current.id) || current), cursor: 0 };
  }
  function resume() { if (activeSession.value) requireSessionAvailable(activeSession.value.id); selectionVersion++; viewedSession.value = null; }
  function resumeSession(session: StudySession) {
    requireSessionAvailable(session.id);
    const current = sessions.value.find(item => item.id === session.id) || session;
    if (current.removed) throw sessionRemovedError(session.id);
    selectionVersion++; activeSession.value = mergeServerSession(serverSessions.get(current.id) || current); viewedSession.value = null;
  }
  async function refreshProgress() { await readSnapshot(); }
  return { questions, questionRecords, availableQuestions, removedQuestions, progress, sessions, visibleSessions, removedSessions, activeSession, viewedSession, lastResults, ai, loading, busy, error, loaded, saveState, answerConflicts, hasAnswerConflicts, questionMap, categories, currentSession, currentQuestion, answeredCount, wrongQuestions, removedWrongQuestions, favoriteQuestions, accuracy, bootstrap, startSession, persistAnswer, navigate, checkCurrent, finish, patchProgress, correctQuestionAnswer, restoreQuestionAnswerVersion, syncQuestionAnswer, removeWrongRecords, restoreWrongRecords, markWrongMastered, markWrongPending, removeQuestionRecords, restoreQuestionRecords, removeSessionRecords, restoreSessionRecords, reloadServerSession, viewHistory, resume, resumeSession, refreshProgress };
});
