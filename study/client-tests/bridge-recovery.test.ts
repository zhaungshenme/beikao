import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, onMounted, reactive } from 'vue';
import { type HostNode, hostNode, renderer, visibleText, button, click, settle, descendants } from './vue-memory-host';
import StudyWorkspace from '@/views/study/StudyWorkspace.vue';
import { resetStudyBridge, useStudyBridge } from '@/store/modules/studyBridge';

const api = vi.hoisted(() => ({
  getBridgeStatus: vi.fn(),
  getPendingBridgeJobs: vi.fn(),
  createBridgeJob: vi.fn(),
  getBridgeJob: vi.fn(),
  getBridgeOverview: vi.fn(),
  cancelBridgeJob: vi.fn(),
  getPreanalysisSettings: vi.fn(), savePreanalysisSettings: vi.fn(),
}));
const storeSlot = vi.hoisted(() => ({ current: null as any }));

vi.mock('@/api/study', () => api);
vi.mock('@/store/modules/study', () => ({
  useStudyStore: () => storeSlot.current,
  emptyProgress: () => ({ attempts: 0, correctCount: 0, wrongCount: 0, lastAnswer: [], lastCorrect: null,
    lastAnsweredAt: null, mastered: false, favorite: false, note: '', reason: '', aiNote: '' }),
}));
vi.mock('element-plus', () => ({
  ElMessage: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  ElMessageBox: { confirm: vi.fn().mockResolvedValue('confirm') },
}));

const questions = [
  { id: 'Q-1', category: '计算机网络', chapter: '基础', type: 'single', difficulty: '基础', stem: '第一题题干',
    options: [{ id: 'A', text: '正确项' }, { id: 'B', text: '错误项' }], answer: ['A'], explanation: '第一题原解析', knowledgePoint: '知识点一', source: '原创题' },
  { id: 'Q-2', category: '计算机网络', chapter: '基础', type: 'single', difficulty: '基础', stem: '第二题题干',
    options: [{ id: 'A', text: '正确项' }, { id: 'B', text: '错误项' }], answer: ['A'], explanation: '第二题原解析', knowledgePoint: '知识点二', source: '原创题' },
];
const finalText = 'Q-1 专属最终 AI 解析，不能显示在第二题。';
const pendingJob = { id: 'job-1', questionId: 'Q-1', status: 'queued', prompt: '测试题目', createdAt: '2026-10-21T00:00:00.000Z' };

