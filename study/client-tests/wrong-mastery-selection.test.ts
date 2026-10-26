import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import StudyWorkspace from '@/views/study/StudyWorkspace.vue';
import { resetStudyBridge } from '@/store/modules/studyBridge';
import { type HostNode, hostNode, renderer, visibleText, button, click, settle, descendants } from './vue-memory-host';

const api = vi.hoisted(() => ({
  getBridgeStatus: vi.fn(), getPendingBridgeJobs: vi.fn(), getBridgeOverview: vi.fn(),
  createBridgeJob: vi.fn(), getBridgeJob: vi.fn(), cancelBridgeJob: vi.fn(),
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
    markWrongMastered: vi.fn(async (ids: string[]) => { for (const id of ids) state.progress[id].mastered = true; return { changedCount: ids.length }; }),
    markWrongPending: vi.fn(async (ids: string[]) => { for (const id of ids) state.progress[id].mastered = false; return { changedCount: ids.length }; }),
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

function hasButton(label: string) {
  return descendants(host).some(node => node.tag === 'button' && visibleText(node).includes(label));
}
function searchInput() {
  return descendants(host).find(node => node.tag === 'input' && node.props['aria-label'] === '搜索题目')!;
}
const disabled = (label: string) => Boolean(button(host, label).props.disabled);

describe('错题掌握勾选与批量操作的真实组件行为', () => {
  it('每题掌握勾选独立于研究入口，掌握后从待巩固移出且可在已掌握中取消', async () => {
    await openWrongRecords();
    const before = JSON.parse(JSON.stringify(storeSlot.current.progress['Q-1']));
    expect(checkbox('已掌握错题 Q-1').checked).toBe(false);
    await toggleCheckbox('已掌握错题 Q-1', true);
    expect(storeSlot.current.markWrongMastered).toHaveBeenCalledWith(['Q-1']);
    expect(visibleText(host)).toContain('每一道错题，都值得再想一遍');
    expect(hasCheckbox('已掌握错题 Q-1')).toBe(false);
    expect(hasCheckbox('已掌握错题 Q-3')).toBe(true);
    expect(storeSlot.current.progress['Q-1']).toEqual({ ...before, mastered: true });
    await click(filterButton('已掌握'));
    expect(checkbox('已掌握错题 Q-1').checked).toBe(true);
    expect(checkbox('已掌握错题 Q-2').checked).toBe(true);
    await toggleCheckbox('已掌握错题 Q-1', false);
    expect(storeSlot.current.markWrongPending).toHaveBeenCalledWith(['Q-1']);
    expect(hasCheckbox('已掌握错题 Q-1')).toBe(false);
    await click(filterButton('待巩固')); expect(checkbox('已掌握错题 Q-1').checked).toBe(false);
    expect(storeSlot.current.patchProgress).not.toHaveBeenCalled();
    expect(api.createBridgeJob).not.toHaveBeenCalled();
  });

  it('批量操作仅提交选中且状态需要改变的记录，成功清勾选', async () => {
    await openWrongRecords(); await click(filterButton('全部'));
    expect(disabled('标记选中为已掌握')).toBe(true); expect(disabled('标记选中为待巩固')).toBe(true);
    await toggleCheckbox('全选当前列表', true);
    await click(button(host, '标记选中为已掌握'));
    expect(storeSlot.current.markWrongMastered).toHaveBeenCalledWith(['Q-1', 'Q-3']);
    expect(storeSlot.current.markWrongMastered).not.toHaveBeenCalledWith(expect.arrayContaining(['Q-2']));
    expect(visibleText(host)).toContain('已选 0 条');
    expect(checkbox('已掌握错题 Q-1').checked).toBe(true);
    expect(checkbox('已掌握错题 Q-2').checked).toBe(true);
    expect(checkbox('已掌握错题 Q-3').checked).toBe(true);
    await toggleCheckbox('全选当前列表', true);
    expect(disabled('标记选中为已掌握')).toBe(true); expect(disabled('标记选中为待巩固')).toBe(false);
    await click(button(host, '标记选中为待巩固'));
    expect(storeSlot.current.markWrongPending).toHaveBeenCalledWith(['Q-1', 'Q-2', 'Q-3']);
    expect(visibleText(host)).toContain('已选 0 条');
    expect(storeSlot.current.progress['Q-4'].wrongRemoved).toBe(true);
    expect(storeSlot.current.removeWrongRecords).not.toHaveBeenCalled();
    expect(storeSlot.current.patchProgress).not.toHaveBeenCalled();
  });

  it('搜索和筛选清空旧选择，批量掌握不提交隐藏记录', async () => {
    await openWrongRecords(); await toggleCheckbox('全选当前列表', true);
    await searchFor('网络'); expect(visibleText(host)).toContain('已选 0 条');
    expect(hasCheckbox('已掌握错题 Q-3')).toBe(false);
    await toggleCheckbox('全选当前列表', true); await click(button(host, '标记选中为已掌握'));
    expect(storeSlot.current.markWrongMastered).toHaveBeenCalledWith(['Q-1']);
    expect(storeSlot.current.progress['Q-3'].mastered).toBe(false);
    await click(filterButton('已掌握')); await toggleCheckbox('全选当前列表', true);
    expect(visibleText(host)).toContain('已选 2 条');
    await click(filterButton('全部')); expect(visibleText(host)).toContain('已选 0 条');
    expect(disabled('标记选中为待巩固')).toBe(true);
  });

  it('请求失败恢复掌握checkbox的真实显示，保留题目、原数据及批量选择以便重试', async () => {
    await openWrongRecords(); await toggleCheckbox('选择错题 Q-1', true);
    const before = JSON.parse(JSON.stringify(storeSlot.current.progress['Q-1']));
    storeSlot.current.markWrongMastered.mockRejectedValueOnce(new Error('标记请求未完成'));
    await toggleCheckbox('已掌握错题 Q-1', true);
    expect(ElMessage.error).toHaveBeenCalledWith('标记请求未完成');
    expect(checkbox('已掌握错题 Q-1').checked).toBe(false);
    expect(checkbox('选择错题 Q-1').checked).toBe(true);
    expect(storeSlot.current.progress['Q-1']).toEqual(before);
    expect(visibleText(host)).toContain('每一道错题，都值得再想一遍');
    await toggleCheckbox('已掌握错题 Q-1', true);
    expect(storeSlot.current.markWrongMastered).toHaveBeenCalledTimes(2);
    expect(hasCheckbox('已掌握错题 Q-1')).toBe(false);
    expect(visibleText(host)).toContain('已选 0 条');
  });

  it('批量失败不丢选中记录，原选择可直接重试', async () => {
    await openWrongRecords(); await toggleCheckbox('全选当前列表', true);
    storeSlot.current.markWrongMastered.mockRejectedValueOnce(new Error('批量标记失败'));
    await click(button(host, '标记选中为已掌握'));
    expect(ElMessage.error).toHaveBeenCalledWith('批量标记失败'); expect(visibleText(host)).toContain('已选 2 条');
    expect(checkbox('已掌握错题 Q-1').checked).toBe(false); expect(disabled('标记选中为已掌握')).toBe(false);
    await click(button(host, '标记选中为已掌握'));
    expect(storeSlot.current.markWrongMastered).toHaveBeenNthCalledWith(2, ['Q-1', 'Q-3']);
    expect(visibleText(host)).toContain('已选 0 条');
  });

  it('请求期间冻结筛选、搜索和勾选，防连点且等服务成功后才移出题目', async () => {
    await openWrongRecords(); const request = deferred();
    storeSlot.current.markWrongMastered.mockImplementationOnce(async (ids: string[]) => {
      await request.promise; for (const id of ids) storeSlot.current.progress[id].mastered = true;
      return { changedCount: ids.length };
    });
    const node = checkbox('已掌握错题 Q-1');
    const operation = toggleCheckbox('已掌握错题 Q-1', true); await settle();
    expect(storeSlot.current.markWrongMastered).toHaveBeenCalledTimes(1);
    expect(hasCheckbox('已掌握错题 Q-1')).toBe(true); expect(storeSlot.current.progress['Q-1'].mastered).toBe(false);
    expect(checkbox('已掌握错题 Q-3').props.disabled).toBe(true);
    expect(checkbox('选择错题 Q-1').props.disabled).toBe(true);
    expect(filterButton('已掌握').props.disabled).toBe(true); expect(searchInput().props.disabled).toBe(true);
    await node.props.onChange({ target: node, currentTarget: node, stopPropagation() {} }); await settle();
    expect(storeSlot.current.markWrongMastered).toHaveBeenCalledTimes(1);
    request.resolve(); await operation;
    expect(hasCheckbox('已掌握错题 Q-1')).toBe(false); expect(filterButton('已掌握').props.disabled).toBe(false);
  });

  it('已删除列表无掌握入口，研究已删除题也不能绕过操作', async () => {
    await openWrongRecords(); await click(filterButton('已删除'));
    expect(hasCheckbox('已掌握错题 Q-4')).toBe(false);
    expect(hasButton('标记选中为已掌握')).toBe(false); expect(hasButton('标记选中为待巩固')).toBe(false);
    await click(button(host, '已删除历史丁'));
    const mastery = descendants(host).find(node => node.tag === 'button' && visibleText(node).includes('标记为已掌握'));
    if (mastery) {
      expect(Boolean(mastery.props.disabled)).toBe(true);
      await click(mastery);
    }
    expect(storeSlot.current.markWrongMastered).not.toHaveBeenCalled(); expect(storeSlot.current.markWrongPending).not.toHaveBeenCalled();
    expect(storeSlot.current.patchProgress).not.toHaveBeenCalled();
    expect(storeSlot.current.progress['Q-4']).toMatchObject({ wrongRemoved: true, mastered: false, note: 'Q-4笔记', aiNote: 'Q-4已保存解析' });
  });

  it('掌握后首页待巩固统计和重练范围同步减少，再次答错后回到待巩固', async () => {
    await openWrongRecords(); await toggleCheckbox('已掌握错题 Q-1', true);
    await click(button(host, '重练待巩固错题'));
    expect(storeSlot.current.startSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'wrong', questionIds: ['Q-3'] }));
    await click(button(host, '学习概览'));
    const metric = descendants(host).find(node => node.tag === 'div' && node.children.some(child => child.tag === 'span' && visibleText(child) === '待巩固错题'))!;
    expect(visibleText(metric)).toContain('1 题');
    storeSlot.current.progress['Q-1'].mastered = false;
    storeSlot.current.progress['Q-1'].wrongCount++;
    storeSlot.current.progress['Q-1'].lastAnsweredAt = '2026-10-21T00:01:00.000Z';
    await settle(); await click(button(host, '错题研究')); await click(filterButton('待巩固'));
    expect(checkbox('已掌握错题 Q-1').checked).toBe(false);
    await click(button(host, '重练待巩固错题'));
    expect(storeSlot.current.startSession).toHaveBeenLastCalledWith(expect.objectContaining({ questionIds: ['Q-1', 'Q-3'] }));
  });

  it('题目研究页的现存错题掌握操作走同一专用接口，保留笔记和解析', async () => {
    await openWrongRecords(); await click(button(host, '网络待巩固甲'));
    await click(button(host, '标记为已掌握'));
    expect(storeSlot.current.markWrongMastered).toHaveBeenCalledWith(['Q-1']);
    await click(button(host, '重新巩固'));
    expect(storeSlot.current.markWrongPending).toHaveBeenCalledWith(['Q-1']);
    expect(storeSlot.current.patchProgress).not.toHaveBeenCalled();
    expect(storeSlot.current.progress['Q-1']).toMatchObject({ note: 'Q-1笔记', aiNote: 'Q-1已保存解析', wrongCount: 2 });
  });

  it('从未答错题仍保留原有掌握功能，收藏页不提供错题批量入口', async () => {
    storeSlot.current.progress['Q-1'].wrongCount = 0; storeSlot.current.favoriteQuestions = [questions[0]];
    await openWrongRecords(); await click(button(host, '我的收藏'));
    expect(hasCheckbox('已掌握错题 Q-1')).toBe(false); expect(hasButton('标记选中为已掌握')).toBe(false);
    await click(button(host, '网络待巩固甲')); await click(button(host, '标记为已掌握'));
    expect(storeSlot.current.patchProgress).toHaveBeenCalledWith('Q-1', { mastered: true });
    expect(storeSlot.current.markWrongMastered).not.toHaveBeenCalled();
  });
});

