import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import StudyWorkspace from '@/views/study/StudyWorkspace.vue';
import { emptyProgress, useStudyStore } from '@/store/modules/study';
import { resetStudyBridge } from '@/store/modules/studyBridge';
import * as api from '@/api/study';
import type { StudyBootstrap, StudySession } from '@/api/study/types';
import { type HostNode, hostNode, renderer, descendants, visibleText, button, click, settle } from './vue-memory-host';

vi.mock('@/api/study', () => ({
  loadStudy: vi.fn(), createStudySession: vi.fn(), updateStudySession: vi.fn(),
  updateQuestionRecordsBatch: vi.fn(), updateSessionRecordsBatch: vi.fn(), finishStudySession: vi.fn(),
  getBridgeStatus: vi.fn(), getBridgeOverview: vi.fn(), getBridgeJob: vi.fn(),
  createBridgeJob: vi.fn(), cancelBridgeJob: vi.fn(),
  getPreparedExplanation: vi.fn(), getPreanalysisStatus: vi.fn(), controlPreanalysis: vi.fn(),
  getPreanalysisSettings: vi.fn(), savePreanalysisSettings: vi.fn(),
}));
vi.mock('element-plus', () => ({
  ElMessage: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  ElMessageBox: { confirm: vi.fn().mockResolvedValue('confirm') },
}));

const time = '2026-10-21T00:00:00.000Z';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let canonical: StudyBootstrap;
let host: HostNode;
let app: ReturnType<typeof renderer.createApp> | null;

