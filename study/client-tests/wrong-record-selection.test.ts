import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import StudyWorkspace from '@/views/study/StudyWorkspace.vue';
import { resetStudyBridge } from '@/store/modules/studyBridge';
import { type HostNode, hostNode, renderer, visibleText, button, click, settle, descendants } from './vue-memory-host';

const api = vi.hoisted(() => ({
  getBridgeStatus: vi.fn(), getPendingBridgeJobs: vi.fn(), getBridgeOverview: vi.fn(),
  createBridgeJob: vi.fn(), getBridgeJob: vi.fn(), cancelBridgeJob: vi.fn(),
  getPreanalysisSettings: vi.fn(), savePreanalysisSettings: vi.fn(),
}));
const storeSlot = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/api/study', () => api);
vi.mock('@/store/modules/study', () => ({
  useStudyStore: () => storeSlot.current,
  emptyProgress: () => ({ attempts: 0, correctCount: 0, wrongCount: 0, lastAnswer: [], lastCorrect: null,
    lastAnsweredAt: null, mastered: false, favorite: false, wrongRemoved: false, note: '', reason: '', aiNote: '' }),
}));
vi.mock('element-plus', () => ({
  ElMessage: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  ElMessageBox: { confirm: vi.fn() },
}));

const questions = [
  { id: 'Q-1', stem: '网络待巩固甲', category: '计算机网络' },
  { id: 'Q-2', stem: '网络已掌握乙', category: '计算机网络' },
  { id: 'Q-3', stem: '应用待巩固丙', category: 'Web与应用安全' },
  { id: 'Q-4', stem: '已删除历史丁', category: '计算机网络' },
].map(q => ({ ...q, chapter: '基础', type: 'single', difficulty: '基础',
  options: [{ id: 'A', text: '正确项' }, { id: 'B', text: '错误项' }], answer: ['A'],
  explanation: `${q.id}原解析`, knowledgePoint: `${q.id}知识点`, source: '原创题' }));