function fakeStore() {
  const session = reactive({ id: 'session-1', mode: 'sequential', questionIds: ['Q-1', 'Q-2'],
    answers: { 'Q-1': ['B'], 'Q-2': ['B'] } as Record<string, string[]>, submittedQuestionIds: ['Q-1', 'Q-2'],
    status: 'active', cursor: 0, createdAt: '2026-10-21T00:00:00.000Z', deadlineAt: null, score: 0, correctCount: 0 });
  const state = reactive({
    loaded: true, error: '', busy: false, saveState: 'saved', questions,
    questionMap: { 'Q-1': questions[0], 'Q-2': questions[1] } as Record<string, any>,
    progress: { 'Q-1': { aiNote: '', lastAnswer: ['B'], note: '', reason: '' },
      'Q-2': { aiNote: '', lastAnswer: ['B'], note: '', reason: '' } } as Record<string, any>,
    sessions: [session], currentSession: session, categories: ['计算机网络'],
    wrongQuestions: [] as any[], favoriteQuestions: [] as any[],
    ai: { configured: false, baseUrl: '', model: '', retrievalEnabled: false, retrievalAvailable: false, webUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh' },
    get activeSession() { return this.currentSession.status === 'active' ? this.currentSession : null; },
    get currentQuestion() { return this.questionMap[this.currentSession.questionIds[this.currentSession.cursor]]; },
    bootstrap: vi.fn(async () => {}),
    refreshProgress: vi.fn(async () => { state.progress['Q-1'].aiNote = finalText; }),
    patchProgress: vi.fn(async (id: string, changes: any, _expected?: any) => {
      Object.assign(state.progress[id], changes);
      return { ...state.progress[id] };
    }),
    startSession: vi.fn(async () => session),
    resume: vi.fn(), resumeSession: vi.fn(),
    navigate: vi.fn(async (index: number) => { session.cursor = index; }),
  });
  return state;
}

let host: HostNode;
let app: ReturnType<typeof renderer.createApp> | null;
let events: Map<string, Set<(...args: any[]) => void>>;
let remoteJob: any;
let historicalBridge: ReturnType<typeof useStudyBridge>;
const historicalView = reactive({ page: 'answer', questionId: 'Q-1' });
const overview = () => ({ activeJob: remoteJob && !['completed', 'failed'].includes(remoteJob.status) ? { ...remoteJob } : null,
  latestJob: remoteJob && ['completed', 'failed'].includes(remoteJob.status) ? { ...remoteJob } : null,
  serverTime: new Date().toISOString(), limits: { totalTimeoutMs: 240000, idleTimeoutMs: 120000 } });
function completeRemote() { remoteJob = { ...pendingJob, status: 'completed', text: finalText }; }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
  resetStudyBridge();
  vi.resetAllMocks();
  events = new Map();
  (globalThis as any).window = {
    innerWidth: 1280, setTimeout, clearTimeout,
    addEventListener(name: string, handler: (...args: any[]) => void) {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name)!.add(handler);
    },
    removeEventListener(name: string, handler: (...args: any[]) => void) { events.get(name)?.delete(handler); },
    dispatchEvent(event: { type: string }) { for (const handler of events.get(event.type) || []) handler(event); return true; },
  };
  (globalThis as any).document = { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), activeElement: null };
  (globalThis as any).localStorage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  const stored = new Map<string, string>();
  (globalThis as any).sessionStorage = {
    getItem: vi.fn((key: string) => stored.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { stored.set(key, value); }),
    removeItem: vi.fn((key: string) => { stored.delete(key); }),
  };
  (globalThis as any).CustomEvent = class { constructor(public type: string, public options?: any) {} };
  storeSlot.current = fakeStore();
  Object.assign(historicalView, { page: 'answer', questionId: 'Q-1' });
  api.getBridgeStatus.mockResolvedValue({ connected: true, version: '1.2.0', worker: { connected: true, state: 'idle', jobId: null, message: '就绪', lastSeenAt: new Date().toISOString() } });
  api.getPendingBridgeJobs.mockResolvedValue({ jobs: [] });
  api.getPreanalysisSettings.mockResolvedValue({ transport: 'web', configured: false, model: 'glm-4.7-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyStorage: 'none' });
  remoteJob = null;
  api.getBridgeOverview.mockImplementation(async () => overview());
  api.createBridgeJob.mockImplementation(async () => { remoteJob = { ...pendingJob }; return { ...remoteJob }; });
  api.getBridgeJob.mockResolvedValue({ ...pendingJob, status: 'completed', text: finalText });
  api.cancelBridgeJob.mockImplementation(async () => { remoteJob = { ...remoteJob, status: 'failed', failureCode: 'cancelled', error: '本轮等待已结束，原解析保留。' }; return { ...remoteJob }; });
  host = hostNode('root');
  app = null;
});
afterEach(() => { app?.unmount(); resetStudyBridge(); vi.useRealTimers(); });