function initial(): StudyBootstrap {
  const active: StudySession = { id: 'S-1', removed: false, revision: 0, mode: 'sequential',
    questionIds: ['Q-1', 'Q-2'], answers: { 'Q-1': ['B'], 'Q-2': ['A'] }, submittedQuestionIds: [],
    createdAt: time, deadlineAt: null, status: 'active', cursor: 0 };
  return {
    questions: ['Q-1', 'Q-2'].map((id, index) => ({ id, category: '计算机网络', chapter: '基础',
      type: 'single', difficulty: '基础', stem: `管理集成测试第${index + 1}题`,
      options: [{ id: 'A', text: '正确项' }, { id: 'B', text: '错误项' }], answer: ['A'],
      explanation: `原解析${index + 1}`, knowledgePoint: '网络基础', source: '原创题' })),
    questionRecords: { 'Q-1': { removed: false, revision: 0 }, 'Q-2': { removed: false, revision: 0 } },
    progress: Object.fromEntries(['Q-1', 'Q-2'].map(id => [id, {
      ...emptyProgress(), attempts: 1, wrongCount: 1, favorite: true, note: `${id}的学习笔记`,
      aiNote: `${id}的已保存解析`,
    }])),
    sessions: [active], activeSession: active,
    ai: { configured: false, baseUrl: '', model: '', retrievalEnabled: false, retrievalAvailable: false, webUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh' },
  };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(time)); vi.resetAllMocks();
  resetStudyBridge(); setActivePinia(createPinia());
  const events = new Map<string, Set<(...args: any[]) => void>>();
  vi.stubGlobal('window', { innerWidth: 1280, setTimeout, clearTimeout,
    addEventListener(name: string, handler: (...args: any[]) => void) {
      if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(handler);
    },
    removeEventListener(name: string, handler: (...args: any[]) => void) { events.get(name)?.delete(handler); },
    dispatchEvent(event: { type: string }) { for (const handler of events.get(event.type) || []) handler(event); return true; },
  });
  vi.stubGlobal('document', { hidden: false, activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  for (const storage of ['localStorage', 'sessionStorage']) vi.stubGlobal(storage, {
    getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(),
  });
  canonical = initial(); host = hostNode('root'); app = null;
  const firstQuestion = canonical.questions[0];
  vi.mocked(api.getPreparedExplanation).mockResolvedValue({ questionId: firstQuestion.id, state: 'pending', text: '', source: '', fingerprint: 'test', questionRevision: 0,
    contentVersion: JSON.stringify([firstQuestion.id, firstQuestion.type, firstQuestion.stem, firstQuestion.options.map(o => [o.id, o.text]), [...firstQuestion.answer].sort(), firstQuestion.explanation, 0]) });
  vi.mocked(api.getPreanalysisStatus).mockResolvedValue({ status: 'idle', total: 2, completed: 0, pending: 2, failed: 0, stale: 0, currentJobId: null, message: '', batchSize: 3 });
  vi.mocked(api.getPreanalysisSettings).mockResolvedValue({ transport: 'web', configured: false, model: 'glm-4.7-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyStorage: 'none' });
  vi.mocked(api.loadStudy).mockImplementation(async () => copy(canonical));
  vi.mocked(api.getBridgeStatus).mockResolvedValue({ connected: false, version: null, lastSeenAt: null });
  vi.mocked(api.getBridgeOverview).mockResolvedValue({ activeJob: null, latestJob: null,
    serverTime: time, limits: { totalTimeoutMs: 240000, idleTimeoutMs: 120000 } });
  vi.mocked(api.updateQuestionRecordsBatch).mockImplementation(async ({ removed, items }) => {
    const records: NonNullable<StudyBootstrap['questionRecords']> = {};
    for (const { questionId } of items) {
      const current = canonical.questionRecords![questionId];
      records[questionId] = canonical.questionRecords![questionId] = { removed, revision: current.revision + 1 };
    }
    return copy({ removed, changedCount: items.length, questionRecords: records });
  });
  vi.mocked(api.updateSessionRecordsBatch).mockImplementation(async ({ removed, items }) => {
    const sessions = items.map(({ sessionId }) => {
      const current = canonical.sessions.find(session => session.id === sessionId)!;
      current.removed = removed; current.revision++;
      return current;
    });
    return copy({ removed, changedCount: items.length, sessions });
  });
  vi.mocked(api.createStudySession).mockImplementation(async options => ({
    ...copy(canonical.sessions[0]), id: `new-${options.mode}`, mode: options.mode,
    questionIds: options.questionIds || ['Q-2'], removed: false, revision: 0,
  }));
  vi.mocked(api.updateStudySession).mockImplementation(async (id, changes) => {
    const current = canonical.sessions.find(session => session.id === id)!;
    Object.assign(current, changes); return copy(current);
  });
});
afterEach(() => { app?.unmount(); resetStudyBridge(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function mount() {
  app = renderer.createApp(StudyWorkspace); app.mount(host); await settle();
  return useStudyStore();
}
async function check(label: string) {
  const node = descendants(host).find(node => node.tag === 'input' && node.props['aria-label'] === label);
  if (!node) throw new Error(`未找到字段：${label}`);
  node.checked = true; await node.props.onChange({ target: node }); await settle();
}
function hasButton(label: string) {
  return descendants(host).some(node => node.tag === 'button' && visibleText(node).includes(label));
}

describe('题库和记录管理与真实 workspace/store 的整合', () => {
  it('无题库发布版说明导入方式且不能启动空练习，重新检查后使用自有分类与难度', async () => {
    const imported = copy(canonical.questions[0]);
    imported.category = '自有科目'; imported.chapter = '自有章节'; imported.difficulty = '自定义难度';
    canonical = { ...canonical, questions: [], questionRecords: {}, progress: {}, sessions: [], activeSession: null };
    await mount();
    expect(visibleText(host)).toContain('公开版只提供项目，不附带题目');
    expect(visibleText(host)).toContain('node study/import-bank.mjs');
    expect(button(host, '开始今日练习').props.disabled).toBe(true);
    expect(button(host, '来一场模拟考试').props.disabled).toBe(true);
    expect(api.createStudySession).not.toHaveBeenCalled();
    canonical.questions = [imported];
    await click(button(host, '重新检查题库'));
    expect(visibleText(host)).not.toContain('安装自有题库');
    expect(visibleText(host)).toContain('自有章节');
    expect(visibleText(host)).not.toContain('网络协议 · 地址路由 · 传输安全');
    await click(button(host, '开始今日练习'));
    expect(visibleText(host)).toContain('自定义难度');
    expect(visibleText(host)).not.toContain('全部六个方向');
  });

  it('旧网页配置保留兼容，但工作区只显示 API 配置且无任意网页入口', async () => {
    canonical.ai.webUrl = 'https://retired-model.invalid/';
    canonical.sessions[0].submittedQuestionIds = ['Q-1'];
    const store = await mount();
    expect(store.ai.webProvider).toBe('zhipu');
    expect(store.ai.webUrl).toBe('https://chatglm.cn/main/alltoolsdetail?lang=zh');
    expect(visibleText(host)).toContain('检索未配置');
    await click(button(host, '继续上次答题'));
    expect(descendants(host).some(node => node.tag === 'a' && node.props.href === store.ai.webUrl)).toBe(false);
    await click(button(host, '学习设置'));
    expect(descendants(host).some(node => node.props['aria-label'] === '网页检索设置')).toBe(true);
    expect(visibleText(host)).not.toContain('连接此页');
    expect(descendants(host).some(node => node.props['aria-label'] === '默认回复渠道')).toBe(false);
    for (const label of ['API地址', '模型名称']) {
      const input = descendants(host).find(node => node.tag === 'input' && node.props['aria-label'] === label);
      expect(input).toBeUndefined();
    }
  });

  it('旧批量执行器入口隐藏，工作区不会读取配置或调度旧任务', async () => {
    vi.mocked(api.getPreanalysisSettings).mockResolvedValue({ transport: 'web', webDriver: 'browser-ui', configured: false,
      model: 'glm-4.7-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyStorage: 'none' });
    vi.mocked(api.getBridgeStatus).mockResolvedValue({ connected: true, provider: 'zhipu', version: '1.7.0', lastSeenAt: time,
      worker: { connected: true, provider: 'zhipu', version: '1.7.0', state: 'idle', jobId: null, message: '', lastSeenAt: time } });
    await mount(); await click(button(host, '学习设置')); await settle();
    expect(descendants(host).some(node => node.props['aria-label'] === '网页检索设置')).toBe(true);
    expect(visibleText(host)).not.toContain('网页已连接');
    await click(button(host, '题库管理'));
    expect(api.getPreanalysisSettings).not.toHaveBeenCalled();
    expect(api.getPreanalysisStatus).not.toHaveBeenCalled();
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
    expect(api.createBridgeJob).not.toHaveBeenCalled();
  });

  it('重新打开应用不轮询旧网页任务，仍保留历史兼容字段', async () => {
    canonical.ai.webProvider = 'deepseek'; canonical.ai.webUrl = 'https://untrusted.invalid/';
    const store = await mount(); await click(button(host, '学习设置'));
    expect(store.ai.webProvider).toBe('deepseek');
    expect(store.ai.webUrl).toBe('https://chat.deepseek.com/');
    expect(descendants(host).some(node => node.props['aria-label'] === '默认回复渠道')).toBe(false);
    await vi.advanceTimersByTimeAsync(6000); await settle();
    expect(api.getBridgeStatus).not.toHaveBeenCalled();
    expect(api.getBridgeOverview).not.toHaveBeenCalled();
    expect(api.createBridgeJob).not.toHaveBeenCalled();
  });

  it('扩充到2000题后仍能显示完整范围，并在发请求前限制单次题量', async () => {
    const base = canonical.questions[0];
    canonical.questions = Array.from({ length: 2000 }, (_, index) => ({ ...copy(base), id: `LARGE-${index + 1}`, stem: `大题库独立夹具${index + 1}` }));
    await mount(); await click(button(host, '题库练习'));
    expect(visibleText(host)).toContain('2000 题');
    const count = descendants(host).find(node => node.tag === 'input' && node.props['aria-label'] === '本次题量')!;
    expect(count.props.max).toBe(500);
    count.value = '501'; count.dispatchEvent({ type: 'input', target: count }); await settle();
    const start = button(host, '开始答题');
    expect(start.props.disabled).toBe(true);
    await click(start); expect(api.createStudySession).not.toHaveBeenCalled();
    count.value = '500'; count.dispatchEvent({ type: 'input', target: count }); await settle();
    expect(button(host, '开始答题').props.disabled).toBe(false);
    await click(button(host, '开始答题'));
    expect(api.createStudySession).toHaveBeenCalledWith(expect.objectContaining({ count: 500 }));
  });

  it('题库删除不再进入错题/收藏组题，旧内容仍能研究且返回题库管理', async () => {
    const store = await mount();
    await click(button(host, '题库管理'));
    await check('选择题目 Q-1');
    await click(button(host, '删除选中题目'));
    expect(api.updateQuestionRecordsBatch).toHaveBeenCalledWith({ removed: true,
      items: [{ questionId: 'Q-1', expected: { removed: false, revision: 0 } }] });
    expect(store.questions.map(q => q.id)).toEqual(['Q-1', 'Q-2']);
    expect(store.progress['Q-1']).toMatchObject({ note: 'Q-1的学习笔记', aiNote: 'Q-1的已保存解析' });
    await click(button(host, '已删除'));
    await click(button(host, '研究题目 Q-1'));
    expect(visibleText(host)).toContain('管理集成测试第1题');
    await click(button(host, '返回题库管理'));
    expect(descendants(host).some(node => node.props['aria-label'] === '题库管理')).toBe(true);

    await click(button(host, '错题研究'));
    expect(visibleText(host)).not.toContain('管理集成测试第1题');
    await click(button(host, '重练待巩固错题'));
    expect(api.createStudySession).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'wrong', questionIds: ['Q-2'] }));
    await click(button(host, '我的收藏'));
    expect(visibleText(host)).not.toContain('管理集成测试第1题');
    await click(button(host, '练习这些收藏'));
    expect(api.createStudySession).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'favorites', questionIds: ['Q-2'] }));
  });

  it('当前记录删除后给出唯一返回入口，恢复不重置期限且过期考试只自动交卷一次', async () => {
    canonical.sessions[0].mode = 'exam'; canonical.sessions[0].deadlineAt = '2026-10-21T00:00:05.000Z';
    canonical.activeSession = canonical.sessions[0];
    vi.mocked(api.finishStudySession).mockImplementation(async id => {
      const completed = canonical.sessions.find(session => session.id === id)!;
      Object.assign(completed, { status: 'completed', score: 50, correctCount: 1, submittedQuestionIds: ['Q-1', 'Q-2'] });
      canonical.activeSession = null;
      return copy({ session: completed, results: [], progress: canonical.progress });
    });
    const store = await mount();
    await click(button(host, '继续上次答题'));
    await store.removeSessionRecords(['S-1']); await settle();
    expect(store.activeSession).toBeNull();
    expect(visibleText(host)).toContain('这条记录暂不可继续');
    expect(visibleText(host)).not.toContain('选择一份练习，开始答题');
    await click(button(host, '查看学习记录'));
    await click(button(host, '学习概览'));
    expect(hasButton('继续上次答题')).toBe(false);
    await vi.advanceTimersByTimeAsync(6000); await settle();
    expect(api.finishStudySession).not.toHaveBeenCalled();

    await click(button(host, '学习记录'));
    await click(button(host, '已删除'));
    await check('选择记录 S-1');
    await click(button(host, '恢复选中记录'));
    expect(store.sessions[0]).toMatchObject({ removed: false, deadlineAt: '2026-10-21T00:00:05.000Z' });
    await click(button(host, '正常记录'));
    await click(button(host, '继续答题'));
    await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(api.finishStudySession).toHaveBeenCalledTimes(1);
    expect(visibleText(host)).toContain('正确率 50%');
    await vi.advanceTimersByTimeAsync(3000); await settle();
    expect(api.finishStudySession).toHaveBeenCalledTimes(1);
    await click(button(host, '返回学习记录'));
    expect(descendants(host).some(node => node.props['aria-label'] === '答题记录管理')).toBe(true);
  });

  it('复盘B被其他页面删除后保持阻断，不把进行中的A呈现为当前可操作内容', async () => {
    const active = canonical.sessions[0];
    active.questionIds = ['Q-1']; active.answers = {}; active.submittedQuestionIds = [];
    const reviewed: StudySession = { ...copy(active), id: 'S-B', questionIds: ['Q-2'],
      answers: { 'Q-2': ['A'] }, submittedQuestionIds: ['Q-2'], status: 'completed', score: 100, correctCount: 1 };
    canonical.sessions.push(reviewed);
    const store = await mount();
    await click(button(host, '学习记录'));
    await click(button(host, '打开记录 S-B'));
    expect(visibleText(host)).toContain('管理集成测试第2题');
    expect(visibleText(host)).toContain('正确率 100%');

    reviewed.removed = true; reviewed.revision++;
    await store.refreshProgress(); await settle();
    expect(store.activeSession?.id).toBe('S-1');
    expect(store.currentSession?.id).toBe('S-1');
    expect(visibleText(host)).toContain('这条记录暂不可继续');
    expect(visibleText(host)).not.toContain('管理集成测试第1题');
    expect(hasButton('提交答案')).toBe(false);
    expect(hasButton('结束并交卷')).toBe(false);
    expect(descendants(host).some(node => node.props.class?.includes?.('option'))).toBe(false);
    expect(api.updateStudySession).not.toHaveBeenCalled();
    expect(api.finishStudySession).not.toHaveBeenCalled();

    await click(button(host, '查看学习记录'));
    await click(button(host, '打开记录 S-1'));
    expect(visibleText(host)).toContain('管理集成测试第1题');
    expect(visibleText(host)).not.toContain('这条记录暂不可继续');
  });
});
