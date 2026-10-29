import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import StudyWorkspace from '@/views/study/StudyWorkspace.vue';
import { emptyProgress, useStudyStore } from '@/store/modules/study';
import * as api from '@/api/study';
import type { AiHistoryEntry, RetrievalArchiveEntry, RetrievalLocalRecovery, RetrievalReply, RetrievalSource, StudyBootstrap, StudySession } from '@/api/study/types';
import { type HostNode, hostNode, renderer, descendants, visibleText, button, click, settle } from './vue-memory-host';

vi.mock('@/api/study', () => ({
  loadStudy: vi.fn(), checkStudyQuestion: vi.fn(), finishStudySession: vi.fn(), updateStudySession: vi.fn(),
  getBridgeStatus: vi.fn(), getBridgeOverview: vi.fn(), getBridgeJob: vi.fn(), createBridgeJob: vi.fn(), cancelBridgeJob: vi.fn(),
  getPreparedExplanation: vi.fn(), getPreanalysisStatus: vi.fn(), controlPreanalysis: vi.fn(),
  getPreanalysisSettings: vi.fn(), savePreanalysisSettings: vi.fn(), explainStudyQuestion: vi.fn(), saveAiSettings: vi.fn(), loadAiHistory: vi.fn(), loadRetrievalHistory: vi.fn(), retrieveStudyQuestion: vi.fn(),
}));
vi.mock('element-plus', () => ({ ElMessage: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  ElMessageBox: { confirm: vi.fn().mockResolvedValue('confirm') } }));
const time = '2026-10-22T00:00:00.000Z';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const preparedVersion = (q: StudyBootstrap['questions'][number]) => ({ questionRevision: q.answerRevision ?? 0,
  contentVersion: JSON.stringify([q.id, q.type, q.stem, q.options.map(o => [o.id, o.text]), [...q.answer].sort(), q.explanation, q.answerRevision ?? 0]) });