async function mountWorkspace() {
  app = renderer.createApp(StudyWorkspace);
  app.mount(host);
  await settle();
  return host;
}
async function startQ1Job() {
  await click(button(host, '发起历史任务'));
  expect(api.createBridgeJob).toHaveBeenCalledTimes(1);
}
// The retired controller remains testable without restoring its production UI.
// Its lifetime belongs to the application, so unmounting a consumer does not dispose it.
async function mountHistoricalBridge() {
  const wrapper = defineComponent({ setup() {
    historicalBridge = useStudyBridge({
      getSavedText: id => storeSlot.current.progress[id]?.aiNote || '',
      syncProgress: () => storeSlot.current.refreshProgress(),
    });
    onMounted(() => historicalBridge.start());
    return () => h('main', [
      h('button', { onClick: () => historicalBridge.request({ questionId: 'Q-1', answer: ['B'], question: '' }), disabled: historicalBridge.active.value || historicalBridge.requesting.value }, '发起历史任务'),
      h('button', { onClick: () => { historicalView.page = 'settings'; } }, '学习设置'),
      h('button', { onClick: () => { historicalView.page = 'answer'; } }, '返回题目'),
      h('button', { onClick: () => { historicalView.questionId = 'Q-1'; } }, '第1题'),
      h('button', { onClick: () => { historicalView.questionId = 'Q-2'; } }, '第2题'),
      h('button', { onClick: () => historicalBridge.cancel(), disabled: !historicalBridge.active.value }, '结束历史等待'),
      h('p', historicalBridge.healthMessage.value),
      historicalView.page === 'answer' ? h('section', [
        h('h2', storeSlot.current.questionMap[historicalView.questionId].stem),
        h('p', storeSlot.current.progress[historicalView.questionId].aiNote),
        historicalBridge.job.value?.questionId === historicalView.questionId ? h('p', historicalBridge.job.value.text || '') : null,
      ]) : h('p', '历史消费者设置视图'),
    ]);
  } });
  app = renderer.createApp(wrapper); app.mount(host); await settle(); return host;
}
function noteField() {
  const field = descendants(host).find(node => node.tag === 'textarea' && node.props['aria-label'] === '学习笔记');
  if (!field) throw new Error('未找到学习笔记输入框');
  return field;
}
async function typeNote(value: string) {
  const field = noteField();
  field.value = value;
  field.dispatchEvent({ type: 'input', target: field } as any);
  await settle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe('笔记草稿与保存基线的真实组件行为', () => {
  it('已有草稿遇到新快照时，保存仍使用草稿载入的旧基线且只提交改动字段', async () => {
    Object.assign(storeSlot.current.progress['Q-1'], { note: '载入基线 S0', reason: '概念不清' });
    await mountWorkspace();
    await click(button(host, '继续上次答题'));
    expect(noteField().value).toBe('载入基线 S0');
    await typeNote('我编辑的草稿');

    Object.assign(storeSlot.current.progress['Q-1'], { note: '另一客户端保存的 S1', reason: '审题疏漏' });
    await settle();
    expect(noteField().value).toBe('我编辑的草稿');
    await click(button(host, '保存笔记'));

    expect(storeSlot.current.patchProgress).toHaveBeenCalledWith('Q-1', { note: '我编辑的草稿' }, { note: '载入基线 S0' });
    expect(storeSlot.current.progress['Q-1'].reason).toBe('审题疏漏');
  });

  it('保存期间继续输入时，只确认已发送内容并保留后续编辑与下一次基线', async () => {
    storeSlot.current.progress['Q-1'].note = '保存前基线';
    await mountWorkspace();
    await click(button(host, '继续上次答题'));
    await typeNote('本次发送的内容');
    const held = deferred<any>();
    storeSlot.current.patchProgress.mockReturnValueOnce(held.promise);
    const saving = click(button(host, '保存笔记'));
    await settle();
    expect(storeSlot.current.patchProgress).toHaveBeenNthCalledWith(1, 'Q-1', { note: '本次发送的内容' }, { note: '保存前基线' });

    await typeNote('等待响应期间继续编辑的内容');
    storeSlot.current.progress['Q-1'].note = '本次发送的内容';
    held.resolve({ ...storeSlot.current.progress['Q-1'] });
    await saving;
    expect(noteField().value).toBe('等待响应期间继续编辑的内容');
    await click(button(host, '保存笔记'));

    expect(storeSlot.current.patchProgress).toHaveBeenNthCalledWith(2, 'Q-1', { note: '等待响应期间继续编辑的内容' }, { note: '本次发送的内容' });
  });

  it.each(['', '非空的原始内容'])('保存期间将笔记改回原基线 %j 时，不得被保存响应覆盖', async initial => {
    storeSlot.current.progress['Q-1'].note = initial;
    await mountWorkspace();
    await click(button(host, '继续上次答题'));
    await typeNote('本次已发送但尚未确认的内容');
    const held = deferred<any>();
    storeSlot.current.patchProgress.mockReturnValueOnce(held.promise);
    const saving = click(button(host, '保存笔记'));
    await settle();

    await typeNote(initial);
    storeSlot.current.progress['Q-1'].note = '本次已发送但尚未确认的内容';
    held.resolve({ ...storeSlot.current.progress['Q-1'] });
    await saving;

    expect(noteField().value).toBe(initial);
    expect(visibleText(host)).toContain('有未保存修改');
    await click(button(host, '保存笔记'));
    expect(storeSlot.current.patchProgress).toHaveBeenNthCalledWith(2, 'Q-1', { note: initial }, { note: '本次已发送但尚未确认的内容' });
  });

  it.each(['确认后新输入、尚未授权放弃的内容', '确认放弃的旧草稿'])('确认载入后仍在等待读取时，编辑为 %j 的草稿不能被读取结果替换', async edited => {
    storeSlot.current.progress['Q-1'].note = '载入前旧基线';
    await mountWorkspace();
    await click(button(host, '继续上次答题'));
    await typeNote('确认放弃的旧草稿');
    storeSlot.current.progress['Q-1'].note = '另一页面已保存内容';
    await settle();
    const held = deferred<void>();
    storeSlot.current.refreshProgress.mockReturnValueOnce(held.promise);
    const loading = click(button(host, '载入已保存版本'));
    await settle();

    await typeNote('载入期间的中间输入');
    await typeNote(edited);
    held.resolve();
    await loading;

    expect(noteField().value).toBe(edited);
    expect(visibleText(host)).toContain('草稿');
    await click(button(host, '保存笔记'));
    expect(storeSlot.current.patchProgress).toHaveBeenCalledWith('Q-1', { note: edited }, { note: '载入前旧基线' });
  });

  it('保存中改回旧基线并刷新时，保留草稿并只确认服务器已有的 pending payload', async () => {
    storeSlot.current.progress['Q-1'].note = '原始已保存内容';
    await mountWorkspace();
    await click(button(host, '继续上次答题'));
    await typeNote('刷新前已发送的内容');
    const held = deferred<any>();
    storeSlot.current.patchProgress.mockReturnValueOnce(held.promise);
    const saving = click(button(host, '保存笔记'));
    await settle();
    await typeNote('原始已保存内容');

    const persisted = JSON.parse(sessionStorage.getItem('yankao-note-drafts-v1') || '{}');
    expect(persisted['Q-1']).toMatchObject({ note: '原始已保存内容', pending: { note: '刷新前已发送的内容' } });
    app!.unmount(); app = null; host = hostNode('root');
    storeSlot.current.progress['Q-1'].note = '刷新前已发送的内容';
    await mountWorkspace();
    await click(button(host, '继续上次答题'));

    expect(noteField().value).toBe('原始已保存内容');
    expect(visibleText(host)).toContain('有未保存修改');
    await click(button(host, '保存笔记'));
    expect(storeSlot.current.patchProgress).toHaveBeenNthCalledWith(2, 'Q-1', { note: '原始已保存内容' }, { note: '刷新前已发送的内容' });
    held.resolve({ ...storeSlot.current.progress['Q-1'] });
    await saving;
  });

  it('刷新后 pending payload 尚未被服务器确认时，保留草稿并暂停自动重绑与写入', async () => {
    sessionStorage.setItem('yankao-note-drafts-v1', JSON.stringify({ 'Q-1': {
      note: '', reason: '', baseNote: '', baseReason: '', pending: { note: '结果尚未确认的已发送正文' },
    } }));
    await mountWorkspace();
    await click(button(host, '继续上次答题'));
    expect(noteField().value).toBe('');
    expect(visibleText(host)).toContain('有未保存修改');
    await click(button(host, '保存笔记'));
    expect(storeSlot.current.patchProgress).not.toHaveBeenCalled();
    expect(button(host, '载入已保存版本')).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem('yankao-note-drafts-v1') || '{}')['Q-1'].pending.note).toBe('结果尚未确认的已发送正文');
  });

  it('pending 的笔记和错因只按各字段对应的服务器正文分别确认，后续编辑保持独立', async () => {
    sessionStorage.setItem('yankao-note-drafts-v1', JSON.stringify({ 'Q-1': {
      note: '发送后的新笔记', reason: '审题疏漏', baseNote: '原笔记', baseReason: '',
      pending: { note: '已发送笔记', reason: '概念不清' },
    } }));
    storeSlot.current.progress['Q-1'].note = '已发送笔记';
    await mountWorkspace();
    await click(button(host, '继续上次答题'));
    expect(noteField().value).toBe('发送后的新笔记');
    let saved = JSON.parse(sessionStorage.getItem('yankao-note-drafts-v1') || '{}')['Q-1'];
    expect(saved.baseNote).toBe('已发送笔记');
    expect(saved.pending).toEqual({ reason: '概念不清' });

    storeSlot.current.progress['Q-1'].reason = '概念不清';
    await settle();
    saved = JSON.parse(sessionStorage.getItem('yankao-note-drafts-v1') || '{}')['Q-1'];
    expect(saved.pending).toBeUndefined();
    expect(saved.reason).toBe('审题疏漏');
    await click(button(host, '保存笔记'));
    expect(storeSlot.current.patchProgress).toHaveBeenCalledWith('Q-1', { note: '发送后的新笔记', reason: '审题疏漏' }, { note: '已发送笔记', reason: '概念不清' });
  });

  it('A/B 换题后各自未保存草稿和载入基线保持独立', async () => {
    storeSlot.current.progress['Q-1'].note = 'A 的载入基线';
    storeSlot.current.progress['Q-2'].note = 'B 的载入基线';
    await mountWorkspace();
    await click(button(host, '继续上次答题'));
    await typeNote('A 的未保存草稿');
    await click(button(host, '第2题'));
    expect(noteField().value).toBe('B 的载入基线');
    await typeNote('B 的未保存草稿');
    await click(button(host, '第1题'));
    expect(noteField().value).toBe('A 的未保存草稿');
    await click(button(host, '保存笔记'));

    expect(storeSlot.current.patchProgress).toHaveBeenCalledWith('Q-1', { note: 'A 的未保存草稿' }, { note: 'A 的载入基线' });
    await click(button(host, '第2题'));
    expect(noteField().value).toBe('B 的未保存草稿');
    expect(storeSlot.current.progress['Q-2'].note).toBe('B 的载入基线');
  });

  it('409 冲突保留草稿并显示已保存版本，不自动重试或变更草稿基线', async () => {
    storeSlot.current.progress['Q-1'].note = '冲突前基线';
    await mountWorkspace();
    await click(button(host, '继续上次答题'));
    await typeNote('需要保留的冲突草稿');
    storeSlot.current.patchProgress.mockImplementationOnce(async () => {
      storeSlot.current.progress['Q-1'].note = '另一客户端已保存的新版本';
      throw Object.assign(new Error('笔记已被另一客户端修改'), { status: 409 });
    });
    await click(button(host, '保存笔记'));
    await vi.advanceTimersByTimeAsync(5000);
    await settle();

    expect(storeSlot.current.patchProgress).toHaveBeenCalledTimes(1);
    expect(storeSlot.current.patchProgress).toHaveBeenCalledWith('Q-1', { note: '需要保留的冲突草稿' }, { note: '冲突前基线' });
    expect(noteField().value).toBe('需要保留的冲突草稿');
    expect(visibleText(host)).toContain('另一客户端已保存的新版本');
  });

  it('刷新重挂载恢复未保存草稿时仍保留初次载入基线', async () => {
    storeSlot.current.progress['Q-1'].note = '刷新前的旧基线';
    await mountWorkspace();
    await click(button(host, '继续上次答题'));
    await typeNote('刷新后还应存在的草稿');
    app!.unmount();
    app = null;
    host = hostNode('root');
    storeSlot.current.progress['Q-1'].note = '刷新期间服务端的新版本';
    await mountWorkspace();
    await click(button(host, '继续上次答题'));
    expect(noteField().value).toBe('刷新后还应存在的草稿');
    await click(button(host, '保存笔记'));

    expect(storeSlot.current.patchProgress).toHaveBeenCalledWith('Q-1', { note: '刷新后还应存在的草稿' }, { note: '刷新前的旧基线' });
  });
});

