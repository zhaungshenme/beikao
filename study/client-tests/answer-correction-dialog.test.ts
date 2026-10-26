import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AnswerCorrectionDialog from '@/views/study/AnswerCorrectionDialog.vue';
import type { AnswerHistoryEntry, QuestionAnswerChanges, StudyQuestion } from '@/api/study/types';
import { type HostNode, hostNode, renderer, descendants, visibleText, button, click, settle } from './vue-memory-host';

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), restore: vi.fn(), confirm: vi.fn(), success: vi.fn(), close: vi.fn() }));
vi.mock('@/api/study', () => ({ loadQuestionAnswerHistory: mocks.load }));
vi.mock('@/store/modules/study', () => ({ useStudyStore: () => ({ correctQuestionAnswer: mocks.save, restoreQuestionAnswerVersion: mocks.restore }) }));
vi.mock('element-plus', () => ({ ElMessage: { success: mocks.success }, ElMessageBox: { confirm: mocks.confirm } }));

const original: StudyQuestion = { id: 'Q-1', category: '计算机网络', chapter: '基础', type: 'single', difficulty: '基础',
  stem: '标准答案维护测试', options: [{ id: 'A', text: '原选项' }, { id: 'B', text: '纠正项' }],
  answer: ['A'], answerRevision: 0, explanation: '原题解析', knowledgePoint: '网络基础', source: '原创题' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let remote: StudyQuestion;
let entries: AnswerHistoryEntry[];
let host: HostNode;
let app: ReturnType<typeof renderer.createApp> | null;
function version(q: StudyQuestion, source: AnswerHistoryEntry['source'] = 'correction'): AnswerHistoryEntry {
  return { id: `version-${q.answerRevision}`, revision: q.answerRevision ?? 0, answer: [...q.answer],
    explanation: q.explanation, note: q.answerCorrectionNote || '', createdAt: '2026-10-22T00:00:00.000Z', source };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { activeElement: null });
  remote = clone(original); entries = [version(remote, 'original')]; host = hostNode('root'); app = null;
  mocks.load.mockImplementation(async () => clone({ question: remote, entries }));
  mocks.confirm.mockResolvedValue('confirm');
  mocks.save.mockImplementation(async (_id: string, changes: QuestionAnswerChanges) => {
    remote = { ...remote, answer: [...changes.answer], explanation: changes.explanation,
      answerCorrectionNote: changes.note, answerRevision: changes.expectedRevision + 1 };
    entries.push(version(remote)); return clone(remote);
  });
  mocks.restore.mockImplementation(async (_id: string, historyId: string, revision: number) => {
    const entry = entries.find(entry => entry.id === historyId)!;
    remote = { ...remote, answer: [...entry.answer], explanation: entry.explanation,
      answerCorrectionNote: '恢复历史版本', answerRevision: revision + 1 };
    entries.push(version(remote, 'restore')); return clone(remote);
  });
});
afterEach(() => { app?.unmount(); vi.unstubAllGlobals(); });
async function mount(question: StudyQuestion = original) {
  app = renderer.createApp(AnswerCorrectionDialog, { question: clone(question), onClose: mocks.close });
  app.mount(host); await settle();
}
function field(label: string) {
  const result = descendants(host).find(node => node.props['aria-label'] === label);
  if (!result) throw new Error(`未找到字段：${label}`);
  return result;
}
async function choose(id: string, checked = true) {
  const input = field(`正确选项 ${id}`); input.checked = checked;
  await input.props.onChange({ target: input }); await settle();
}
async function text(label: string, value: string) {
  const input = field(label); input.value = value;
  input.dispatchEvent({ type: 'input', target: input } as any); await settle();
}
const disabled = (label: string) => Boolean(button(host, label).props.disabled);

