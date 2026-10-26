import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import StudyManagement from '@/views/study/StudyManagement.vue';
import { type HostNode, hostNode, renderer, descendants, visibleText, button, click, settle } from './vue-memory-host';

const slot = vi.hoisted(() => ({ current: null as any }));
vi.mock('@/store/modules/study', () => ({ useStudyStore: () => slot.current }));
vi.mock('element-plus', () => ({ ElMessage: { success: vi.fn(), error: vi.fn() }, ElMessageBox: { confirm: vi.fn() } }));

function fakeStore() {
  const questions = Array.from({ length: 24 }, (_, index) => {
    const number = index + 1, id = `Q-${String(number).padStart(2, '0')}`;
    return { id, stem: `题目${number}的完整题干`, category: number % 2 ? '计算机网络' : 'Web安全', chapter: '基础',
      type: number % 3 ? 'single' : 'multiple', difficulty: number % 2 ? '基础' : '进阶',
      options: [{ id: 'A', text: `选项A-${number}` }, { id: 'B', text: number === 1 ? '仅选项包含的专属检索词' : `选项B-${number}` }],
      answer: ['A'], explanation: `第${number}题完整解析`, knowledgePoint: number === 2 ? '独有知识坐标' : `知识点${number}`,
      source: '原创理论题，非官方真题', referenceUrls: ['https://www.rfc-editor.org/rfc/rfc9110.html', 'http://example.com/insecure', 'javascript:alert(1)'] };
  });
  const sessions = Array.from({ length: 23 }, (_, index) => {
    const number = index + 1, active = number % 2 === 1 || number === 22;
    return { id: `S-${String(number).padStart(2, '0')}`, mode: active ? 'exam' : 'sequential', questionIds: ['Q-01', 'Q-02'],
      answers: { 'Q-01': ['B'], 'Q-02': ['A'] }, submittedQuestionIds: active ? [] : ['Q-01', 'Q-02'],
      createdAt: new Date(Date.parse('2026-10-21T12:00:00.000Z') - index * 60000).toISOString(),
      deadlineAt: active ? '2026-10-21T12:30:00.000Z' : null, status: active ? 'active' : 'completed',
      score: active ? undefined : 50, correctCount: active ? undefined : 1, cursor: 1, removed: number > 21, revision: 0 };
  });
  const state: any = reactive({ questions, sessions, busy: false,
    questionRecords: Object.fromEntries(questions.map((q, index) => [q.id, { removed: index >= 22, revision: 0 }])),
    progress: { 'Q-01': { note: '应保留的学习笔记', aiNote: '应保留的AI解析', attempts: 10 } },
    removeQuestionRecords: vi.fn(async (ids: string[]) => { for (const id of ids) state.questionRecords[id].removed = true; }),
    restoreQuestionRecords: vi.fn(async (ids: string[]) => { for (const id of ids) state.questionRecords[id].removed = false; }),
    removeSessionRecords: vi.fn(async (ids: string[]) => { for (const id of ids) state.sessions.find((s: any) => s.id === id).removed = true; }),
    restoreSessionRecords: vi.fn(async (ids: string[]) => { for (const id of ids) state.sessions.find((s: any) => s.id === id).removed = false; }),
  });
  return state;
}