describe('错题与收藏集合的练习入口', () => {
  it('已掌握筛选仍可研究题目，但不能重练为空的待巩固集合', async () => {
    storeSlot.current.wrongQuestions = [questions[0]];
    storeSlot.current.progress['Q-1'].mastered = true;
    await mountWorkspace();
    await click(button(host, '错题研究'));
    await click(button(host, '已掌握'));

    expect(visibleText(host)).toContain('第一题题干');
    expect(button(host, '重练待巩固错题').props.disabled).toBe(true);
    expect(storeSlot.current.startSession).not.toHaveBeenCalled();
  });

  it('待巩固入口可用，查看全部错题时组题仍排除已掌握题目', async () => {
    storeSlot.current.wrongQuestions = [...questions];
    storeSlot.current.progress['Q-1'].mastered = true;
    storeSlot.current.progress['Q-2'].mastered = false;
    await mountWorkspace();
    await click(button(host, '错题研究'));
    expect(button(host, '重练待巩固错题').props.disabled).toBeFalsy();
    await click(button(host, '全部'));
    expect(visibleText(host)).toContain('第一题题干');
    expect(visibleText(host)).toContain('第二题题干');
    await click(button(host, '重练待巩固错题'));

    expect(storeSlot.current.startSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'wrong', questionIds: ['Q-2'] }));
  });

  it('收藏练习保留当前收藏集合中的已掌握题目', async () => {
    storeSlot.current.favoriteQuestions = [...questions];
    storeSlot.current.progress['Q-1'].mastered = true;
    await mountWorkspace();
    await click(button(host, '我的收藏'));
    expect(button(host, '练习这些收藏').props.disabled).toBeFalsy();
    await click(button(host, '练习这些收藏'));

    expect(storeSlot.current.startSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'favorites', questionIds: ['Q-1', 'Q-2'] }));
  });
});