let data: StudyBootstrap;
let savedHistories: AiHistoryEntry[];
let retrievals: RetrievalArchiveEntry[];
let host: HostNode;
let app: ReturnType<typeof renderer.createApp> | null;
function initial(): StudyBootstrap {
  const session: StudySession = { id: 'S-1', removed: false, revision: 0, mode: 'sequential', questionIds: ['Q-1'],
    answers: { 'Q-1': ['A'] }, submittedQuestionIds: [], createdAt: time, deadlineAt: null, status: 'active', cursor: 0 };
  return { questions: [{ id: 'Q-1', category: '计算机网络', chapter: '基础', type: 'single', difficulty: '基础',
    stem: '回答正确后也需要理解理由', options: [{ id: 'A', text: '正确选项' }, { id: 'B', text: '错误选项' }],
    answer: ['A'], answerRevision: 0, explanation: '原始理论解析', knowledgePoint: '网络知识点', source: '原创题' }], questionRecords: {},
    progress: { 'Q-1': { ...emptyProgress(), lastAnswer: ['A'], lastCorrect: true, note: '已保存笔记', aiNote: '之前的AI解析' } },
    sessions: [session], activeSession: session, ai: { configured: true, baseUrl: 'https://model.example/v1', model: 'test-model',
      retrievalEnabled: false, retrievalAvailable: false, webUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh' } };
}
function grade(status: 'active' | 'completed' = 'active') {
  const session = data.sessions[0]; session.status = status; session.submittedQuestionIds = ['Q-1']; session.revision++;
  session.gradedResults = { 'Q-1': { questionId: 'Q-1', correct: true, answer: ['A'], userAnswer: ['A'], explanation: '原始理论解析', questionRevision: 0 } };
  if (status === 'completed') { session.score = 100; session.correctCount = 1; session.finishedAt = time; data.activeSession = null; }
  Object.assign(data.progress['Q-1'], { attempts: 1, correctCount: 1, wrongCount: 0, lastAnsweredAt: time });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(time)); vi.resetAllMocks(); setActivePinia(createPinia());
  vi.stubGlobal('window', { innerWidth: 1280, setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
  vi.stubGlobal('document', { hidden: false, activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  for (const storage of ['localStorage', 'sessionStorage']) vi.stubGlobal(storage, { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
  data = initial(); savedHistories = []; retrievals = []; host = hostNode('root'); app = null;
  vi.mocked(api.loadStudy).mockImplementation(async () => copy(data));
  vi.mocked(api.checkStudyQuestion).mockImplementation(async () => { grade(); return copy({ session: data.sessions[0], correct: true, answer: ['A'], explanation: '原始理论解析', questionRevision: 0, progress: data.progress['Q-1'] }); });
  vi.mocked(api.explainStudyQuestion).mockImplementation(async ({ questionId }) => ({ text: data.progress[questionId].aiNote }));
  vi.mocked(api.loadAiHistory).mockImplementation(async id => ({ entries: copy(savedHistories.filter(entry => entry.questionId === id)) }));
  vi.mocked(api.loadRetrievalHistory).mockImplementation(async id => ({ entries: copy(retrievals.filter(entry => entry.questionId === id)) }));
  vi.mocked(api.retrieveStudyQuestion).mockImplementation(async payload => { const entry = retrievalEntry({ questionId: payload.questionId, requestId: payload.requestId }); retrievals.push(entry); return { cached: false, entry: copy(entry) }; });
  vi.mocked(api.getPreparedExplanation).mockResolvedValue({ ...preparedVersion(data.questions[0]), questionId: 'Q-1', state: 'pending', text: '', source: '', fingerprint: 'test' });
});
afterEach(() => { app?.unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function mount() { app = renderer.createApp(StudyWorkspace); app.mount(host); await settle(); return useStudyStore(); }
function entry() { return button(host, '检索本题网页资料'); }
function hasEntry() { return descendants(host).some(node => node.tag === 'button' && node.props['aria-label'] === '检索本题网页资料'); }
function bottomEntry() {
  const result = descendants(host).find(node => node.tag === 'button' && node.props['aria-label'] !== '检索本题网页资料' && visibleText(node).includes('✦ AI 解析'));
  if (!result) throw new Error('未找到底部AI解析按钮'); return result;
}
function field(label: string) {
  const result = descendants(host).find(node => node.tag === 'input' && node.props['aria-label'] === label);
  if (!result) throw new Error(`未找到字段 ${label}`); return result;
}
async function edit(label: string, value: string) { const input = field(label); input.value = value; input.dispatchEvent({ type: 'input', target: input }); await settle(); }
async function toggle(label: string, checked = true) {
  const input = field(label); input.checked = checked;
  input.dispatchEvent({ type: 'change', target: input }); await settle();
}
function form() { return descendants(host).find(node => node.tag === 'form' && node.props['aria-label'] === 'API 配置')!; }
function assertOnlyAnalysis() { expect(api.finishStudySession).not.toHaveBeenCalled(); expect(api.updateStudySession).not.toHaveBeenCalled(); }
function savedHistory(patch: Partial<AiHistoryEntry> = {}): AiHistoryEntry {
  return { id: 'history-1', questionId: 'Q-1', text: '此前完整解析历史', createdAt: '2025-10-22T00:00:00.000Z', provider: 'api', transport: 'api', source: 'api',
    status: 'current', model: 'test-model', userAnswer: ['A'], questionRevision: 0, questionFingerprint: 'a'.repeat(64), ...patch };
}
function historyCards() { return descendants(host).filter(node => node.tag === 'details' && node.props.class === 'ai-history-entry'); }


function retrievalEntry(patch: Partial<RetrievalArchiveEntry> = {}): RetrievalArchiveEntry {
  return { id: 'R-1', requestId: 'request-retrieval-1', questionId: 'Q-1', questionRevision: 0, questionFingerprint: 'a'.repeat(64), currentFingerprintMatch: true,
    status: 'completed', createdAt: time, query: '公开题干检索词', sources: [{ id: 'S1', title: '公开文档', url: 'https://example.org/source', content: '网页原文，不是模型生成' }],
    usage: { searchCalls: 1, fetchCalls: 1, estimatedCostCny: 0.01 }, ...patch };
}
function sourceCards() { return descendants(host).filter(node => node.tag === 'details' && node.props.class === 'retrieval-history-entry'); }
function pdfSource(patch: Partial<RetrievalSource> = {}): RetrievalSource {
  return { id: 'S-pdf', title: '搜索返回的 PDF', url: 'https://example.org/reference.pdf', originalUrl: 'https://example.org/reference.pdf#page=3',
    originalFragment: 'page=3', resultIndex: 0, content: 'Search 已返回的 PDF 文字摘录', contentOrigin: 'search', sourceKind: 'document-extract',
    documentType: 'pdf', fetchSkipped: true, contentTruncated: false, contentPolicy: 'search-pdf-extract-readonly-v1', ...patch };
}
function localRecovery(sources: RetrievalSource[] = [pdfSource()], patch: Partial<RetrievalLocalRecovery> = {}): RetrievalLocalRecovery {
  return { id: `saved-search-text:${'c'.repeat(64)}`, kind: 'saved-search-text', parentArchiveId: 'R-1', parentArchiveSha256: 'c'.repeat(64),
    networkRequested: false, modelRequested: false, sources, sourceCount: sources.length, ...patch };
}
function secondQuestion() {
  data.questions.push({ ...copy(data.questions[0]), id: 'Q-2', stem: '第二道题' });
  data.progress['Q-2'] = { ...emptyProgress(), lastAnswer: ['B'] };
  data.sessions[0].questionIds.push('Q-2'); data.sessions[0].submittedQuestionIds.push('Q-2');
}
function noModelRequests() { expect(api.explainStudyQuestion).not.toHaveBeenCalled(); expect(api.createBridgeJob).not.toHaveBeenCalled(); }

describe('固定 Search／Fetch 网页资料链路', () => {
  it('旧生成助手在本机直接拒绝，连旧 HTTP 入口也不发送', async () => {
    const actual = await vi.importActual<typeof import('@/api/study')>('@/api/study');
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(actual.explainStudyQuestion({ questionId: 'Q-1', retrievalEnabled: false })).rejects.toThrow('生成模型入口已关闭');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('启动与打开题目不自动搜索、抓取或调用模型', async () => {
    grade(); await mount(); await click(button(host, '继续上次答题'));
    expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); expect(api.loadRetrievalHistory).not.toHaveBeenCalled(); noModelRequests();
    expect(visibleText(host)).toContain('不调用生成模型'); expect(visibleText(entry())).toBe('检索网页并保存');
  });
  it('点击仅提交检索标识与题号版本，不发送答案、追问或笔记', async () => {
    grade(); const store = await mount(); await click(button(host, '继续上次答题')); const before = copy(store.progress['Q-1']); await click(entry());
    expect(api.retrieveStudyQuestion).toHaveBeenCalledExactlyOnceWith({ questionId: 'Q-1', expectedQuestionRevision: 0, requestId: expect.any(String) });
    expect(api.loadRetrievalHistory).toHaveBeenCalledExactlyOnceWith('Q-1'); noModelRequests(); assertOnlyAnalysis();
    expect(store.progress['Q-1']).toEqual(before); expect(sourceCards()).toHaveLength(1); expect(visibleText(host)).toContain('网页原文，不是模型生成');
  });
  it('同指纹已有成功记录只读取缓存，不重发 Search／Fetch', async () => {
    grade(); retrievals = [retrievalEntry()]; await mount(); await click(button(host, '继续上次答题')); await click(entry()); await click(entry());
    expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); expect(api.loadRetrievalHistory).toHaveBeenCalledTimes(2); noModelRequests();
    expect(sourceCards()).toHaveLength(1); expect(visibleText(entry())).toContain('查看已保存网页资料');
  });
  it('清除密钥后已存网页资料仍可直接阅读，无需重新配置', async () => {
    grade(); data.ai.configured = false; retrievals = [retrievalEntry()];
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    expect(sourceCards()).toHaveLength(1); expect(visibleText(host)).toContain('网页原文，不是模型生成');
    expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it.each(['failed', 'unknown', 'running'] as const)('%s 缓存如实显示，禁止自动重抓并不得报成功', async status => {
    grade(); retrievals = [retrievalEntry({ status, sources: [], error: `${status}实际状态` })]; await mount(); await click(button(host, '继续上次答题')); await click(entry());
    expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); expect(visibleText(host)).toContain(`${status}实际状态`); noModelRequests();
  });
  it.each(['failed', 'unknown'] as const)('首次返回 %s 记录不冒充抓取成功', async status => {
    grade(); vi.mocked(api.retrieveStudyQuestion).mockResolvedValue({ cached: false, entry: retrievalEntry({ status, error: '抓取未完成', sources: [] }) });
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    expect(visibleText(host)).toContain('抓取未完成'); expect(visibleText(sourceCards()[0])).not.toContain('网页正文已保存'); noModelRequests();
  });
  it('部分成功如实展示失败状态、跳过文件和对应正文的安全清理标识', async () => {
    grade(); retrievals = [retrievalEntry({ partial: true, modelRequested: false,
      sourceErrors: [{ url: 'javascript:alert(1)', title: '被拒绝的来源', code: 'SOURCE_BLOCKED', error: '来源拒绝抓取', upstreamStatus: 403, tool: 'fetch' }],
      skippedSources: [{ url: 'https://example.org/document.pdf', title: '搜索发现的PDF', reason: 'non-web-file', notice: '非网页文件，未提交 Fetch' }],
      sources: [{ id: 'S1', title: '成功的网页来源', url: 'https://example.org/source', content: '保留的网页正文', contentEdited: true, contentTruncated: false }],
    })];
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    const text = visibleText(sourceCards()[0]); expect(text).toContain('部分来源未抓取，已保存可用正文'); expect(text).toContain('HTTP 403');
    expect(text).toContain('非网页文件，未提交 Fetch'); expect(text).toContain('保留的网页正文');
    const source = descendants(sourceCards()[0]).find(node => node.tag === 'article' && node.props.class === 'retrieval-source')!;
    expect(visibleText(source)).toContain('敏感认证信息或控制字符已做安全清理');
    expect(descendants(sourceCards()[0]).filter(node => node.tag === 'a').some(node => String(node.props.href).startsWith('javascript:'))).toBe(false);
    expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('新抓取返回部分成功时，摘要不冒称全部正文抓取成功', async () => {
    grade(); vi.mocked(api.retrieveStudyQuestion).mockResolvedValue({ cached: false, entry: retrievalEntry({ partial: true, sourceErrors: [{ url: 'https://example.org/missing', upstreamStatus: 404, code: 'SOURCE_NOT_FOUND' }] }) });
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    expect(visibleText(sourceCards()[0])).toContain('部分来源未抓取，已保存可用正文'); expect(visibleText(sourceCards()[0])).toContain('HTTP 404'); noModelRequests();
  });
  it('Search 与 Fetch 获得的网页正文分别如实标记获取方式', async () => {
    grade(); retrievals = [retrievalEntry({ sources: [
      { id: 'S1', title: '搜索正文来源', url: 'https://example.org/search-body', content: 'Search取得的完整正文', contentOrigin: 'search' },
      { id: 'S2', title: '抓取正文来源', url: 'https://example.org/fetch-body', content: 'Fetch取得的完整正文', contentOrigin: 'fetch' },
    ] })];
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    const sources = descendants(sourceCards()[0]).filter(node => node.tag === 'article' && node.props.class === 'retrieval-source');
    expect(visibleText(sources[0])).toContain('Search 返回的网页正文'); expect(visibleText(sources[0])).not.toContain('Fetch 抓取的网页正文');
    expect(visibleText(sources[1])).toContain('Fetch 抓取的网页正文'); expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('新存 PDF 显示 Search 文字摘录及原页定位，不冒充 Fetch 正文或 PDF 全文', async () => {
    grade(); vi.mocked(api.retrieveStudyQuestion).mockResolvedValue({ cached: false, entry: retrievalEntry({ sources: [pdfSource()],
      usage: { searchCalls: 1, fetchCalls: 0, estimatedCostCny: 0.005 } }) });
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    const card = sourceCards()[0]; const text = visibleText(card);
    expect(text).toContain('网页／文档资料已保存'); expect(text).toContain('Search 返回的 PDF 文字摘录；未调用 Fetch；非 PDF 全文或已核验解析');
    expect(text).toContain('1 次 Search、0 次 Fetch'); expect(text).not.toContain('Search 返回的网页正文'); expect(text).not.toContain('Fetch 抓取的网页正文');
    expect(descendants(card).find(node => node.tag === 'a')?.props.href).toBe('https://example.org/reference.pdf#page=3');
    expect((await import('element-plus')).ElMessage.success).toHaveBeenCalledWith('网页／文档资料已保存');
    expect(api.retrieveStudyQuestion).toHaveBeenCalledTimes(1); noModelRequests();
  });
  it('旧失败档案无密钥也可只读展示恢复资料，原失败与错误仍保留且不重抓', async () => {
    grade(); data.ai.configured = false;
    retrievals = [retrievalEntry({ status: 'failed', sources: [], error: '原检索未找到可用公开网页', localRecovery: localRecovery() })];
    const before = copy(retrievals);
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    const text = visibleText(sourceCards()[0]);
    expect(text).toContain('检索失败，未自动重试'); expect(text).toContain('原检索未找到可用公开网页');
    expect(text).toContain('已从当时保存的 Search 结果恢复 1 份资料，未新增网络请求');
    expect(text).toContain('原检索失败状态保留'); expect(text).toContain('Search 已返回的 PDF 文字摘录');
    expect(text).not.toContain('网页／文档资料已保存'); expect(text).not.toContain('网页正文已保存');
    expect(retrievals).toEqual(before); expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); expect(api.saveAiSettings).not.toHaveBeenCalled();
    expect((await import('element-plus')).ElMessage.success).not.toHaveBeenCalled(); noModelRequests();
  });
  it('恢复资料与原有正文分开展示且排除重复 URL，旧来源获取方式保留', async () => {
    grade(); retrievals = [retrievalEntry({ status: 'failed', error: '原 Fetch 未完成', sources: [
      { id: 'S-web', title: '原有网页', url: 'https://example.org/source', content: '原有 Search 网页正文', contentOrigin: 'search' },
    ], localRecovery: localRecovery([
      pdfSource({ id: 'S-duplicate', url: 'https://example.org/source', content: '重复来源不可再显示' }), pdfSource(),
    ]) })];
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    const text = visibleText(sourceCards()[0]);
    expect(text).toContain('原有 Search 网页正文'); expect(text).toContain('Search 返回的网页正文');
    expect(text).toContain('已从当时保存的 Search 结果恢复 1 份资料'); expect(text).not.toContain('重复来源不可再显示');
    expect(text).toContain('原 Fetch 未完成'); expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('恢复资料正文保持纯文本，危险原始定位链接不会成为可点击链接', async () => {
    grade(); retrievals = [retrievalEntry({ status: 'failed', sources: [], localRecovery: localRecovery([
      pdfSource({ content: '<img src=x onerror=alert(1)>原摘录', originalUrl: 'javascript:alert(1)' }),
      pdfSource({ id: 'S-unsafe', url: 'javascript:alert(2)', originalUrl: 'https://user:pass@example.org/file.pdf', content: '不安全链接仍只显示文字' }),
    ]) })];
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    const nodes = descendants(sourceCards()[0]); const links = nodes.filter(node => node.tag === 'a');
    expect(links).toHaveLength(1); expect(links[0].props.href).toBe('https://example.org/reference.pdf');
    expect(nodes.some(node => node.tag === 'pre' && node.text === '<img src=x onerror=alert(1)>原摘录')).toBe(true);
    expect(nodes.some(node => node.props.innerHTML || node.tag === 'img')).toBe(false);
    expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('原档案已有两份正文时不展示异常回复中的第三份恢复来源', async () => {
    grade(); retrievals = [retrievalEntry({ status: 'failed', error: '原失败记录', sources: [
      { id: 'S1', title: '原来源一', url: 'https://example.org/one', content: '第一份原正文', contentOrigin: 'search' },
      { id: 'S2', title: '原来源二', url: 'https://example.org/two', content: '第二份原正文', contentOrigin: 'fetch' },
    ], localRecovery: localRecovery([pdfSource({ content: '超出来源预算的第三份摘录' })]) })];
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    const card = sourceCards()[0]; const text = visibleText(card);
    expect(text).toContain('第一份原正文'); expect(text).toContain('第二份原正文'); expect(text).toContain('原失败记录');
    expect(text).not.toContain('超出来源预算的第三份摘录'); expect(text).not.toContain('已从当时保存的 Search 结果恢复');
    expect(descendants(card).filter(node => node.tag === 'article' && node.props.class === 'retrieval-source')).toHaveLength(2);
    expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('恢复身份不属于该档案时不展示，保留原失败且不发起新请求', async () => {
    grade(); retrievals = [retrievalEntry({ status: 'failed', sources: [], error: '原失败记录',
      localRecovery: localRecovery([pdfSource({ content: '其他档案摘录不可显示' })], { parentArchiveId: 'different-entry' }) })];
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    const text = visibleText(sourceCards()[0]); expect(text).toContain('原失败记录'); expect(text).not.toContain('其他档案摘录不可显示');
    expect(text).not.toContain('已从当时保存的 Search 结果恢复'); expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('Fetch失败但同URL的Search正文已保留时明确说明，不冒称全部抓取成功', async () => {
    grade(); retrievals = [retrievalEntry({ partial: true,
      sources: [{ id: 'S1', title: '正文来源', url: 'https://example.org/search-body', content: '已保留的Search网页正文', contentOrigin: 'search' }],
      sourceErrors: [{ url: 'https://example.org/search-body', code: 'TIMEOUT', tool: 'fetch', error: 'Fetch超时' }],
    })];
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    expect(visibleText(sourceCards()[0])).toContain('Fetch 未完成，Search 返回的网页正文已保留');
    expect(visibleText(sourceCards()[0])).toContain('已保留的Search网页正文'); expect(visibleText(sourceCards()[0])).toContain('部分来源未抓取，已保存可用正文'); noModelRequests();
  });
  it('旧版本记录不阻止当前版本检索，旧原文仍保留', async () => {
    grade(); retrievals = [retrievalEntry({ id: 'R-old', questionFingerprint: 'b'.repeat(64), currentFingerprintMatch: false, sources: [] })];
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    expect(api.retrieveStudyQuestion).toHaveBeenCalledTimes(1); expect(sourceCards()).toHaveLength(2); expect(visibleText(host)).toContain('旧题目版本'); noModelRequests();
  });
  it('连接结果未知后下一次点击仅重读，空列表也不会盲重发', async () => {
    grade(); vi.mocked(api.retrieveStudyQuestion).mockRejectedValueOnce(new Error('响应中断'));
    await mount(); await click(button(host, '继续上次答题')); await click(entry()); await click(entry());
    expect(api.retrieveStudyQuestion).toHaveBeenCalledTimes(1); expect(api.loadRetrievalHistory).toHaveBeenCalledTimes(2);
    expect(visibleText(host)).toContain('未重新调用 Search／Fetch'); noModelRequests();
  });
  it('其他题的成功请求不会清除上一题的不明状态和重发保护', async () => {
    grade(); secondQuestion(); vi.mocked(api.retrieveStudyQuestion).mockRejectedValueOnce(new Error('第一题响应中断'));
    const store = await mount(); await click(button(host, '继续上次答题')); await click(entry());
    store.activeSession!.cursor = 1; await settle(); await click(entry());
    expect(api.retrieveStudyQuestion).toHaveBeenCalledTimes(2);
    store.activeSession!.cursor = 0; await settle(); await click(entry());
    expect(api.retrieveStudyQuestion).toHaveBeenCalledTimes(2); expect(visibleText(host)).toContain('未重新调用 Search／Fetch'); noModelRequests();
  });
  it('付费前本机历史读取失败时不发出检索', async () => {
    grade(); vi.mocked(api.loadRetrievalHistory).mockRejectedValueOnce(new Error('本机读取失败'));
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); expect(visibleText(host)).toContain('本机读取失败'); noModelRequests();
  });
  it('网页原文保持纯文本，危险网址无法成为可点击链接', async () => {
    grade(); retrievals = [retrievalEntry({ sources: [
      { id: 'S1', title: '公开来源', url: 'https://example.org/source', content: '<script>原文而非脚本</script>' },
      { id: 'S2', title: '危险来源', url: 'javascript:alert(1)', content: '危险网址的纯文本正文' },
      { id: 'S3', title: '带凭据来源', url: 'https://user:pass@example.org/', content: '正文' },
    ] })];
    await mount(); await click(button(host, '继续上次答题')); await click(button(host, '查看已保存网页资料'));
    const links = descendants(sourceCards()[0]).filter(node => node.tag === 'a');
    expect(links).toHaveLength(1); expect(links[0].props).toMatchObject({ href: 'https://example.org/source', rel: 'noopener noreferrer', target: '_blank' });
    expect(descendants(host).some(node => node.tag === 'pre' && node.text === '<script>原文而非脚本</script>')).toBe(true); expect(descendants(host).some(node => node.props.innerHTML)).toBe(false);
    expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('只读展开和刷新资料不触发外部检索', async () => {
    grade(); retrievals = [retrievalEntry()]; await mount(); await click(button(host, '继续上次答题'));
    await click(button(host, '查看已保存网页资料')); await click(button(host, '刷新检索记录（只读）'));
    expect(api.loadRetrievalHistory).toHaveBeenCalledTimes(2); expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('检索期间两处按钮共同禁用，重复事件也不重复派发', async () => {
    grade(); let resolve!: (reply: RetrievalReply) => void;
    vi.mocked(api.retrieveStudyQuestion).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await mount(); await click(button(host, '继续上次答题')); const pending = click(entry()); await settle();
    expect(entry().props.disabled).toBe(true); await entry().props.onClick();
    const buttons = descendants(host).filter(node => node.tag === 'button' && visibleText(node) === '正在检索网页…');
    expect(buttons).toHaveLength(2); expect(buttons.every(node => node.props.disabled)).toBe(true);
    await buttons[1].props.onClick(); expect(api.retrieveStudyQuestion).toHaveBeenCalledTimes(1);
    resolve({ cached: false, entry: retrievalEntry() }); await pending; noModelRequests();
  });
  it('请求中收起资料后，迟到的抓取回复不会强制重开面板', async () => {
    grade(); let resolve!: (reply: RetrievalReply) => void;
    vi.mocked(api.retrieveStudyQuestion).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await mount(); await click(button(host, '继续上次答题')); const pending = click(entry()); await settle();
    await click(button(host, '收起网页资料')); resolve({ cached: false, entry: retrievalEntry() }); await pending;
    expect(sourceCards()).toHaveLength(0); expect(visibleText(host)).not.toContain('网页原文，不是模型生成'); noModelRequests();
  });
  it('切题后上一题迟到的抓取回复不会显示到新题', async () => {
    grade(); secondQuestion(); let resolve!: (reply: RetrievalReply) => void;
    vi.mocked(api.retrieveStudyQuestion).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const store = await mount(); await click(button(host, '继续上次答题')); const pending = click(entry()); await settle();
    store.activeSession!.cursor = 1; await settle(); resolve({ cached: false, entry: retrievalEntry() }); await pending;
    expect(visibleText(host)).toContain('第二道题'); expect(visibleText(host)).not.toContain('网页原文，不是模型生成'); expect(sourceCards()).toHaveLength(0); noModelRequests();
  });
  it('只读历史切题后的迟到回复不会污染当前资料', async () => {
    grade(); secondQuestion(); let resolve!: (reply: { entries: RetrievalArchiveEntry[] }) => void;
    vi.mocked(api.loadRetrievalHistory).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const store = await mount(); await click(button(host, '继续上次答题')); const pending = click(button(host, '查看已保存网页资料')); await settle();
    store.activeSession!.cursor = 1; await settle(); resolve({ entries: [retrievalEntry()] }); await pending;
    expect(visibleText(host)).not.toContain('网页原文，不是模型生成'); expect(sourceCards()).toHaveLength(0); expect(api.retrieveStudyQuestion).not.toHaveBeenCalled();
  });
  it('预读期间切题会取消未开始的外部检索', async () => {
    grade(); secondQuestion(); let resolve!: (reply: { entries: RetrievalArchiveEntry[] }) => void;
    vi.mocked(api.loadRetrievalHistory).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const store = await mount(); await click(button(host, '继续上次答题')); const pending = click(entry()); await settle(); store.activeSession!.cursor = 1; await settle();
    resolve({ entries: [] }); await pending; expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('只读资料收起重开后旧响应不能覆盖新响应', async () => {
    grade(); let resolveFirst!: (reply: { entries: RetrievalArchiveEntry[] }) => void; let resolveSecond!: (reply: { entries: RetrievalArchiveEntry[] }) => void;
    vi.mocked(api.loadRetrievalHistory).mockImplementationOnce(() => new Promise(done => { resolveFirst = done; })).mockImplementationOnce(() => new Promise(done => { resolveSecond = done; }));
    await mount(); await click(button(host, '继续上次答题')); const first = click(button(host, '查看已保存网页资料')); await settle();
    await click(button(host, '收起网页资料')); const second = click(button(host, '查看已保存网页资料')); await settle();
    resolveFirst({ entries: [retrievalEntry({ query: '迟到搜索词' })] }); await first;
    expect(visibleText(host)).not.toContain('迟到搜索词'); expect(visibleText(host)).toContain('正在读取本机网页资料');
    resolveSecond({ entries: [retrievalEntry({ query: '新搜索词' })] }); await second; expect(visibleText(host)).toContain('新搜索词'); noModelRequests();
  });
  it('未配置时引导到固定检索设置，不发送检索或模型请求', async () => {
    grade(); data.ai.configured = false; await mount(); await click(button(host, '继续上次答题')); await click(entry());
    expect(form()).toBeDefined(); expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('设置仅有官方检索密钥，没有模型、服务切换或联网开关', async () => {
    await mount(); await click(button(host, '学习设置'));
    for (const label of ['API地址', '模型名称', '默认联网检索', '本题联网检索', '补充追问']) expect(descendants(host).some(node => node.props['aria-label'] === label)).toBe(false);
    await edit('API Key', 'fixture-key');
    vi.mocked(api.saveAiSettings).mockResolvedValue({ ...data.ai, baseUrl: 'https://api.deepseek.com/v1', mode: 'web-retrieval-only' });
    await form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(api.saveAiSettings).toHaveBeenCalledExactlyOnceWith({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'fixture-key' }); expect(field('API Key').value).toBe('');
    expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('学习备份明确说明不包含另存的网页原文', async () => {
    await mount(); await click(button(host, '学习设置'));
    expect(visibleText(host)).toContain('网页原文另存在本机资料目录，当前学习记录导出不包含网页资料');
    expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('清除密钥只保存设置，不调用生成模型或检索', async () => {
    vi.mocked(api.saveAiSettings).mockResolvedValue({ ...data.ai, configured: false }); await mount(); await click(button(host, '学习设置')); await click(button(host, '清除本机 API 密钥'));
    expect(api.saveAiSettings).toHaveBeenCalledExactlyOnceWith({ baseUrl: 'https://api.deepseek.com/v1', clearApiKey: true }); expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('未提交及进行中的模拟考试仍不显示资料入口', async () => {
    data.sessions[0].mode = 'exam'; await mount(); await click(button(host, '继续上次答题'));
    expect(hasEntry()).toBe(false); expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); expect(api.getPreparedExplanation).not.toHaveBeenCalled(); noModelRequests();
  });
  it('已有模型解析与旧历史仍可只读查看，读取不会调用模型', async () => {
    grade(); savedHistories = [savedHistory(), savedHistory({ id: 'legacy-1', provider: 'unknown', transport: 'legacy', status: 'legacy', source: 'legacy-current',
      createdAt: undefined, archivedAt: '2024-10-22T00:00:00.000Z', userAnswer: undefined, questionRevision: undefined, questionFingerprint: undefined })];
    await mount(); await click(button(host, '继续上次答题')); expect(visibleText(host)).toContain('之前的AI解析');
    await click(button(host, '查看本题解析历史')); expect(historyCards()).toHaveLength(2);
    expect(visibleText(historyCards()[1])).toContain('生成时间未记录'); expect(visibleText(historyCards()[1])).toContain('当时选择：未记录');
    await click(button(host, '刷新历史（不会调用模型）')); expect(api.loadAiHistory).toHaveBeenCalledTimes(2); expect(api.retrieveStudyQuestion).not.toHaveBeenCalled(); noModelRequests();
  });
  it('旧模型历史来源过滤与纯文本展示继续生效', async () => {
    grade(); savedHistories = [savedHistory({ text: '<script>历史纯文本</script>', sources: [{ id: 'S1', title: '安全', url: 'https://example.org' }, { id: 'S2', title: '危险', url: 'javascript:alert(1)' }] })];
    await mount(); await click(button(host, '继续上次答题')); await click(button(host, '查看本题解析历史'));
    expect(descendants(historyCards()[0]).filter(node => node.tag === 'a')).toHaveLength(1); expect(descendants(host).some(node => node.props.innerHTML)).toBe(false); noModelRequests();
  });
  it('旧历史收起与重开后先前响应不能覆盖新读取', async () => {
    grade(); let firstResolve!: (reply: { entries: AiHistoryEntry[] }) => void; let secondResolve!: (reply: { entries: AiHistoryEntry[] }) => void;
    vi.mocked(api.loadAiHistory).mockImplementationOnce(() => new Promise(done => { firstResolve = done; })).mockImplementationOnce(() => new Promise(done => { secondResolve = done; }));
    await mount(); await click(button(host, '继续上次答题')); const first = click(button(host, '查看本题解析历史')); await settle(); await click(button(host, '收起本题解析历史'));
    const second = click(button(host, '查看本题解析历史')); await settle(); firstResolve({ entries: [savedHistory({ text: '旧迟到正文' })] }); await first;
    expect(visibleText(host)).not.toContain('旧迟到正文'); secondResolve({ entries: [savedHistory({ text: '新历史正文' })] }); await second;
    expect(visibleText(host)).toContain('新历史正文'); noModelRequests();
  });
});
