import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import StudyWorkspace from '@/views/study/StudyWorkspace.vue';
import { emptyProgress, useStudyStore } from '@/store/modules/study';
import * as api from '@/api/study';
import type { AiExplanation, StudyBootstrap, StudySession } from '@/api/study/types';
import { type HostNode, hostNode, renderer, descendants, visibleText, button, click, settle } from './vue-memory-host';

vi.mock('@/api/study', () => ({
  loadStudy: vi.fn(), checkStudyQuestion: vi.fn(), finishStudySession: vi.fn(), updateStudySession: vi.fn(),
  getBridgeStatus: vi.fn(), getBridgeOverview: vi.fn(), getBridgeJob: vi.fn(), createBridgeJob: vi.fn(), cancelBridgeJob: vi.fn(),
  getPreparedExplanation: vi.fn(), getPreanalysisStatus: vi.fn(), controlPreanalysis: vi.fn(),
  getPreanalysisSettings: vi.fn(), savePreanalysisSettings: vi.fn(), explainStudyQuestion: vi.fn(), saveAiSettings: vi.fn(),
}));
vi.mock('element-plus', () => ({ ElMessage: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  ElMessageBox: { confirm: vi.fn().mockResolvedValue('confirm') } }));
const time = '2026-10-22T00:00:00.000Z';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const preparedVersion = (q: StudyBootstrap['questions'][number]) => ({ questionRevision: q.answerRevision ?? 0,
  contentVersion: JSON.stringify([q.id, q.type, q.stem, q.options.map(o => [o.id, o.text]), [...q.answer].sort(), q.explanation, q.answerRevision ?? 0]) });