describe('历史 useStudyBridge 控制器兼容恢复（独立消费者）', () => {
  it('切到学习设置后仍收尾并刷新原题解析', async () => {
    await mountHistoricalBridge();
    await startQ1Job();
    await click(button(host, '学习设置'));
    completeRemote();
    await vi.advanceTimersByTimeAsync(650);
    await settle();
    expect(storeSlot.current.refreshProgress).toHaveBeenCalledTimes(1);
    expect(storeSlot.current.progress['Q-1'].aiNote).toBe(finalText);
    expect(historicalBridge.run.value?.progressSynced).toBe(true);
    expect(visibleText(host)).toContain('本轮完整解析已保存');
  });

  it('切到另一题时继续收尾，正文只归属原题', async () => {
    await mountHistoricalBridge();
    await startQ1Job();
    await click(button(host, '第2题'));
    expect(visibleText(host)).toContain('第二题题干');
    completeRemote();
    await vi.advanceTimersByTimeAsync(650);
    await settle();
    expect(storeSlot.current.progress['Q-1'].aiNote).toBe(finalText);
    expect(storeSlot.current.progress['Q-2'].aiNote).toBe('');
    expect(visibleText(host)).not.toContain(finalText);
    await click(button(host, '第1题'));
    expect(visibleText(host)).toContain(finalText);
  });

  it('任务 404 解除等待并允许重新发起', async () => {
    const missing = Object.assign(new Error('解析任务不存在，服务可能已重启'), { status: 404 });
    api.getBridgeJob.mockRejectedValue(missing);
    await mountHistoricalBridge();
    await startQ1Job();
    remoteJob = null;
    await vi.advanceTimersByTimeAsync(650);
    await settle();
    expect(api.getBridgeJob).toHaveBeenCalledTimes(1);
    expect(historicalBridge.job.value).toMatchObject({ status: 'failed', failureCode: 'missing' });
    expect(button(host, '发起历史任务').props.disabled).toBeFalsy();
    api.createBridgeJob.mockResolvedValueOnce({ ...pendingJob, id: 'job-2' });
    await click(button(host, '发起历史任务'));
    expect(api.createBridgeJob).toHaveBeenCalledTimes(2);
  });

  it('刷新挂载后从服务端概览恢复原任务并完成', async () => {
    remoteJob = { ...pendingJob, status: 'streaming', text: '临时正文' };
    await mountHistoricalBridge();
    expect(visibleText(host)).toContain('临时正文');
    completeRemote();
    await vi.advanceTimersByTimeAsync(650);
    await settle();
    expect(api.createBridgeJob).not.toHaveBeenCalled();
    expect(storeSlot.current.progress['Q-1'].aiNote).toBe(finalText);
  });

  it('另一标签已发起任务导致 409 时接管原任务', async () => {
    api.createBridgeJob.mockImplementationOnce(async () => { remoteJob = { ...pendingJob, status: 'streaming', text: '另一标签正在生成' }; throw Object.assign(new Error('已有一道题正在解析'), { status: 409 }); });
    await mountHistoricalBridge();
    await click(button(host, '发起历史任务'));
    expect(visibleText(host)).toContain('另一标签正在生成');
    completeRemote();
    await vi.advanceTimersByTimeAsync(650);
    await settle();
    expect(storeSlot.current.progress['Q-1'].aiNote).toBe(finalText);
  });

  it('临时网络错误继续重试并最终完成', async () => {
    await mountHistoricalBridge();
    await startQ1Job();
    api.getBridgeOverview.mockRejectedValueOnce(new TypeError('暂时断线'));
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(visibleText(host)).toContain('正在自动重连');
    completeRemote();
    await vi.advanceTimersByTimeAsync(1500);
    await settle();
    expect(storeSlot.current.progress['Q-1'].aiNote).toBe(finalText);
  });

  it('视图卸载重建后仍追踪同一任务且不重复创建', async () => {
    await mountHistoricalBridge();
    await startQ1Job();
    app!.unmount();
    app = null;
    host = hostNode('root');
    completeRemote();
    await vi.advanceTimersByTimeAsync(650);
    await mountHistoricalBridge();
    expect(api.createBridgeJob).toHaveBeenCalledTimes(1);
    expect(storeSlot.current.refreshProgress).toHaveBeenCalledTimes(1);
    expect(historicalBridge.run.value?.progressSynced).toBe(true);
    expect(visibleText(host)).toContain('本轮完整解析已保存');
  });

  it('设置页可以结束等待，保留旧解析并解除禁用', async () => {
    storeSlot.current.progress['Q-1'].aiNote = '上次完整解析';
    await mountHistoricalBridge();
    await startQ1Job();
    await click(button(host, '学习设置'));
    await click(button(host, '结束历史等待'));
    expect(api.cancelBridgeJob).toHaveBeenCalledWith('job-1');
    expect(storeSlot.current.progress['Q-1'].aiNote).toBe('上次完整解析');
    expect(storeSlot.current.refreshProgress).not.toHaveBeenCalled();
    await click(button(host, '返回题目'));
    expect(button(host, '发起历史任务').props.disabled).toBeFalsy();
    expect(historicalBridge.job.value).toMatchObject({ status: 'failed', failureCode: 'cancelled' });
  });
});