let host: HostNode;
let app: ReturnType<typeof renderer.createApp> | null;
let storedPageSizes: Map<string, string>;
const kind = ref<'bank' | 'history'>('bank');
const review = vi.fn(), session = vi.fn(), practice = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); slot.current = fakeStore(); kind.value = 'bank'; host = hostNode('root'); app = null;
  storedPageSizes = new Map();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => storedPageSizes.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { storedPageSizes.set(key, String(value)); }),
  });
  vi.mocked(ElMessageBox.confirm).mockResolvedValue('confirm');
});
afterEach(() => { app?.unmount(); vi.unstubAllGlobals(); });
async function mount(next: 'bank' | 'history' = 'bank') {
  kind.value = next;
  app = renderer.createApp({ setup: () => () => h(StudyManagement, { kind: kind.value, onReview: review, onSession: session, onPractice: practice }) });
  app.mount(host); await settle();
}
function field(label: string) {
  const node = descendants(host).find(node => ['input', 'select'].includes(node.tag) && node.props['aria-label'] === label);
  if (!node) throw new Error(`未找到字段：${label}`);
  return node;
}
async function value(label: string, text: string) {
  const node = field(label); node.value = text;
  const handler = node.props[node.tag === 'select' ? 'onChange' : 'onInput'];
  await handler({ target: node }); await settle();
}
async function check(label: string, checked = true) {
  const node = field(label); node.checked = checked;
  await node.props.onChange({ target: node }); await settle();
}
function rowIds(prefix: '题目' | '答题记录') {
  return descendants(host).filter(node => node.tag === 'article' && String(node.props['aria-label']).startsWith(prefix + ' '))
    .map(node => String(node.props['aria-label']).slice(prefix.length + 1));
}
function row(id: string) {
  const node = descendants(host).find(node => node.tag === 'article' && String(node.props['aria-label']).endsWith(' ' + id));
  if (!node) throw new Error(`未找到记录：${id}`);
  return node;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function growQuestionBank(normalCount: number) {
  const currentNormal = slot.current.questions.filter((question: any) => !slot.current.questionRecords[question.id].removed).length;
  const sample = slot.current.questions[0];
  for (let index = currentNormal; index < normalCount; index++) {
    const id = `EXTRA-${String(index + 1).padStart(3, '0')}`;
    slot.current.questions.push({ ...sample, id, stem: `追加的完整题目${index + 1}` });
    slot.current.questionRecords[id] = { removed: false, revision: 0 };
  }
}
function selectedPageSize(label = '每页条数') { return String(field(label).props.value); }
async function remount(next: 'bank' | 'history') {
  app?.unmount(); app = null; host = hostNode('root'); await mount(next);
}

describe('管理列表每页条数的真实组件交互', () => {
  it('上下控件同步20/50/100/200条，切换回首页清勾选，批量操作仍仅覆盖当前页', async () => {
    growQuestionBank(225);
    await mount();
    for (const label of ['每页条数', '每页条数（底部）']) {
      expect(field(label).options.map(option => String(option.props.value))).toEqual(['20', '50', '100', '200']);
      expect(selectedPageSize(label)).toBe('20');
    }
    expect(rowIds('题目')).toHaveLength(20);
    expect(visibleText(host)).toContain('第 1 / 12 页');
    await click(button(host, '下一页'));
    await check('全选本页');
    expect(visibleText(host)).toContain('已选 20 条');

    await value('每页条数', '50');
    expect(rowIds('题目')).toHaveLength(50);
    expect(rowIds('题目')[0]).toBe('Q-01');
    expect(selectedPageSize('每页条数（底部）')).toBe('50');
    expect(visibleText(host)).toContain('第 1 / 5 页');
    expect(visibleText(host)).toContain('已选 0 条');
    await check('全选本页');
    expect(visibleText(host)).toContain('已选 50 条');
    await click(button(host, '下一页'));
    await check('全选本页');

    await value('每页条数（底部）', '100');
    expect(rowIds('题目')).toHaveLength(100);
    expect(rowIds('题目')[0]).toBe('Q-01');
    expect(selectedPageSize()).toBe('100');
    expect(visibleText(host)).toContain('第 1 / 3 页');
    expect(visibleText(host)).toContain('已选 0 条');
    await value('每页条数', '200');
    expect(rowIds('题目')).toHaveLength(200);
    expect(selectedPageSize('每页条数（底部）')).toBe('200');
    expect(visibleText(host)).toContain('第 1 / 2 页');
    await click(button(host, '下一页'));
    const finalPage = rowIds('题目');
    expect(finalPage).toHaveLength(25);
    expect(visibleText(host)).toContain('201—225 / 225 条');
    await check('全选本页');
    expect(visibleText(host)).toContain('已选 25 条');
    await click(button(host, '删除选中题目'));
    expect(slot.current.removeQuestionRecords).toHaveBeenCalledWith(finalPage);
    expect(slot.current.questionRecords['Q-01'].removed).toBe(false);
    expect(visibleText(host)).toContain('第 1 / 1 页');
    expect(rowIds('题目')).toHaveLength(200);
    expect(visibleText(host)).toContain('已选 0 条');
  });

  it('题库与历史分别保存偏好，kind切换和重新创建组件均恢复各自条数', async () => {
    await mount();
    await value('每页条数（底部）', '50');
    expect(rowIds('题目')).toHaveLength(22);
    expect(storedPageSizes.get('yankao-management-page-size-bank')).toBe('50');
    await check('选择题目 Q-01');
    kind.value = 'history'; await settle();
    expect(selectedPageSize()).toBe('20');
    expect(rowIds('答题记录')).toHaveLength(20);
    expect(visibleText(host)).toContain('第 1 / 2 页');
    expect(visibleText(host)).toContain('已选 0 条');
    await click(button(host, '下一页'));
    await check('选择记录 S-21');
    await value('每页条数', '100');
    expect(rowIds('答题记录')).toHaveLength(21);
    expect(rowIds('答题记录')[0]).toBe('S-01');
    expect(visibleText(host)).toContain('第 1 / 1 页');
    expect(visibleText(host)).toContain('已选 0 条');
    expect(storedPageSizes.get('yankao-management-page-size-history')).toBe('100');
    expect(storedPageSizes.get('yankao-management-page-size-bank')).toBe('50');

    kind.value = 'bank'; await settle();
    expect(selectedPageSize()).toBe('50');
    expect(rowIds('题目')).toHaveLength(22);
    await remount('history');
    expect(selectedPageSize()).toBe('100');
    expect(selectedPageSize('每页条数（底部）')).toBe('100');
    expect(rowIds('答题记录')).toHaveLength(21);
    await remount('bank');
    expect(selectedPageSize()).toBe('50');
    expect(rowIds('题目')).toHaveLength(22);
  });

  it('删除确认和请求期间冻结两个条数选择器，拒绝迟到change且保留勾选范围', async () => {
    await mount(); await check('选择题目 Q-01');
    const confirmation = deferred(), request = deferred();
    vi.mocked(ElMessageBox.confirm).mockReturnValueOnce(confirmation.promise as any);
    slot.current.removeQuestionRecords.mockImplementationOnce(async () => { await request.promise; throw new Error('暂时断线'); });
    const operation = click(button(host, '删除选中题目')); await settle();
    expect(field('每页条数').props.disabled).toBe(true);
    expect(field('每页条数（底部）').props.disabled).toBe(true);
    await value('每页条数', '50');
    expect(rowIds('题目')).toHaveLength(20);
    expect(selectedPageSize()).toBe('20');
    expect(field('选择题目 Q-01').checked).toBe(true);
    confirmation.resolve(); await settle();
    await value('每页条数（底部）', '100');
    expect(selectedPageSize()).toBe('20');
    expect(rowIds('题目')).toHaveLength(20);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    request.resolve(); await operation;
    expect(field('每页条数').props.disabled).toBe(false);
    expect(field('每页条数（底部）').props.disabled).toBe(false);
    expect(field('选择题目 Q-01').checked).toBe(true);
    await value('每页条数（底部）', '50');
    expect(rowIds('题目')).toHaveLength(22);
    expect(visibleText(host)).toContain('已选 0 条');
  });

  it.each(['0', '25', '201', '-50', 'NaN', '{}'])('非法存储值 %j 回到20条，不影响另一类列表的有效偏好', async invalid => {
    storedPageSizes.set('yankao-management-page-size-bank', invalid);
    storedPageSizes.set('yankao-management-page-size-history', '50');
    await mount();
    expect(selectedPageSize()).toBe('20');
    expect(rowIds('题目')).toHaveLength(20);
    kind.value = 'history'; await settle();
    expect(selectedPageSize()).toBe('50');
    expect(rowIds('答题记录')).toHaveLength(21);
  });

  it('浏览器拒绝读写存储时使用默认值，当前页仍可切换条数且不抛出异常', async () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => { throw new Error('存储读取被拒绝'); });
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('存储写入被拒绝'); });
    await mount();
    expect(selectedPageSize()).toBe('20');
    expect(rowIds('题目')).toHaveLength(20);
    await value('每页条数', '50');
    expect(rowIds('题目')).toHaveLength(22);
    expect(selectedPageSize('每页条数（底部）')).toBe('50');
    expect(ElMessage.error).not.toHaveBeenCalled();
    await remount('bank');
    expect(selectedPageSize()).toBe('20');
    expect(rowIds('题目')).toHaveLength(20);
  });
});