describe('答案纠正编辑器交互与草稿保护', () => {
  it('初始读取很慢时仍可关闭，迟到响应不会执行保存', async () => {
    let resolve!: (value: unknown) => void;
    mocks.load.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await mount(); expect(disabled('保存纠正')).toBe(true); expect(disabled('关闭答案纠正')).toBe(false);
    await click(button(host, '关闭答案纠正')); expect(mocks.close).toHaveBeenCalledTimes(1);
    app?.unmount(); app = null; resolve(clone({ question: remote, entries })); await settle();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('打开时读取服务端最新标准，单选与保存基线跟随最新版本', async () => {
    remote = { ...remote, answer: ['B'], answerRevision: 2, explanation: '服务器新解析' };
    entries.push(version(remote)); await mount();
    expect(field('正确选项 B').checked).toBe(true);
    expect(field('纠正后的题目解析').value).toBe('服务器新解析');
    expect(disabled('保存纠正')).toBe(true);
    await choose('A'); await click(button(host, '保存纠正'));
    expect(mocks.save).toHaveBeenCalledWith('Q-1', expect.objectContaining({ answer: ['A'], expectedRevision: 2 }));
  });

  it('保存冻结字段并阻止重复请求，成功保留弹窗及完整新版本', async () => {
    let resolve!: (value: StudyQuestion) => void;
    mocks.save.mockImplementationOnce(() => new Promise<StudyQuestion>(done => { resolve = done; }));
    await mount(); await choose('B'); await text('纠正后的题目解析', '纠正后的依据'); await text('答案纠正说明', '核对文档');
    const pending = button(host, '保存纠正').props.onClick(); await settle();
    expect(disabled('保存纠正')).toBe(true); expect(disabled('关闭答案纠正')).toBe(true);
    expect(field('纠正后的题目解析').props.disabled).toBe(true);
    await button(host, '保存纠正').props.onClick(); expect(mocks.save).toHaveBeenCalledTimes(1);
    remote = { ...remote, answer: ['B'], explanation: '纠正后的依据', answerCorrectionNote: '核对文档', answerRevision: 1 };
    entries.push(version(remote)); resolve(clone(remote)); await pending; await settle();
    expect(mocks.close).not.toHaveBeenCalled(); expect(mocks.success).toHaveBeenCalled();
    expect(visibleText(host)).toContain('版本 1'); expect(visibleText(host)).toContain('核对文档');
    expect(field('答案纠正说明').value).toBe(''); expect(disabled('保存纠正')).toBe(true);
    await click(button(host, '关闭答案纠正')); expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('多选至少一项，空解析和超长说明不能提交', async () => {
    remote.type = 'multiple'; await mount({ ...original, type: 'multiple' });
    await choose('A', false); expect(disabled('保存纠正')).toBe(true);
    await choose('B'); await text('纠正后的题目解析', '  '); expect(disabled('保存纠正')).toBe(true);
    await text('纠正后的题目解析', '新解析'); await text('答案纠正说明', '长'.repeat(2001));
    expect(disabled('保存纠正')).toBe(true); await button(host, '保存纠正').props.onClick();
    expect(mocks.save).not.toHaveBeenCalled();
    await text('答案纠正说明', '已核对'); expect(disabled('保存纠正')).toBe(false);
  });

  it('取消需要确认放弃草稿，拒绝确认后内容完整保留', async () => {
    await mount(); await choose('B'); await text('纠正后的题目解析', '未保存的解析');
    mocks.confirm.mockRejectedValueOnce(new Error('cancel'));
    await click(button(host, '取消')); expect(mocks.close).not.toHaveBeenCalled();
    expect(field('正确选项 B').checked).toBe(true); expect(field('纠正后的题目解析').value).toBe('未保存的解析');
    await click(button(host, '取消')); expect(mocks.close).toHaveBeenCalledTimes(1); expect(mocks.save).not.toHaveBeenCalled();
  });

  it('保存冲突保留全部草稿，明确比较后才允许基于最新版本再次保存', async () => {
    await mount(); await choose('B'); await text('纠正后的题目解析', '我的纠正依据'); await text('答案纠正说明', '我的说明');
    remote = { ...remote, answerRevision: 3, explanation: '另一页的解析' }; entries.push(version(remote));
    mocks.save.mockRejectedValueOnce(Object.assign(new Error('冲突'), { code: 'WRITE_CONFLICT', current: clone(remote) }));
    await click(button(host, '保存纠正'));
    expect(visibleText(host)).toContain('另一页面已保存版本 3'); expect(disabled('保存纠正')).toBe(true);
    expect(field('纠正后的题目解析').value).toBe('我的纠正依据'); expect(field('答案纠正说明').value).toBe('我的说明');
    mocks.confirm.mockRejectedValueOnce(new Error('cancel'));
    await click(button(host, '载入最新版本')); expect(field('纠正后的题目解析').value).toBe('我的纠正依据');
    await click(button(host, '已比较，保留我的修改')); expect(disabled('保存纠正')).toBe(false);
    await click(button(host, '保存纠正'));
    expect(mocks.save).toHaveBeenLastCalledWith('Q-1', { answer: ['B'], explanation: '我的纠正依据', note: '我的说明', expectedRevision: 3 });
  });

  it('可放弃草稿载入冲突中的最新标准，不自动覆盖', async () => {
    await mount(); await choose('B');
    remote = { ...remote, answerRevision: 2, explanation: '最新解析' }; entries.push(version(remote));
    mocks.save.mockRejectedValueOnce(Object.assign(new Error('冲突'), { code: 'WRITE_CONFLICT', current: clone(remote) }));
    await click(button(host, '保存纠正')); await click(button(host, '载入最新版本'));
    expect(field('正确选项 A').checked).toBe(true); expect(field('纠正后的题目解析').value).toBe('最新解析');
    expect(disabled('保存纠正')).toBe(true); expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('恢复必须确认，恢复创建新版本并保留原有历史', async () => {
    remote = { ...remote, answer: ['B'], explanation: '纠正解析', answerRevision: 1 }; entries.push(version(remote));
    await mount(); mocks.confirm.mockRejectedValueOnce(new Error('cancel'));
    await click(button(host, '恢复答案版本 0')); expect(mocks.restore).not.toHaveBeenCalled();
    await click(button(host, '恢复答案版本 0'));
    expect(mocks.restore).toHaveBeenCalledWith('Q-1', 'version-0', 1);
    expect(field('正确选项 A').checked).toBe(true); expect(visibleText(host)).toContain('版本历史与恢复（3）');
    expect(visibleText(host)).toContain('版本 2'); expect(mocks.close).not.toHaveBeenCalled();
  });

  it('初始读取失败冻结保存，可重试；保存失败也不清空草稿', async () => {
    mocks.load.mockRejectedValueOnce(new Error('暂时断连')); await mount();
    expect(visibleText(host)).toContain('暂时断连'); expect(disabled('保存纠正')).toBe(true);
    await click(button(host, '重试读取版本')); await choose('B');
    mocks.save.mockRejectedValueOnce(new Error('写盘失败'));
    await click(button(host, '保存纠正'));
    expect(visibleText(host)).toContain('写盘失败'); expect(field('正确选项 B').checked).toBe(true);
    expect(disabled('保存纠正')).toBe(false); expect(mocks.close).not.toHaveBeenCalled();
  });

  it('保存成功后历史刷新失败可单独重试，不丢随后编辑的草稿', async () => {
    await mount(); await choose('B'); mocks.load.mockRejectedValueOnce(new Error('历史暂时不可用'));
    await click(button(host, '保存纠正')); expect(mocks.success).toHaveBeenCalled();
    expect(visibleText(host)).toContain('纠正已保存，但版本历史刷新失败');
    await text('纠正后的题目解析', '下一次未保存的草稿');
    await click(button(host, '重试读取版本'));
    expect(field('纠正后的题目解析').value).toBe('下一次未保存的草稿');
    expect(disabled('保存纠正')).toBe(false); expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});
