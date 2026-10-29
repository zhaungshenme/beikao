export type QuestionType = 'single' | 'multiple';
export type StudyMode = 'sequential' | 'random' | 'exam' | 'wrong' | 'favorites';
export interface StudyQuestion {
  id: string;
  category: string;
  chapter: string;
  type: QuestionType;
  difficulty: string;
  stem: string;
  options: Array<{ id: string; text: string }>;
  answer: string[];
  explanation: string;
  answerRevision?: number;
  answerUpdatedAt?: string;
  answerCorrectionNote?: string;
  knowledgePoint: string;
  source: string;
  referenceUrls?: string[];
}
export interface QuestionProgress {
  attempts: number;
  correctCount: number;
  wrongCount: number;
  wrongRemoved: boolean;
  lastAnswer: string[];
  lastCorrect: boolean | null;
  lastAnsweredAt: string | null;
  mastered: boolean;
  favorite: boolean;
  note: string;
  aiNote?: string;
  reason: string;
}
export type ProgressChanges = Partial<Pick<QuestionProgress, 'favorite' | 'mastered' | 'note' | 'reason'>>;
export type ProgressExpected = ProgressChanges;
export interface WrongRecordsBatchItem {
  questionId: string;
  expected: Pick<QuestionProgress, 'wrongRemoved' | 'wrongCount' | 'lastAnsweredAt'>;
}
export interface WrongRecordsBatchResponse { progress: Record<string, QuestionProgress>; changedCount: number }
export interface WrongMasteryBatchItem {
  questionId: string;
  expected: Pick<QuestionProgress, 'mastered' | 'wrongRemoved' | 'wrongCount' | 'lastAnsweredAt'>;
}
export interface WrongMasteryBatchResponse { progress: Record<string, QuestionProgress>; changedCount: number }
export interface QuestionHistoryEntry { id: string; field: 'note' | 'reason' | 'aiNote'; text: string; createdAt: string; source: string }
export interface AnswerHistoryEntry {
  id: string;
  revision: number;
  answer: string[];
  explanation: string;
  note: string;
  createdAt: string;
  source: 'original' | 'correction' | 'restore' | 'import';
}
export interface QuestionAnswerChanges { answer: string[]; explanation: string; note: string; expectedRevision: number }
export interface QuestionAnswerResponse { question: StudyQuestion; sessions?: StudySession[] }
export interface QuestionAnswerHistory extends QuestionAnswerResponse { entries: AnswerHistoryEntry[] }
export interface StudyRequestError extends Error { status?: number; code?: string; current?: unknown; historyId?: string; aiHistoryId?: string }
export interface AiHistoryEntry {
  id: string;
  questionId: string;
  text: string;
  createdAt?: string;
  archivedAt?: string;
  provider: string;
  transport: 'api' | 'web' | 'legacy';
  source: string;
  status: 'current' | 'conflict' | 'legacy';
  model?: string;
  followup?: string;
  userAnswer?: string[];
  questionRevision?: number;
  questionFingerprint?: string;
  retrieval?: AiRetrieval;
  sources?: AiSource[];
}
export interface AnswerConflict { questionId: string; localAnswer: string[]; serverAnswer?: string[]; message: string; code?: string }
export interface RecordMetadata { removed: boolean; revision: number }
export interface QuestionRecordsBatchItem { questionId: string; expected: RecordMetadata }
export interface SessionRecordsBatchItem { sessionId: string; expected: RecordMetadata }
export interface QuestionRecordsBatchResponse { removed: boolean; changedCount: number; questionRecords: Record<string, RecordMetadata> }
export interface SessionRecordsBatchResponse { removed: boolean; changedCount: number; sessions: StudySession[] }
export interface StudySession {
  id: string;
  removed: boolean;
  revision: number;
  mode: StudyMode;
  questionIds: string[];
  answers: Record<string, string[]>;
  submittedQuestionIds: string[];
  gradedResults?: Record<string, QuestionResult>;
  createdAt: string;
  deadlineAt: string | null;
  status: 'active' | 'completed';
  finishedAt?: string;
  score?: number;
  correctCount?: number;
  cursor: number;
}
export type WebProvider = 'zhipu' | 'deepseek';
export type ReplyChannel = 'zhipu-web' | 'deepseek-web' | 'api';
export interface AiSettings {
  mode?: 'web-retrieval-only';
  configured: boolean;
  baseUrl: string;
  model: string;
  webUrl: string;
  webProvider?: WebProvider;
  retrievalEnabled: boolean;
  retrievalAvailable: boolean;
}
export interface AiSource { id: string; title: string; url: string }
export interface AiRetrieval { searchCalls: number; fetchCalls: number; estimatedCostCny: number }
export interface AiExplanation { text: string; sources?: AiSource[]; retrieval?: AiRetrieval }
export interface RetrievalSource extends AiSource {
  content: string;
  contentOrigin?: 'search' | 'fetch';
  contentEdited?: boolean;
  contentTruncated?: false;
  sourceKind?: 'web-page' | 'document-extract';
  documentType?: 'pdf';
  fetchSkipped?: boolean;
  resultIndex?: number;
  originalUrl?: string;
  originalFragment?: string;
  contentPolicy?: string;
}
export interface RetrievalLocalRecovery {
  id: string;
  kind: 'saved-search-text';
  parentArchiveId: string;
  parentArchiveSha256: string;
  networkRequested: false;
  modelRequested: false;
  sourceCount: number;
  sources: RetrievalSource[];
}
export interface RetrievalArchiveEntry {
  id?: string;
  requestId: string;
  questionId: string;
  questionRevision: number;
  questionFingerprint: string;
  currentFingerprintMatch?: boolean;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  modelRequested?: false;
  partial?: boolean;
  query?: string;
  createdAt: string;
  updatedAt?: string;
  sources: RetrievalSource[];
  contentPolicy?: string;
  localRecovery?: RetrievalLocalRecovery;
  localRecoverySourceCount?: number;
  referenceAvailable?: boolean;
  sourceErrors?: Array<{ url: string; title?: string; code?: string; error?: string; upstreamStatus?: number; tool?: string }>;
  skippedSources?: Array<{ url: string; title?: string; reason?: string; notice?: string }>;
  usage?: AiRetrieval;
  error?: string;
}
export interface RetrievalReply { cached: boolean; entry: RetrievalArchiveEntry }
export interface StudyBootstrap {
  questions: StudyQuestion[];
  questionRecords?: Record<string, RecordMetadata>;
  progress: Record<string, QuestionProgress>;
  sessions: StudySession[];
  activeSession: StudySession | null;
  ai: AiSettings;
}
export interface SessionOptions {
  mode: StudyMode;
  category?: string;
  chapter?: string;
  type?: string;
  difficulty?: string;
  count: number;
  minutes: number;
  questionIds?: string[];
}
export interface QuestionResult {
  questionId: string;
  correct: boolean;
  answer: string[];
  userAnswer: string[];
  explanation: string;
  questionRevision?: number;
}
export interface CheckResponse {
  session: StudySession;
  correct: boolean;
  answer: string[];
  explanation: string;
  questionRevision?: number;
  progress: QuestionProgress;
}
export interface FinishResponse {
  session: StudySession;
  results: QuestionResult[];
}
export interface BridgeStatus {
  connected: boolean;
  lastSeenAt: string | null;
  version: string | null;
  provider?: WebProvider;
  activeProvider?: WebProvider | null;
  availableProviders?: WebProvider[];
  worker?: {
    connected: boolean;
    state: 'idle' | 'preparing' | 'running' | 'waiting-login' | 'blocked' | 'standby' | 'offline';
    jobId: string | null;
    message: string;
    lastSeenAt: string | null;
    provider?: WebProvider;
    version?: string | null;
  };
}
export interface BridgeJob { id: string; provider?: string; status: 'queued' | 'sent' | 'running' | 'streaming' | 'completed' | 'failed'; createdAt?: string; updatedAt?: string; lastProgressAt?: string; questionId?: string; prompt?: string; text?: string; error?: string; failureCode?: string; sequence?: number; requestId?: string; kind?: 'preanalysis' | 'personalized'; userAnswer?: string[]; followup?: string; questionFingerprint?: string; questionRevision?: number; aiHistoryId?: string }
export interface BridgeOverview {
  provider?: WebProvider;
  activeJob: BridgeJob | null;
  latestJob: BridgeJob | null;
  serverTime: string;
  limits: { totalTimeoutMs: number; idleTimeoutMs: number };
}
export type PreanalysisTransport = 'web' | 'official-api';
export type PreanalysisWebDriver = 'userscript' | 'browser-ui';
export type PreanalysisModel = 'glm-4.7-flash' | 'glm-4-flash-250414';
export interface PreanalysisSettings {
  transport: PreanalysisTransport;
  webDriver?: PreanalysisWebDriver;
  configured: boolean;
  model: PreanalysisModel;
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4';
  keyStorage: 'none' | 'windows-dpapi' | 'environment';
  message?: string;
}
export interface PreanalysisSettingsChanges {
  transport?: PreanalysisTransport;
  webDriver?: PreanalysisWebDriver;
  model?: PreanalysisModel;
  apiKey?: string;
  clearApiKey?: boolean;
}
export interface PreanalysisStatus {
  status: 'idle' | 'running' | 'paused' | 'completed';
  total: number;
  completed: number;
  pending: number;
  failed: number;
  stale: number;
  currentJobId: string | null;
  message: string;
  batchSize: number;
  transport?: PreanalysisTransport;
  webDriver?: PreanalysisWebDriver;
  updatedAt?: string;
}
export interface PreparedExplanation {
  questionId: string;
  questionRevision: number;
  contentVersion: string;
  state: 'ready' | 'pending' | 'stale' | 'review';
  text: string;
  source: string;
  generatedAt?: string;
  fingerprint: string;
  validation?: { identity: 'matched'; answer: 'matched' | 'not-recorded'; factualReview: 'not-recorded' };
}