function fakeStore() {
  const session = reactive({ id: 'session-1', mode: 'sequential', questionIds: ['Q-1'], answers: { 'Q-1': ['B'] },
    submittedQuestionIds: ['Q-1'], status: 'active', cursor: 0, createdAt: '2026-10-21T00:00:00.000Z',
    deadlineAt: null, score: 0, correctCount: 0 });
  const state: any = reactive({
    loaded: true, loading: false, error: '', busy: false, saveState: 'saved', questions,
    questionMap: Object.fromEntries(questions.map(q => [q.id, q])),
    progress: Object.fromEntries(questions.map(q => [q.id, { attempts: 2, correctCount: 0, wrongCount: 2,
      lastAnswer: ['B'], lastCorrect: false, lastAnsweredAt: '2026-10-21T00:00:00.000Z', mastered: q.id === 'Q-2',
      wrongRemoved: q.id === 'Q-4', favorite: false, note: `${q.id}笔记`, reason: '概念不清', aiNote: `${q.id}已保存解析` }])),
    sessions: [session], currentSession: session, categories: ['计算机网络', 'Web与应用安全'], favoriteQuestions: [],
    ai: { configured: false, baseUrl: '', model: '', webUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh' },
    get activeSession() { return this.currentSession.status === 'active' ? this.currentSession : null; },
    get currentQuestion() { return this.questionMap[this.currentSession.questionIds[this.currentSession.cursor]]; },
    get wrongQuestions() { return this.questions.filter((q: any) => this.progress[q.id]?.wrongCount > 0 && !this.progress[q.id]?.wrongRemoved); },
    get removedWrongQuestions() { return this.questions.filter((q: any) => this.progress[q.id]?.wrongCount > 0 && this.progress[q.id]?.wrongRemoved); },
    bootstrap: vi.fn(async () => {}), refreshProgress: vi.fn(async () => {}), patchProgress: vi.fn(async () => {}),
    startSession: vi.fn(async () => null), resume: vi.fn(), resumeSession: vi.fn(), navigate: vi.fn(),
    removeWrongRecords: vi.fn(async (ids: string[]) => { for (const id of ids) state.progress[id].wrongRemoved = true; }),
    restoreWrongRecords: vi.fn(async (ids: string[]) => { for (const id of ids) state.progress[id].wrongRemoved = false; }),
  });
  return state;
}

let host: HostNode;
let app: ReturnType<typeof renderer.createApp> | null;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
  resetStudyBridge(); vi.resetAllMocks();
  const events = new Map<string, Set<(...args: any[]) => void>>();
  (globalThis as any).window = { innerWidth: 1280, setTimeout, clearTimeout,
    addEventListener(name: string, listener: (...args: any[]) => void) {
      if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: (...args: any[]) => void) { events.get(name)?.delete(listener); },
    dispatchEvent(event: { type: string }) { for (const listener of events.get(event.type) || []) listener(event); return true; },
  };
  (globalThis as any).document = { hidden: false, activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  (globalThis as any).localStorage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  const stored = new Map<string, string>();
  (globalThis as any).sessionStorage = { getItem: vi.fn((key: string) => stored.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => stored.set(key, value)), removeItem: vi.fn((key: string) => stored.delete(key)) };
  (globalThis as any).CustomEvent = class { constructor(public type: string, public options?: any) {} };
  storeSlot.current = fakeStore();
  vi.mocked(ElMessageBox.confirm).mockResolvedValue('confirm');
  api.getBridgeStatus.mockResolvedValue({ connected: true, version: '1.3.0', worker: { connected: true, state: 'idle' } });
  api.getPendingBridgeJobs.mockResolvedValue({ jobs: [] });
  api.getPreanalysisSettings.mockResolvedValue({ transport: 'web', configured: false, model: 'glm-4.7-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyStorage: 'none' });
  api.getBridgeOverview.mockResolvedValue({ activeJob: null, latestJob: null, serverTime: new Date().toISOString(),
    limits: { totalTimeoutMs: 240000, idleTimeoutMs: 120000 } });
  host = hostNode('root'); app = null;
});
afterEach(() => { app?.unmount(); resetStudyBridge(); vi.useRealTimers(); });

async function openWrongRecords() {
  app = renderer.createApp(StudyWorkspace); app.mount(host); await settle();
  await click(button(host, '错题研究'));
}
function checkbox(label: string) {
  const found = descendants(host).find(node => node.tag === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === label);
  if (!found) throw new Error(`未找到复选框：${label}`);
  return found;
}
function hasCheckbox(label: string) {
  return descendants(host).some(node => node.tag === 'input' && node.props['aria-label'] === label);
}
function filterButton(label: string) {
  const found = descendants(host).find(node => node.tag === 'button' && visibleText(node) === label);
  if (!found) throw new Error(`未找到筛选按钮：${label}`);
  return found;
}
async function toggleCheckbox(label: string, checked: boolean) {
  const node = checkbox(label);
  if (node.props.disabled) throw new Error(`不能操作禁用的复选框：${label}`);
  node.checked = checked;
  let stopped = false;
  const event: any = { type: 'click', target: node, currentTarget: node,
    stopPropagation() { stopped = true; }, preventDefault() {} };
  for (let current: HostNode | null = node; current && !stopped; current = current.parent) {
    event.currentTarget = current;
    const handlers = current.props.onClick;
    for (const handler of Array.isArray(handlers) ? handlers : handlers ? [handlers] : []) await handler(event);
    current.dispatchEvent(event);
  }
  const change: any = { type: 'change', target: node, currentTarget: node, stopPropagation() {}, preventDefault() {} };
  const handlers = node.props.onChange;
  for (const handler of Array.isArray(handlers) ? handlers : handlers ? [handlers] : []) await handler(change);
  node.dispatchEvent(change);
  await settle();
}
async function searchFor(value: string) {
  const field = descendants(host).find(node => node.tag === 'input' && node.props['aria-label'] === '搜索题目');
  if (!field) throw new Error('未找到搜索题目');
  field.value = value; field.dispatchEvent({ type: 'input', target: field } as any); await settle();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe('错题记录勾选、移出与恢复的真实组件行为', () => {
  it('独立勾选不进入题目，当前列表全选与取消全选只覆盖待巩固记录', async () => {
    await openWrongRecords();
    expect(hasCheckbox('选择错题 Q-2')).toBe(false);
    expect(hasCheckbox('选择错题 Q-4')).toBe(false);
    await toggleCheckbox('选择错题 Q-1', true);
    expect(visibleText(host)).toContain('已选 1 条');
    expect(visibleText(host)).toContain('每一道错题，都值得再想一遍');
    expect(checkbox('全选当前列表').checked).toBe(false);
    await toggleCheckbox('全选当前列表', true);
    expect(checkbox('选择错题 Q-1').checked).toBe(true);
    expect(checkbox('选择错题 Q-3').checked).toBe(true);
    expect(visibleText(host)).toContain('已选 2 条');
    await toggleCheckbox('全选当前列表', false);
    expect(checkbox('选择错题 Q-1').checked).toBe(false);
    expect(checkbox('选择错题 Q-3').checked).toBe(false);
    expect(visibleText(host)).toContain('已选 0 条');
    expect(storeSlot.current.startSession).not.toHaveBeenCalled();
  });

  it('删除确认说明保留历史与可恢复性，取消后保留记录及勾选', async () => {
    await openWrongRecords();
    await toggleCheckbox('选择错题 Q-1', true);
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel');
    await click(button(host, '删除选中记录'));
    const message = String(vi.mocked(ElMessageBox.confirm).mock.calls[0][0]);
    for (const part of ['错题本', '作答', '笔记', '解析', '恢复']) expect(message).toContain(part);
    expect(storeSlot.current.removeWrongRecords).not.toHaveBeenCalled();
    expect(checkbox('选择错题 Q-1').checked).toBe(true);
    expect(visibleText(host)).toContain('已选 1 条');
    expect(button(host, '删除选中记录').props.disabled).toBeFalsy();
  });

  it('确认及请求期间不乐观隐藏记录，成功后才移出并清空对应选择', async () => {
    await openWrongRecords();
    await toggleCheckbox('选择错题 Q-1', true);
    const confirmation = deferred(), request = deferred();
    vi.mocked(ElMessageBox.confirm).mockReturnValueOnce(confirmation.promise as any);
    storeSlot.current.removeWrongRecords.mockImplementationOnce(async (ids: string[]) => {
      await request.promise; for (const id of ids) storeSlot.current.progress[id].wrongRemoved = true;
    });
    const operation = click(button(host, '删除选中记录'));
    await settle();
    expect(storeSlot.current.removeWrongRecords).not.toHaveBeenCalled();
    expect(checkbox('选择错题 Q-1').props.disabled).toBe(true);
    expect(button(host, '已掌握').props.disabled).toBe(true);
    confirmation.resolve(); await settle();
    expect(storeSlot.current.removeWrongRecords).toHaveBeenCalledWith(['Q-1']);
    expect(hasCheckbox('选择错题 Q-1')).toBe(true);
    expect(visibleText(host)).toContain('已选 1 条');
    request.resolve(); await operation;
    expect(hasCheckbox('选择错题 Q-1')).toBe(false);
    expect(hasCheckbox('选择错题 Q-3')).toBe(true);
    expect(visibleText(host)).toContain('已选 0 条');
    expect(storeSlot.current.patchProgress).not.toHaveBeenCalled();
  });

  it('删除失败保留可见记录和勾选，显示错误并允许原选择重试', async () => {
    await openWrongRecords();
    await toggleCheckbox('选择错题 Q-1', true);
    storeSlot.current.removeWrongRecords.mockRejectedValueOnce(new Error('删除请求未完成'));
    await click(button(host, '删除选中记录'));
    expect(ElMessage.error).toHaveBeenCalledWith('删除请求未完成');
    expect(checkbox('选择错题 Q-1').checked).toBe(true);
    expect(visibleText(host)).toContain('已选 1 条');
    expect(storeSlot.current.progress['Q-1'].wrongRemoved).toBe(false);
    await click(button(host, '删除选中记录'));
    expect(storeSlot.current.removeWrongRecords).toHaveBeenNthCalledWith(2, ['Q-1']);
    expect(hasCheckbox('选择错题 Q-1')).toBe(false);
  });

  it('搜索改变时清空旧选择，全选和删除仅提交当前搜索结果', async () => {
    await openWrongRecords();
    await toggleCheckbox('全选当前列表', true);
    await searchFor('网络');
    expect(visibleText(host)).toContain('已选 0 条');
    expect(hasCheckbox('选择错题 Q-3')).toBe(false);
    expect(checkbox('选择错题 Q-1').checked).toBe(false);
    await toggleCheckbox('全选当前列表', true);
    expect(visibleText(host)).toContain('已选 1 条');
    await click(button(host, '删除选中记录'));
    expect(storeSlot.current.removeWrongRecords).toHaveBeenCalledWith(['Q-1']);
    expect(storeSlot.current.progress['Q-3'].wrongRemoved).toBe(false);
  });

  it('切换过滤条件或离开页面后清空选择，不把隐藏记录带入下一次批量操作', async () => {
    await openWrongRecords();
    await toggleCheckbox('全选当前列表', true);
    await click(button(host, '已掌握'));
    expect(visibleText(host)).toContain('已选 0 条');
    expect(hasCheckbox('选择错题 Q-1')).toBe(false);
    await toggleCheckbox('全选当前列表', true);
    expect(checkbox('选择错题 Q-2').checked).toBe(true);
    expect(visibleText(host)).toContain('已选 1 条');
    await click(button(host, '学习设置'));
    await click(button(host, '错题研究'));
    expect(visibleText(host)).toContain('已选 0 条');
    expect(button(host, '删除选中记录').props.disabled).toBe(true);
    expect(storeSlot.current.removeWrongRecords).not.toHaveBeenCalled();
  });

  it('已删除列表只恢复选中记录，不弹删除确认且不能重练该列表', async () => {
    await openWrongRecords();
    await click(button(host, '已删除'));
    expect(hasCheckbox('选择错题 Q-4')).toBe(true);
    expect(hasCheckbox('选择错题 Q-1')).toBe(false);
    expect(button(host, '重练待巩固错题').props.disabled).toBe(true);
    await toggleCheckbox('选择错题 Q-4', true);
    await click(button(host, '恢复选中记录'));
    expect(storeSlot.current.restoreWrongRecords).toHaveBeenCalledWith(['Q-4']);
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
    expect(hasCheckbox('选择错题 Q-4')).toBe(false);
    expect(storeSlot.current.startSession).not.toHaveBeenCalled();
    expect(storeSlot.current.patchProgress).not.toHaveBeenCalled();
    expect(storeSlot.current.progress['Q-4']).toMatchObject({ note: 'Q-4笔记', aiNote: 'Q-4已保存解析', wrongCount: 2 });
    await click(filterButton('待巩固'));
    expect(hasCheckbox('选择错题 Q-4')).toBe(true);
    expect(checkbox('选择错题 Q-4').checked).toBe(false);
  });

  it('恢复失败仍保留已删除记录及选择，便于直接重试', async () => {
    await openWrongRecords();
    await click(button(host, '已删除'));
    await toggleCheckbox('选择错题 Q-4', true);
    storeSlot.current.restoreWrongRecords.mockRejectedValueOnce(new Error('恢复请求未完成'));
    await click(button(host, '恢复选中记录'));
    expect(ElMessage.error).toHaveBeenCalledWith('恢复请求未完成');
    expect(checkbox('选择错题 Q-4').checked).toBe(true);
    expect(visibleText(host)).toContain('已选 1 条');
    expect(storeSlot.current.progress['Q-4'].wrongRemoved).toBe(true);
    expect(button(host, '恢复选中记录').props.disabled).toBeFalsy();
  });
});
