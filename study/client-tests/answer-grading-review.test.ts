import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import StudyWorkspace from '@/views/study/StudyWorkspace.vue';
import { emptyProgress } from '@/store/modules/study';
import { resetStudyBridge } from '@/store/modules/studyBridge';
import { studyGradingResult } from '@/utils/studyGrading';
import * as api from '@/api/study';
import type { StudyBootstrap, StudyQuestion, StudySession } from '@/api/study/types';
import { type HostNode, hostNode, renderer, descendants, visibleText, button, click, settle } from './vue-memory-host';

vi.mock('@/api/study', () => ({
  loadStudy: vi.fn(), getBridgeStatus: vi.fn(), getBridgeOverview: vi.fn(),
}));
vi.mock('element-plus', () => ({
  ElMessage: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  ElMessageBox: { confirm: vi.fn().mockResolvedValue('confirm') },
}));

const time = '2026-10-21T00:00:00.000Z';
const question: StudyQuestion = {
  id: 'Q-1', category: '计算机网络', chapter: '基础', type: 'single', difficulty: '基础',
  stem: '答案已被纠正的历史题目', options: [{ id: 'A', text: '原选项' }, { id: 'B', text: '纠正选项' }],
  answer: ['B'], answerRevision: 1, explanation: '纠正后的解析', knowledgePoint: '测试知识点', source: '原创题',
};
function session(status: 'active' | 'completed' = 'completed'): StudySession {
  return { id: 'S-1', removed: false, revision: 1, mode: 'sequential', questionIds: ['Q-1'],
    answers: { 'Q-1': ['A'] }, submittedQuestionIds: ['Q-1'], createdAt: time, deadlineAt: null,
    status, score: 100, correctCount: 1, cursor: 0, gradedResults: {
      'Q-1': { questionId: 'Q-1', correct: true, answer: ['A'], userAnswer: ['A'],
        explanation: '当时的原解析', questionRevision: 0 },
    } };
}

describe('历史判分标准', () => {
  it('已判分练习和完成记录都保留当时标准，返回副本避免显示层改写快照', () => {
    for (const status of ['active', 'completed'] as const) {
      const saved = session(status);
      const result = studyGradingResult(question, saved);
      expect(result).toMatchObject({ correct: true, answer: ['A'], explanation: '当时的原解析',
        userAnswer: ['A'], questionRevision: 0, standardUpdated: true, snapshot: true });
      result.answer.push('B'); result.userAnswer.pop();
      expect(saved.gradedResults!['Q-1'].answer).toEqual(['A']);
      expect(saved.gradedResults!['Q-1'].userAnswer).toEqual(['A']);
    }
  });
  it('未提交题和独立研究页使用当前标准，不把历史统计重新解释成当前判分', () => {
    const active = session('active'); active.submittedQuestionIds = [];
    expect(studyGradingResult(question, active)).toMatchObject({ correct: false, answer: ['B'], snapshot: false });
    expect(studyGradingResult(question, null, ['B'])).toMatchObject({ correct: true, answer: ['B'], snapshot: false });
    const old = session(); delete old.gradedResults;
    expect(studyGradingResult({ ...question, answerRevision: undefined }, old)).toMatchObject({ questionRevision: 0, snapshot: false });
  });
  it('外部分支的相同版本号也按答案和解析检测差异，选项顺序不造成误报', () => {
    const saved = session(); saved.gradedResults!['Q-1'].questionRevision = 1;
    expect(studyGradingResult(question, saved).standardUpdated).toBe(true);
    saved.gradedResults!['Q-1'].answer = ['B'];
    expect(studyGradingResult(question, saved).standardUpdated).toBe(true);
    saved.gradedResults!['Q-1'].explanation = question.explanation;
    expect(studyGradingResult(question, saved).standardUpdated).toBe(false);
    saved.gradedResults!['Q-1'].answer = ['B', 'A'];
    expect(studyGradingResult({ ...question, answer: ['A', 'B'] }, saved).standardUpdated).toBe(false);
  });
});

let host: HostNode;
let app: ReturnType<typeof renderer.createApp> | null;
let saved: StudySession;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(time)); vi.resetAllMocks();
  resetStudyBridge(); setActivePinia(createPinia());
  vi.stubGlobal('window', { innerWidth: 1280, setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
  vi.stubGlobal('document', { hidden: false, activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  for (const storage of ['localStorage', 'sessionStorage']) vi.stubGlobal(storage, { getItem: vi.fn(() => null), setItem: vi.fn() });
  saved = session(); host = hostNode('root'); app = null;
  vi.mocked(api.loadStudy).mockImplementation(async () => JSON.parse(JSON.stringify({ questions: [question],
    questionRecords: {}, progress: { 'Q-1': { ...emptyProgress(), lastAnswer: ['A'], lastCorrect: true,
      aiNote: '上次保存的AI正文' } }, sessions: [saved], activeSession: saved.status === 'active' ? saved : null,
    ai: { configured: false, baseUrl: '', model: '', webUrl: 'https://chatglm.cn/main/alltoolsdetail?lang=zh' },
  } satisfies StudyBootstrap)));
  vi.mocked(api.getBridgeStatus).mockResolvedValue({ connected: false, version: null, lastSeenAt: null });
  vi.mocked(api.getBridgeOverview).mockResolvedValue({ activeJob: null, latestJob: null,
    serverTime: time, limits: { totalTimeoutMs: 240000, idleTimeoutMs: 120000 } });
});
afterEach(() => { app?.unmount(); resetStudyBridge(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('真实答题页面的历史标准显示', () => {
  it('成绩、选项标记和答题卡一致保留旧判分，并展示新标准及AI解析提醒', async () => {
    app = renderer.createApp(StudyWorkspace); app.mount(host); await settle();
    await click(button(host, '学习记录')); await click(button(host, '打开记录 S-1'));
    const text = visibleText(host);
    expect(text).toContain('正确率 100%'); expect(text).toContain('✓ 回答正确');
    expect(text).toContain('当时标准答案'); expect(text).toContain('当时的原解析');
    expect(text).toContain('标准答案已更新'); expect(text).toContain('当前标准答案：B');
    expect(text).toContain('AI 解析使用当前标准答案');
    const options = descendants(host).filter(node => node.tag === 'button' && String(node.props.class).split(' ').includes('option'));
    expect(options).toHaveLength(2);
    expect(String(options[0].props.class)).toContain('correct');
    expect(String(options[1].props.class)).not.toContain('correct');
    const card = descendants(host).find(node => node.tag === 'button' && node.props['aria-label'] === '第1题')!;
    expect(String(card.props.class)).not.toContain('wrong');
  });
  it('独立研究明确按当前标准比对，保留已有AI正文', async () => {
    app = renderer.createApp(StudyWorkspace); app.mount(host); await settle();
    await click(button(host, '题库管理')); await click(button(host, '研究题目 Q-1'));
    expect(visibleText(host)).toContain('按当前标准比对最后一次作答');
    expect(visibleText(host)).toContain('✕ 还需要巩固');
    expect(visibleText(host)).toContain('纠正后的解析');
    expect(visibleText(host)).toContain('上次保存的AI正文');
  });
});