describe('题库管理真实SFC', () => {
  it('直接提供完整题目、选项、答案、解析和HTTPS来源，并发出研究及练习事件', async () => {
    await mount();
    expect(rowIds('题目')).toHaveLength(20);
    const content = visibleText(row('Q-01'));
    for (const text of ['Q-01', '计算机网络', '基础', '单选', '完整题干', '选项A-1', '专属检索词', '正确答案： A', '第1题完整解析']) expect(content).toContain(text);
    expect(descendants(row('Q-01')).some(node => node.tag === 'details')).toBe(true);
    const links = descendants(row('Q-01')).filter(node => node.tag === 'a');
    expect(links.map(node => node.props.href)).toEqual(['https://www.rfc-editor.org/rfc/rfc9110.html']);
    await click(button(host, '研究题目 Q-01'));
    expect(review).toHaveBeenCalledWith(slot.current.questions[0]);
    await click(button(host, '开始练习'));
    expect(practice).toHaveBeenCalledOnce();
    for (const node of descendants(host).filter(node => node.tag === 'button')) {
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) expect(ancestor.tag).not.toBe('button');
    }
  });

  it('搜索覆盖题号、选项和知识点，分类/题型/难度联合筛选并清空旧选择', async () => {
    await mount();
    await check('选择题目 Q-01');
    await value('搜索题库', '专属检索词');
    expect(rowIds('题目')).toEqual(['Q-01']);
    expect(visibleText(host)).toContain('已选 0 条');
    await value('搜索题库', '独有知识坐标');
    expect(rowIds('题目')).toEqual(['Q-02']);
    await value('搜索题库', 'q-03');
    expect(rowIds('题目')).toEqual(['Q-03']);
    await value('搜索题库', '');
    await value('按分类筛选', '计算机网络');
    await value('按题型筛选', 'multiple');
    await value('按难度筛选', '基础');
    expect(rowIds('题目')).toEqual(['Q-03', 'Q-09', 'Q-15', 'Q-21']);
    await check('全选本页');
    await value('按难度筛选', '进阶');
    expect(rowIds('题目')).toEqual([]);
    expect(visibleText(host)).toContain('已选 0 条');
  });

  it('分页清除选择，全选仅覆盖本页，删除只提交这一页实际选中的ID', async () => {
    await mount();
    await check('全选本页');
    expect(visibleText(host)).toContain('已选 20 条');
    await click(button(host, '下一页'));
    expect(rowIds('题目')).toEqual(['Q-21', 'Q-22']);
    expect(visibleText(host)).toContain('已选 0 条');
    await check('全选本页');
    await check('选择题目 Q-22', false);
    expect(visibleText(host)).toContain('已选 1 条');
    await click(button(host, '删除选中题目'));
    expect(slot.current.removeQuestionRecords).toHaveBeenCalledWith(['Q-21']);
    expect(slot.current.questionRecords['Q-01'].removed).toBe(false);
    expect(slot.current.questionRecords['Q-22'].removed).toBe(false);
    expect(visibleText(host)).toContain('已选 0 条');
  });

  it('取消删除保留勾选，确认说明仅移出后续练习且保留作答/笔记/解析', async () => {
    await mount(); await check('选择题目 Q-01');
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel');
    await click(button(host, '删除选中题目'));
    const message = String(vi.mocked(ElMessageBox.confirm).mock.calls[0][0]);
    for (const part of ['后续练习', '作答', '笔记', '解析', '恢复']) expect(message).toContain(part);
    expect(slot.current.removeQuestionRecords).not.toHaveBeenCalled();
    expect(field('选择题目 Q-01').checked).toBe(true);
    expect(visibleText(host)).toContain('已选 1 条');
  });

  it('确认和请求期间冻结操作，不乐观删除，失败保留勾选并允许重试', async () => {
    await mount(); await check('选择题目 Q-01');
    const confirmation = deferred(), request = deferred();
    vi.mocked(ElMessageBox.confirm).mockReturnValueOnce(confirmation.promise as any);
    slot.current.removeQuestionRecords.mockImplementationOnce(async () => { await request.promise; throw new Error('请求未完成'); });
    const operation = click(button(host, '删除选中题目')); await settle();
    expect(slot.current.removeQuestionRecords).not.toHaveBeenCalled();
    expect(field('搜索题库').props.disabled).toBe(true);
    expect(field('按分类筛选').props.disabled).toBe(true);
    expect(field('选择题目 Q-01').props.disabled).toBe(true);
    expect(button(host, '下一页').props.disabled).toBe(true);
    confirmation.resolve(); await settle();
    expect(rowIds('题目')).toContain('Q-01');
    expect(visibleText(host)).toContain('已选 1 条');
    request.resolve(); await operation;
    expect(field('选择题目 Q-01').checked).toBe(true);
    expect(visibleText(host)).toContain('请求未完成');
    expect(ElMessage.error).toHaveBeenCalledWith('请求未完成');
    await click(button(host, '删除选中题目'));
    expect(slot.current.removeQuestionRecords).toHaveBeenNthCalledWith(2, ['Q-01']);
    expect(rowIds('题目')).not.toContain('Q-01');
  });

  it('409同步后按实际可见范围清理选择，提示核对最新记录而不承诺全部保留', async () => {
    await mount(); await check('选择题目 Q-01');
    slot.current.removeQuestionRecords.mockImplementationOnce(async () => {
      slot.current.questionRecords['Q-01'].removed = true;
      throw Object.assign(new Error('其他页面已经删除此题'), { status: 409 });
    });
    await click(button(host, '删除选中题目'));
    expect(rowIds('题目')).not.toContain('Q-01');
    expect(visibleText(host)).toContain('已选 0 条');
    expect(visibleText(host)).toContain('已同步最新状态，请核对后重新选择');
  });

  it('已删除题目可直接预览/研究，恢复无需确认且失败保留选择', async () => {
    await mount(); await click(button(host, '已删除'));
    expect(rowIds('题目')).toEqual(['Q-23', 'Q-24']);
    expect(visibleText(row('Q-23'))).toContain('第23题完整解析');
    await click(button(host, '研究题目 Q-23'));
    expect(review).toHaveBeenCalledWith(slot.current.questions[22]);
    await check('选择题目 Q-23');
    slot.current.restoreQuestionRecords.mockRejectedValueOnce(new Error('恢复失败'));
    await click(button(host, '恢复选中题目'));
    expect(field('选择题目 Q-23').checked).toBe(true);
    await click(button(host, '恢复选中题目'));
    expect(slot.current.restoreQuestionRecords).toHaveBeenCalledWith(['Q-23']);
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
    expect(rowIds('题目')).toEqual(['Q-24']);
    expect(slot.current.progress['Q-01']).toMatchObject({ note: '应保留的学习笔记', aiNote: '应保留的AI解析', attempts: 10 });
  });

  it('旧store缺省管理元数据仍能完整浏览，外部busy同样冻结交互', async () => {
    delete slot.current.questionRecords;
    await mount();
    expect(rowIds('题目')).toHaveLength(20);
    slot.current.busy = true; await settle();
    expect(field('全选本页').props.disabled).toBe(true);
    expect(button(host, '研究题目 Q-01').props.disabled).toBe(true);
    await check('选择题目 Q-01');
    expect(visibleText(host)).toContain('已选 0 条');
  });
});