let data: StudyBootstrap;
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
  data = initial(); host = hostNode('root'); app = null;
  vi.mocked(api.loadStudy).mockImplementation(async () => copy(data));
  vi.mocked(api.checkStudyQuestion).mockImplementation(async () => { grade(); return copy({ session: data.sessions[0], correct: true, answer: ['A'], explanation: '原始理论解析', questionRevision: 0, progress: data.progress['Q-1'] }); });
  vi.mocked(api.explainStudyQuestion).mockImplementation(async ({ questionId }) => ({ text: data.progress[questionId].aiNote }));
  vi.mocked(api.getPreparedExplanation).mockResolvedValue({ ...preparedVersion(data.questions[0]), questionId: 'Q-1', state: 'pending', text: '', source: '', fingerprint: 'test' });
});
afterEach(() => { app?.unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function mount() { app = renderer.createApp(StudyWorkspace); app.mount(host); await settle(); return useStudyStore(); }
function entry() { return button(host, 'AI 解析这道题'); }
function hasEntry() { return descendants(host).some(node => node.tag === 'button' && node.props['aria-label'] === 'AI 解析这道题'); }
function bottomEntry() {
  const result = descendants(host).find(node => node.tag === 'button' && node.props['aria-label'] !== 'AI 解析这道题' && visibleText(node).includes('✦ AI 解析'));
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

describe('按需模型 API 解析', () => {
  it('页面与设置不调用模型或旧网页调度', async () => {
    grade(); await mount(); await click(button(host, '继续上次答题')); await vi.advanceTimersByTimeAsync(6000); await settle();
    expect(descendants(host).some(node => ['本题回复渠道', '默认回复渠道'].includes(node.props['aria-label']))).toBe(false);
    expect(api.getBridgeStatus).not.toHaveBeenCalled(); expect(api.getBridgeOverview).not.toHaveBeenCalled();
    expect(api.createBridgeJob).not.toHaveBeenCalled(); expect(api.explainStudyQuestion).not.toHaveBeenCalled();
    await click(button(host, '学习设置')); expect(form()).toBeDefined(); expect(api.explainStudyQuestion).not.toHaveBeenCalled();
  });
  it('未配置时进入设置，不发送请求', async () => {
    grade(); data.ai.configured = false; await mount(); await click(button(host, '继续上次答题')); await click(entry());
    expect(form()).toBeDefined(); expect(api.explainStudyQuestion).not.toHaveBeenCalled();
  });
  it('只发送当前题、作答、追问、标准版本与联网选择，保存后重读结果', async () => {
    grade(); vi.mocked(api.explainStudyQuestion).mockImplementation(async () => { data.progress['Q-1'].aiNote = 'API 完整回复已经保存'; return { text: data.progress['Q-1'].aiNote }; });
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    expect(api.explainStudyQuestion).toHaveBeenCalledExactlyOnceWith({ questionId: 'Q-1', answer: ['A'], question: '', expectedQuestionRevision: 0, retrievalEnabled: false });
    expect(api.createBridgeJob).not.toHaveBeenCalled(); expect(visibleText(host)).toContain('API 完整回复已经保存');
  });
  it('失败保留旧解析并先重读未确认结果，避免无意重复计费', async () => {
    grade(); vi.mocked(api.explainStudyQuestion).mockRejectedValue(new Error('模型服务暂不可用'));
    await mount(); await click(button(host, '继续上次答题')); await click(entry());
    expect(visibleText(host)).toContain('模型服务暂不可用'); expect(visibleText(host)).toContain('之前的AI解析'); expect(visibleText(entry())).toBe('读取已保存解析');
    await click(entry()); expect(api.explainStudyQuestion).toHaveBeenCalledTimes(1); expect(visibleText(host)).toContain('重新发起可能再次调用或计费');
  });
  it('API 已保存而刷新失败时保留确认正文，两个入口只重读结果', async () => {
    grade(); vi.mocked(api.explainStudyQuestion).mockImplementation(async () => { data.progress['Q-1'].aiNote = 'API 已确认保存的新正文'; return { text: data.progress['Q-1'].aiNote }; });
    await mount(); await click(button(host, '继续上次答题')); vi.mocked(api.loadStudy).mockRejectedValueOnce(new Error('刷新中断')); await click(entry());
    expect(visibleText(host)).toContain('API 已确认保存的新正文'); expect(visibleText(host)).toContain('API 解析已保存，读取本机结果暂未完成');
    vi.mocked(api.loadStudy).mockRejectedValueOnce(new Error('仍离线')); await click(entry()); expect(api.explainStudyQuestion).toHaveBeenCalledTimes(1);
    await click(button(host, '刷新已保存解析')); expect(api.explainStudyQuestion).toHaveBeenCalledTimes(1); expect(visibleText(host)).not.toContain('读取本机结果暂未完成');
  });
  it('标准冲突重读结果并保持旧正文', async () => {
    grade(); data.questions[0].answerRevision = 4; vi.mocked(api.explainStudyQuestion).mockRejectedValue(Object.assign(new Error('标准版本已变更'), { status: 409 }));
    await mount(); await click(button(host, '继续上次答题')); const loads = vi.mocked(api.loadStudy).mock.calls.length; await click(entry());
    expect(api.explainStudyQuestion).toHaveBeenCalledWith(expect.objectContaining({ expectedQuestionRevision: 4 }));
    expect(api.loadStudy).toHaveBeenCalledTimes(loads + 1); expect(visibleText(host)).toContain('标准版本已变更'); expect(visibleText(host)).toContain('之前的AI解析');
  });
  it('后端没有联网能力时开关禁用，强制事件也不能开启', async () => {
    grade(); data.ai.retrievalEnabled = true; await mount(); await click(button(host, '继续上次答题'));
    expect(field('本题联网检索').props.disabled).toBe(true); await toggle('本题联网检索'); await click(entry());
    expect(api.explainStudyQuestion).toHaveBeenCalledWith(expect.objectContaining({ retrievalEnabled: false }));
  });
  it('联网按本题主动选择，来源只显示安全链接且元数据不会错配新正文', async () => {
    grade(); data.ai.retrievalAvailable = true;
    vi.mocked(api.explainStudyQuestion).mockImplementation(async () => { const text = '<script>不会执行</script>正文'; data.progress['Q-1'].aiNote = text; return { text, sources: [
      { id: '1', title: '<b>来源标题</b>', url: 'https://example.org/article' }, { id: '2', title: '脚本', url: 'javascript:alert(1)' },
      { id: '3', title: '嵌入内容', url: 'data:text/html,test' }, { id: '4', title: '凭据地址', url: 'https://user:pass@example.org/' },
    ], retrieval: { searchCalls: 1, fetchCalls: 2, estimatedCostCny: 0.015 } }; });
    const store = await mount(); await click(button(host, '继续上次答题')); expect(field('本题联网检索').checked).toBe(false); await toggle('本题联网检索'); await click(entry());
    expect(api.explainStudyQuestion).toHaveBeenCalledWith(expect.objectContaining({ retrievalEnabled: true }));
    const links = descendants(host).filter(node => node.tag === 'a' && node.props.href === 'https://example.org/article');
    expect(links).toHaveLength(1); expect(links[0].props).toMatchObject({ target: '_blank', rel: 'noopener noreferrer' });
    expect(descendants(host).some(node => node.props.innerHTML)).toBe(false); expect(visibleText(host)).not.toContain('凭据地址'); expect(visibleText(host)).toContain('0.015 元');
    store.progress['Q-1'].aiNote = '另一页面更新正文'; await settle(); expect(descendants(host).some(node => node.props.href === 'https://example.org/article')).toBe(false);
  });
  it('默认联网设置生效且本题可关闭', async () => {
    grade(); data.ai.retrievalAvailable = true; data.ai.retrievalEnabled = true; await mount(); await click(button(host, '继续上次答题'));
    expect(field('本题联网检索').checked).toBe(true); await toggle('本题联网检索', false); await click(entry()); expect(api.explainStudyQuestion).toHaveBeenCalledWith(expect.objectContaining({ retrievalEnabled: false }));
  });
  it('DeepSeek 快捷配置不调用模型，成功保存清空密钥草稿', async () => {
    data.ai.configured = false; await mount(); await click(button(host, '学习设置')); await edit('API Key', 'draft-key'); await click(button(host, '使用 DeepSeek 官方 API'));
    expect(field('API地址').value).toBe('https://api.deepseek.com/v1'); expect(field('模型名称').value).toBe('deepseek-flash'); expect(field('API Key').value).toBe('');
    expect(api.saveAiSettings).not.toHaveBeenCalled(); expect(api.explainStudyQuestion).not.toHaveBeenCalled();
    expect(field('默认联网检索').props.disabled).toBe(false); await toggle('默认联网检索'); await edit('API Key', 'new-test-key');
    vi.mocked(api.saveAiSettings).mockResolvedValue({ ...data.ai, configured: true, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', retrievalAvailable: true, retrievalEnabled: true });
    await form().props.onSubmit({ preventDefault() {} }); await settle();
    expect(api.saveAiSettings).toHaveBeenCalledExactlyOnceWith({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'new-test-key', retrievalEnabled: true }); expect(field('API Key').value).toBe('');
  });
  it('保存失败保留草稿和新密钥', async () => {
    await mount(); await click(button(host, '学习设置')); await edit('API Key', 'retry-test-key'); vi.mocked(api.saveAiSettings).mockRejectedValue(new Error('offline'));
    await form().props.onSubmit({ preventDefault() {} }); await settle(); expect(field('API Key').value).toBe('retry-test-key');
  });
  it('保存配置期间两个入口和调用守卫阻止使用旧配置', async () => {
    grade(); let resolve!: (settings: StudyBootstrap['ai']) => void; vi.mocked(api.saveAiSettings).mockImplementation(() => new Promise(done => { resolve = done; }));
    await mount(); await click(button(host, '学习设置')); const saving = form().props.onSubmit({ preventDefault() {} }); await settle();
    await click(button(host, '学习概览')); await click(button(host, '继续上次答题')); expect(entry().props.disabled).toBe(true); await entry().props.onClick(); expect(api.explainStudyQuestion).not.toHaveBeenCalled();
    resolve(data.ai); await saving; await settle(); expect(entry().props.disabled).toBe(false);
  });
  it('练习答对后解析不重复判分或更改记录', async () => {
    const store = await mount(); await click(button(host, '继续上次答题')); expect(hasEntry()).toBe(false); await click(button(host, '提交答案'));
    expect(visibleText(host)).toContain('✓ 回答正确'); expect(hasEntry()).toBe(true); const saved = copy({ sessions: store.sessions, progress: store.progress }); await click(entry());
    expect(api.explainStudyQuestion).toHaveBeenCalledWith(expect.objectContaining({ questionId: 'Q-1', answer: ['A'], question: '' })); expect(api.checkStudyQuestion).toHaveBeenCalledTimes(1);
    expect(copy({ sessions: store.sessions, progress: store.progress })).toEqual(saved); assertOnlyAnalysis();
  });
  it('已完成考试正确题可解析并保留100分及判分快照', async () => {
    data.sessions[0].mode = 'exam'; grade('completed'); const store = await mount(); await click(button(host, '学习记录')); await click(button(host, '打开记录 S-1')); expect(visibleText(host)).toContain('正确率 100%');
    const saved = copy(store.sessions[0]); await click(entry()); expect(api.explainStudyQuestion).toHaveBeenCalledWith(expect.objectContaining({ questionId: 'Q-1', answer: ['A'] }));
    expect(copy(store.sessions[0])).toEqual(saved); expect(api.checkStudyQuestion).not.toHaveBeenCalled(); assertOnlyAnalysis();
  });
  it('学习记录可追问，私有笔记及其他历史不进入请求', async () => {
    grade(); const store = await mount(); await click(button(host, '学习记录')); await click(button(host, '打开记录 S-1'));
    expect(Number(field('补充追问').props.maxlength)).toBe(1500); await edit('补充追问', '解释概念区别'); const saved = copy(store.progress); await click(entry());
    expect(api.explainStudyQuestion).toHaveBeenCalledExactlyOnceWith({ questionId: 'Q-1', answer: ['A'], question: '解释概念区别', expectedQuestionRevision: 0, retrievalEnabled: false });
    expect(copy(store.progress)).toEqual(saved); expect(api.checkStudyQuestion).not.toHaveBeenCalled(); assertOnlyAnalysis();
  });
  it('绕过输入限制的超长追问也不会发送', async () => {
    grade(); await mount(); await click(button(host, '继续上次答题')); await edit('补充追问', '字'.repeat(1501)); await click(entry()); expect(api.explainStudyQuestion).not.toHaveBeenCalled();
  });
  it('题库研究最后答对的题也可解析', async () => {
    const store = await mount(); await click(button(host, '题库管理')); await click(button(host, '研究题目 Q-1')); expect(visibleText(host)).toContain('✓ 回答正确'); await click(entry());
    expect(api.explainStudyQuestion).toHaveBeenCalledWith(expect.objectContaining({ questionId: 'Q-1', answer: ['A'] })); expect(store.progress['Q-1'].lastCorrect).toBe(true); expect(api.checkStudyQuestion).not.toHaveBeenCalled(); assertOnlyAnalysis();
  });
  it('考试未交卷时不显示解析入口或请求通用讲解', async () => {
    data.sessions[0].mode = 'exam'; data.sessions[0].deadlineAt = '2026-10-22T00:30:00.000Z'; await mount(); await click(button(host, '继续上次答题'));
    expect(visibleText(host)).toContain('整卷提交后查看解析'); expect(hasEntry()).toBe(false); expect(api.explainStudyQuestion).not.toHaveBeenCalled(); expect(api.getPreparedExplanation).not.toHaveBeenCalled(); assertOnlyAnalysis();
  });
  it('生成期间通用讲解仍可读，两个入口共同防连点', async () => {
    grade(); let resolve!: (reply: AiExplanation) => void; vi.mocked(api.explainStudyQuestion).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    vi.mocked(api.getPreparedExplanation).mockResolvedValue({ ...preparedVersion(data.questions[0]), questionId: 'Q-1', state: 'ready', text: '已保存通用讲解不会被个人回复替换。', source: '历史解析', fingerprint: 'test', generatedAt: time });
    const store = await mount(); await click(button(host, '继续上次答题')); const saved = copy({ sessions: store.sessions, progress: store.progress }); const first = entry(), bottom = bottomEntry();
    const pending = click(first); await settle(); expect(entry().props.disabled).toBe(true); expect(bottom.props.disabled).toBe(true); expect(visibleText(host)).toContain('已保存通用讲解不会被个人回复替换');
    await first.props.onClick(); await bottom.props.onClick(); await settle(); expect(api.explainStudyQuestion).toHaveBeenCalledTimes(1); resolve({ text: data.progress['Q-1'].aiNote }); await pending;
    expect(entry().props.disabled).toBe(false); expect(copy({ sessions: store.sessions, progress: store.progress })).toEqual(saved); assertOnlyAnalysis();
  });
  it('底部按钮仍支持正确题', async () => {
    grade(); await mount(); await click(button(host, '继续上次答题')); await click(bottomEntry()); expect(api.explainStudyQuestion).toHaveBeenCalledWith(expect.objectContaining({ questionId: 'Q-1', answer: ['A'] })); expect(api.checkStudyQuestion).not.toHaveBeenCalled(); assertOnlyAnalysis();
  });
});
