import type { AiExplanation, AiSettings, BridgeJob, BridgeOverview, BridgeStatus, CheckResponse, FinishResponse, PreanalysisSettings, PreanalysisSettingsChanges, PreanalysisStatus, PreparedExplanation, ProgressChanges, ProgressExpected, QuestionAnswerChanges, QuestionAnswerHistory, QuestionAnswerResponse, QuestionHistoryEntry, QuestionProgress, QuestionRecordsBatchItem, QuestionRecordsBatchResponse, SessionOptions, SessionRecordsBatchItem, SessionRecordsBatchResponse, StudyBootstrap, StudyRequestError, StudySession, WebProvider, WrongMasteryBatchItem, WrongMasteryBatchResponse, WrongRecordsBatchItem, WrongRecordsBatchResponse } from './types';

/** 独立个人学习服务使用同源 API；不复用管理端的令牌和加密协议。 */
async function studyRequest<T>(path: string, method = 'GET', body?: unknown, timeout = 20000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`/study-api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    const raw = await response.text();
    let payload: any;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { throw new Error('服务返回格式异常，请确认学习服务正常运行。'); }
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || payload.msg || `请求失败（${response.status}）`) as StudyRequestError;
      error.status = response.status;
      if (typeof payload.code === 'string') error.code = payload.code;
      if (payload.current !== undefined) error.current = payload.current;
      if (typeof payload.historyId === 'string') error.historyId = payload.historyId;
      throw error;
    }
    return payload as T;
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('请求超时，请稍后重试。已保存的数据不会因此清空。');
    if (error instanceof TypeError) throw new Error('暂时无法连接本机学习服务，请检查服务是否正在运行。');
    throw error;
  } finally { window.clearTimeout(timer); }
}

export const loadStudy = () => studyRequest<StudyBootstrap>('/bootstrap');
export const createStudySession = (options: SessionOptions) => studyRequest<StudySession>('/sessions', 'POST', options);
export const getStudySession = (id: string) => studyRequest<StudySession>(`/sessions/${encodeURIComponent(id)}`);
export const updateStudySession = (id: string, data: { questionId?: string; answer?: string[]; cursor?: number; expectedAnswer?: string[] }) => studyRequest<StudySession>(`/sessions/${encodeURIComponent(id)}`, 'PATCH', data);
export const checkStudyQuestion = (id: string, questionId: string, answer: string[], expectedAnswer: string[], expectedQuestionRevision = 0) => studyRequest<CheckResponse>(`/sessions/${encodeURIComponent(id)}/check`, 'POST', { questionId, answer, expectedAnswer, expectedQuestionRevision });
export const finishStudySession = (id: string, expectedAnswers: Record<string, string[]>, expectedQuestionRevisions: Record<string, number> = {}) => studyRequest<FinishResponse>(`/sessions/${encodeURIComponent(id)}/finish`, 'POST', { expectedAnswers, expectedQuestionRevisions });
export const loadQuestionAnswerHistory = (id: string) => studyRequest<QuestionAnswerHistory>(`/questions/${encodeURIComponent(id)}/answer-history`);
export const saveQuestionAnswer = (id: string, data: QuestionAnswerChanges) => studyRequest<QuestionAnswerResponse>(`/questions/${encodeURIComponent(id)}/answer`, 'PUT', data);
export const restoreQuestionAnswer = (id: string, data: { historyId: string; expectedRevision: number }) => studyRequest<QuestionAnswerResponse>(`/questions/${encodeURIComponent(id)}/answer/restore`, 'POST', data);
export const updateQuestionProgress = (id: string, data: ProgressChanges & { expected: ProgressExpected }) => studyRequest<QuestionProgress>(`/questions/${encodeURIComponent(id)}`, 'PATCH', data);
export const updateWrongRecordsBatch = (data: { removed: boolean; items: WrongRecordsBatchItem[] }) => studyRequest<WrongRecordsBatchResponse>('/wrong-records/batch', 'POST', data);
export const updateWrongMasteryBatch = (data: { mastered: boolean; items: WrongMasteryBatchItem[] }) => studyRequest<WrongMasteryBatchResponse>('/wrong-records/mastery', 'POST', data);
export const updateQuestionRecordsBatch = (data: { removed: boolean; items: QuestionRecordsBatchItem[] }) => studyRequest<QuestionRecordsBatchResponse>('/question-records/batch', 'POST', data);
export const updateSessionRecordsBatch = (data: { removed: boolean; items: SessionRecordsBatchItem[] }) => studyRequest<SessionRecordsBatchResponse>('/session-records/batch', 'POST', data);
export const loadQuestionHistory = (id: string) => studyRequest<{ entries: QuestionHistoryEntry[] }>(`/questions/${encodeURIComponent(id)}/history`);
export const restoreQuestionHistory = (id: string, data: { historyId: string; expected: string }) => studyRequest<QuestionProgress>(`/questions/${encodeURIComponent(id)}/restore`, 'POST', data);
export const saveAiSettings = (data: { baseUrl?: string; model?: string; apiKey?: string; clearApiKey?: boolean; retrievalEnabled?: boolean; webUrl?: string; webProvider?: WebProvider }) => studyRequest<AiSettings>('/ai/settings', 'PUT', data);
export const explainStudyQuestion = (data: { questionId: string; answer?: string[]; question?: string; expectedQuestionRevision?: number; retrievalEnabled: boolean }) => studyRequest<AiExplanation>('/ai/explain', 'POST', data, 120000);
export const exportStudyData = () => studyRequest<unknown>('/export');
export const getBridgeStatus = (provider?: WebProvider) => studyRequest<BridgeStatus>(`/bridge/status${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`, 'GET', undefined, 8000);
export const createBridgeJob = (data: { questionId: string; answer?: string[]; question?: string; requestId?: string; provider?: WebProvider; expectedQuestionRevision?: number }) => studyRequest<BridgeJob>('/bridge/jobs', 'POST', data, 8000);
export const getBridgeJob = (id: string) => studyRequest<BridgeJob>(`/bridge/jobs/${encodeURIComponent(id)}`);
export const getPendingBridgeJobs = (provider: WebProvider) => studyRequest<{ provider: WebProvider; jobs: BridgeJob[] }>(`/bridge/pending?provider=${encodeURIComponent(provider)}`);
export const getBridgeOverview = (provider?: WebProvider) => studyRequest<BridgeOverview>(`/bridge/overview${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`, 'GET', undefined, 8000);
export const cancelBridgeJob = (id: string) => studyRequest<BridgeJob>(`/bridge/jobs/${encodeURIComponent(id)}/cancel`, 'POST', {}, 8000);
export const getPreanalysisStatus = () => studyRequest<PreanalysisStatus>('/preanalysis/status', 'GET', undefined, 8000);
export const getPreanalysisSettings = () => studyRequest<PreanalysisSettings>('/preanalysis/settings', 'GET', undefined, 8000);
export const savePreanalysisSettings = (data: PreanalysisSettingsChanges) => studyRequest<PreanalysisSettings>('/preanalysis/settings', 'PUT', data, 20000);
export const controlPreanalysis = (data: { action: 'start' | 'pause' | 'retry'; batchSize?: number }) => studyRequest<PreanalysisStatus>('/preanalysis/control', 'POST', data, 8000);
export const getPreparedExplanation = (id: string) => studyRequest<PreparedExplanation>(`/preanalysis/questions/${encodeURIComponent(id)}`, 'GET', undefined, 8000);