describe('答题记录管理真实SFC', () => {
  it('正常记录继续/复盘发送原记录，搜索模式名/日期/ID及状态筛选可组合', async () => {
    await mount('history');
    expect(rowIds('答题记录')).toHaveLength(20);
    await click(button(host, '打开记录 S-01'));
    expect(session).toHaveBeenCalledWith(slot.current.sessions[0]);
    await click(button(host, '打开记录 S-02'));
    expect(session).toHaveBeenCalledWith(slot.current.sessions[1]);
    await value('搜索答题记录', 'S-02');
    expect(rowIds('答题记录')).toEqual(['S-02']);
    await value('搜索答题记录', '模拟考试');
    expect(rowIds('答题记录').every(id => Number(id.slice(-2)) % 2 === 1)).toBe(true);
    await value('搜索答题记录', '2026-10-21');
    await value('按完成状态筛选', 'completed');
    expect(rowIds('答题记录').every(id => Number(id.slice(-2)) % 2 === 0)).toBe(true);
    await check('全选本页');
    await value('按完成状态筛选', 'active');
    expect(visibleText(host)).toContain('已选 0 条');
  });

  it('删除记录确认说明统计不回退、答案成绩保留，取消不修改；成功仅移出所选记录', async () => {
    await mount('history'); await check('选择记录 S-02');
    const before = JSON.stringify(slot.current.sessions[1]);
    vi.mocked(ElMessageBox.confirm).mockRejectedValueOnce('cancel');
    await click(button(host, '删除选中记录'));
    const message = String(vi.mocked(ElMessageBox.confirm).mock.calls[0][0]);
    for (const part of ['累计答题统计不回退', '原答案', '成绩', '恢复', '不会重新计时']) expect(message).toContain(part);
    expect(JSON.stringify(slot.current.sessions[1])).toBe(before);
    expect(field('选择记录 S-02').checked).toBe(true);
    await click(button(host, '删除选中记录'));
    expect(slot.current.removeSessionRecords).toHaveBeenCalledWith(['S-02']);
    expect(slot.current.sessions[1]).toMatchObject({ removed: true, score: 50, answers: { 'Q-01': ['B'], 'Q-02': ['A'] } });
    expect(slot.current.removeQuestionRecords).not.toHaveBeenCalled();
  });

  it('已删除记录只能预览原题和作答，恢复进行中的考试不重置原截止时间', async () => {
    await mount('history'); await click(button(host, '已删除'));
    expect(rowIds('答题记录')).toEqual(['S-22', 'S-23']);
    expect(descendants(host).some(node => node.tag === 'button' && String(node.props['aria-label']).startsWith('打开记录'))).toBe(false);
    const preview = visibleText(row('S-22'));
    for (const text of ['题目1的完整题干', '仅选项包含的专属检索词', '我的答案： B', '原截止时间']) expect(preview).toContain(text);
    const deadline = slot.current.sessions[21].deadlineAt;
    await check('选择记录 S-22'); await click(button(host, '恢复选中记录'));
    expect(slot.current.restoreSessionRecords).toHaveBeenCalledWith(['S-22']);
    expect(slot.current.sessions[21].deadlineAt).toBe(deadline);
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    await click(button(host, '正常记录'));
    await value('搜索答题记录', 'S-22');
    await click(button(host, '打开记录 S-22'));
    expect(session).toHaveBeenCalledWith(expect.objectContaining({ id: 'S-22', deadlineAt: deadline }));
  });

  it('历史分页和kind切换都清空选择，迟到的题库请求只作用于原题库', async () => {
    await mount('history'); await check('全选本页');
    await click(button(host, '下一页'));
    expect(rowIds('答题记录')).toEqual(['S-21']);
    expect(visibleText(host)).toContain('已选 0 条');
    await check('选择记录 S-21');
    kind.value = 'bank'; await settle();
    expect(visibleText(host)).toContain('已选 0 条');
    await check('选择题目 Q-01');
    const held = deferred();
    slot.current.removeQuestionRecords.mockImplementationOnce(async (ids: string[]) => {
      await held.promise; for (const id of ids) slot.current.questionRecords[id].removed = true;
    });
    const operation = click(button(host, '删除选中题目')); await settle();
    kind.value = 'history'; await settle();
    held.resolve(); await operation;
    expect(slot.current.removeQuestionRecords).toHaveBeenCalledWith(['Q-01']);
    expect(slot.current.removeSessionRecords).not.toHaveBeenCalled();
    await check('选择记录 S-01');
    expect(visibleText(host)).toContain('已选 1 条');
  });

  it('恢复历史记录失败时显示错误并保留选择，不发出继续答题事件', async () => {
    await mount('history'); await click(button(host, '已删除')); await check('选择记录 S-22');
    slot.current.restoreSessionRecords.mockRejectedValueOnce(new Error('历史恢复未完成'));
    await click(button(host, '恢复选中记录'));
    expect(visibleText(host)).toContain('历史恢复未完成');
    expect(field('选择记录 S-22').checked).toBe(true);
    expect(slot.current.sessions[21].removed).toBe(true);
    expect(session).not.toHaveBeenCalled();
  });
});
