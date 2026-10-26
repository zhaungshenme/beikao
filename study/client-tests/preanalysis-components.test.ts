import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, reactive } from 'vue';
import PreanalysisManager from '@/views/study/components/PreanalysisManager.vue';
import PreparedExplanation from '@/views/study/components/PreparedExplanation.vue';
import * as api from '@/api/study';
import type { PreanalysisSettings, PreanalysisStatus, PreparedExplanation as Prepared, StudyQuestion } from '@/api/study/types';
import { type HostNode, hostNode, renderer, descendants, visibleText, button, click, settle } from './vue-memory-host';

vi.mock('@/api/study', () => ({ getPreanalysisStatus: vi.fn(), controlPreanalysis: vi.fn(), getPreparedExplanation: vi.fn(),
  getPreanalysisSettings: vi.fn(), savePreanalysisSettings: vi.fn() }));

const baseQuestion: StudyQuestion = { id: 'Q-1', category: '计算机网络', chapter: '基础', type: 'single', difficulty: '基础',
  stem: '测试题干', options: [{ id: 'A', text: '正确项' }, { id: 'B', text: '其他项' }], answer: ['A'],
  explanation: '题库中原先保存的逐项讲解', knowledgePoint: '协议', source: '原创' };
const contentVersion = (question: StudyQuestion) => JSON.stringify([question.id, question.type, question.stem,
  question.options.map(option => [option.id, option.text]), [...question.answer].sort(), question.explanation, question.answerRevision ?? 0]);
const pending = (id = 'Q-1', question = { ...baseQuestion, id }): Prepared => ({ questionId: id, questionRevision: question.answerRevision ?? 0,
  contentVersion: contentVersion(question), state: 'pending', text: '', source: '', fingerprint: 'version' });
const ready = (id = 'Q-1', text = '已经核验并保存的通用模型讲解', question = { ...baseQuestion, id }): Prepared => ({ ...pending(id, question), state: 'ready', text, source: 'DeepSeek 网页', generatedAt: '2026-10-22T00:00:00Z' });
const initialStatus = (values: Partial<PreanalysisStatus> = {}): PreanalysisStatus => ({ status: 'idle', total: 2000, completed: 12, pending: 1988, failed: 0, stale: 0,
  currentJobId: null, message: '当前已保存的讲解会保留', batchSize: 3, ...values });
type Settings = PreanalysisSettings;
const initialSettings = (values: Partial<Settings> = {}): Settings => ({ transport: 'web', configured: false, model: 'glm-4.7-flash',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyStorage: 'none', ...values });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; };
let app: ReturnType<typeof renderer.createApp> | undefined;
let host = hostNode('root');
let settings = initialSettings();

function field(label: string): HostNode {
  const found = descendants(host).find(node => node.props['aria-label'] === label);
  if (!found) throw new Error(`未找到字段：${label}`);
  return found;
}
function disabled(node: HostNode): boolean {
  return Boolean(node.props.disabled) || Boolean(node.parent && node.parent.tag === 'fieldset' && node.parent.props.disabled) ||
    Boolean(node.parent && node.parent.tag !== 'root' && disabled(node.parent));
}
async function chooseChannel(value: Settings['transport']) {
  const select = field('通用讲解生成渠道');
  select.value = value;
  select.options.forEach(option => { option.value = String(option.props.value); option.selected = option.props.value === value; });
  select.dispatchEvent({ type: 'change', target: select } as any); await settle();
}
async function chooseModel(value: Settings['model']) {
  const select = field('官方模型');
  select.value = value;
  select.options.forEach(option => { option.value = String(option.props.value); option.selected = option.props.value === value; });
  select.dispatchEvent({ type: 'change', target: select } as any); await settle();
}
async function chooseWebDriver(value: NonNullable<Settings['webDriver']>) {
  const select = field('网页执行方式');
  select.value = value;
  select.options.forEach(option => { option.value = String(option.props.value); option.selected = option.props.value === value; });
  select.dispatchEvent({ type: 'change', target: select } as any); await settle();
}
async function enterKey(value: string) {
  const input = field('官方 API Key'); input.value = value;
  input.dispatchEvent({ type: 'input', target: input } as any); await settle();
}
async function mountManager() {
  app = renderer.createApp(PreanalysisManager); app.mount(host); await settle(); await settle();
}
async function submitSettings() {
  await field('预解析渠道配置').props.onSubmit({ preventDefault() {} }); await settle();
}

beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  vi.stubGlobal('document', { activeElement: null });
  host = hostNode('root');
  settings = initialSettings();
  vi.mocked(api.getPreanalysisSettings).mockImplementation(async () => ({ ...settings }));
  vi.mocked(api.savePreanalysisSettings).mockImplementation(async data => {
    settings = { ...settings, transport: data.transport ?? settings.transport, webDriver: data.webDriver ?? settings.webDriver, model: data.model ?? settings.model,
      ...(data.apiKey ? { configured: true, keyStorage: 'windows-dpapi' as const } : {}),
      ...(data.clearApiKey ? { configured: false, keyStorage: 'none' as const } : {}) };
    return { ...settings };
  });
  vi.mocked(api.getPreparedExplanation).mockResolvedValue(pending());
  vi.mocked(api.getPreanalysisStatus).mockResolvedValue(initialStatus());
  vi.mocked(api.controlPreanalysis).mockImplementation(async data => initialStatus({ status: data.action === 'pause' ? 'paused' : 'running' }));
});
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('预先讲解与即时阅读', () => {
  it('缺少历史来源时使用通用说明，不冒充当前平台', async () => {
    vi.mocked(api.getPreparedExplanation).mockResolvedValue({ ...ready(), source: '' });
    app = renderer.createApp(PreparedExplanation, { question: baseQuestion }); app.mount(host); await settle();
    expect(visibleText(host)).toContain('来源未记录');
    expect(visibleText(host)).not.toContain('智谱清言');
  });

  it('请求仍在等待时立即显示题库讲解，准备完成后显示来源与完整正文', async () => {
    const wait = deferred<Prepared>();
    vi.mocked(api.getPreparedExplanation).mockReturnValue(wait.promise);
    app = renderer.createApp(PreparedExplanation, { question: baseQuestion }); app.mount(host);
    expect(visibleText(host)).toContain(baseQuestion.explanation);
    expect(visibleText(host)).toContain('题库讲解');
    wait.resolve(ready()); await settle();
    expect(visibleText(host)).toContain('通用 AI 讲解');
    expect(visibleText(host)).toContain('已经核验并保存');
    expect(visibleText(host)).toContain('DeepSeek 网页');
    expect(visibleText(host)).toContain('查看题库原解析');
  });

  it('题号不匹配的回复不会显示，保留当题讲解', async () => {
    vi.mocked(api.getPreparedExplanation).mockResolvedValue(ready('Q-OTHER', '不属于本题的正文'));
    app = renderer.createApp(PreparedExplanation, { question: baseQuestion }); app.mount(host); await settle();
    expect(visibleText(host)).not.toContain('不属于本题的正文');
    expect(visibleText(host)).toContain('题号未通过校验');
    expect(visibleText(host)).toContain(baseQuestion.explanation);
  });

  it('切题时忽略上一题迟到的回复', async () => {
    const wait = deferred<Prepared>();
    const second = { ...baseQuestion, id: 'Q-2', explanation: '第二题原解析' };
    vi.mocked(api.getPreparedExplanation).mockReturnValueOnce(wait.promise).mockResolvedValueOnce(ready('Q-2', '第二题的正确通用讲解', second));
    const props = reactive({ question: { ...baseQuestion } });
    app = renderer.createApp({ setup: () => () => h(PreparedExplanation, props) }); app.mount(host);
    props.question = second; await settle();
    wait.resolve(ready('Q-1', '第一题迟到的旧正文')); await settle();
    expect(visibleText(host)).toContain('第二题的正确通用讲解');
    expect(visibleText(host)).not.toContain('第一题迟到的旧正文');
  });

  it('同题标准版本更新时立即丢弃旧正文并重新请求', async () => {
    const old = deferred<Prepared>(); const current = deferred<Prepared>();
    vi.mocked(api.getPreparedExplanation).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const props = reactive({ question: { ...baseQuestion } });
    app = renderer.createApp({ setup: () => () => h(PreparedExplanation, props) }); app.mount(host);
    const updated = { ...baseQuestion, answerRevision: 1, answer: ['B'], explanation: '已经纠正后的新标准讲解' };
    props.question = updated; await settle();
    old.resolve(ready('Q-1', '旧标准正文')); await settle();
    expect(visibleText(host)).not.toContain('旧标准正文');
    expect(visibleText(host)).toContain('已经纠正后的新标准讲解');
    current.resolve({ ...pending('Q-1', updated), state: 'stale' }); await settle();
    expect(visibleText(host)).toContain('标准已更新');
    expect(api.getPreparedExplanation).toHaveBeenCalledTimes(2);
  });

  it('未备好时轮询，就绪后改为低频复核，卸载后停止', async () => {
    vi.mocked(api.getPreparedExplanation).mockResolvedValueOnce(pending()).mockResolvedValue(ready());
    app = renderer.createApp(PreparedExplanation, { question: baseQuestion }); app.mount(host); await settle();
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(api.getPreparedExplanation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(api.getPreparedExplanation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.getPreparedExplanation).toHaveBeenCalledTimes(3);
    app.unmount(); app = undefined;
    await vi.advanceTimersByTimeAsync(20000);
    expect(api.getPreparedExplanation).toHaveBeenCalledTimes(3);
  });

  it('待核验或读取失败时不展示未确认正文', async () => {
    vi.mocked(api.getPreparedExplanation).mockResolvedValueOnce({ ...pending(), state: 'review', text: '未通过审核的回复' }).mockRejectedValueOnce(new Error('暂时断线'));
    app = renderer.createApp(PreparedExplanation, { question: baseQuestion }); app.mount(host); await settle();
    expect(visibleText(host)).toContain('待核验');
    expect(visibleText(host)).not.toContain('未通过审核的回复');
    await vi.advanceTimersByTimeAsync(5000); await settle();
    expect(visibleText(host)).toContain(baseQuestion.explanation);
    expect(visibleText(host)).toContain('暂时断线');
  });

  it('别页新版解析不能出现在本页旧标准旁，每个内容版本只请求同步一次', async () => {
    const updated = { ...baseQuestion, answerRevision: 1, answer: ['B'], explanation: '新标准原解析' };
    vi.mocked(api.getPreparedExplanation).mockResolvedValue(ready('Q-1', '新版通用讲解', updated));
    const onStandardUpdated = vi.fn();
    const props = reactive({ question: { ...baseQuestion } });
    app = renderer.createApp({ setup: () => () => h(PreparedExplanation, { ...props, onStandardUpdated }) }); app.mount(host); await settle();
    expect(visibleText(host)).not.toContain('新版通用讲解');
    expect(visibleText(host)).not.toContain(baseQuestion.explanation);
    expect(visibleText(host)).toContain('标准已在其他页面更新');
    expect(onStandardUpdated).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onStandardUpdated).toHaveBeenCalledTimes(1);
    props.question = updated; await settle();
    expect(visibleText(host)).toContain('新版通用讲解');
    expect(visibleText(host)).not.toContain('标准已在其他页面更新');
  });

  it('就绪的缓存后来失效时撤下旧正文，保留同版本的题库讲解', async () => {
    vi.mocked(api.getPreparedExplanation).mockResolvedValueOnce(ready()).mockResolvedValueOnce({ ...pending(), state: 'stale' });
    app = renderer.createApp(PreparedExplanation, { question: baseQuestion }); app.mount(host); await settle();
    expect(visibleText(host)).toContain('已经核验并保存的通用模型讲解');
    await vi.advanceTimersByTimeAsync(15000); await settle();
    expect(visibleText(host)).not.toContain('已经核验并保存的通用模型讲解');
    expect(visibleText(host)).toContain(baseQuestion.explanation);
    expect(visibleText(host)).toContain('等待重新生成');
  });

  it('返回页面立即复核标准，卸载时移除focus监听', async () => {
    const events = new Map<string, () => void>();
    vi.stubGlobal('window', {
      addEventListener: vi.fn((name: string, handler: () => void) => events.set(name, handler)),
      removeEventListener: vi.fn((name: string) => events.delete(name)),
    });
    const updated = { ...baseQuestion, answerRevision: 1 };
    vi.mocked(api.getPreparedExplanation).mockResolvedValueOnce(ready()).mockResolvedValueOnce(ready('Q-1', '不该混进旧页面的解析', updated));
    const onStandardUpdated = vi.fn();
    app = renderer.createApp(PreparedExplanation, { question: baseQuestion, onStandardUpdated }); app.mount(host); await settle();
    events.get('focus')!(); await settle();
    expect(api.getPreparedExplanation).toHaveBeenCalledTimes(2);
    expect(visibleText(host)).not.toContain('已经核验并保存的通用模型讲解');
    expect(visibleText(host)).not.toContain('不该混进旧页面的解析');
    expect(onStandardUpdated).toHaveBeenCalledTimes(1);
    app.unmount(); app = undefined;
    expect(events.has('focus')).toBe(false);
  });
});

describe('批量预解析进度控制', () => {
  it('显示完整进度，发送每轮题量，支持暂停继续', async () => {
    app = renderer.createApp(PreanalysisManager); app.mount(host); await settle();
    expect(visibleText(host)).toContain('智谱清言');
    expect(visibleText(host)).toContain('登录提示或使用限额');
    expect(visibleText(host)).toContain('12 / 2000 题');
    const select = field('预解析每轮题量');
    select.value = '5'; select.options.forEach(option => { option.value = String(option.props.value); option.selected = option.props.value === 5; });
    select.dispatchEvent({ type: 'change', target: select }); await settle();
    await click(button(host, '开始预解析'));
    expect(api.controlPreanalysis).toHaveBeenLastCalledWith({ action: 'start', batchSize: 5 });
    expect(visibleText(host)).toContain('正在预解析');
    await click(button(host, '暂停预解析'));
    expect(api.controlPreanalysis).toHaveBeenLastCalledWith({ action: 'pause' });
    expect(visibleText(host)).toContain('继续预解析');
    await click(button(host, '继续预解析'));
    expect(api.controlPreanalysis).toHaveBeenLastCalledWith({ action: 'start', batchSize: 5 });
  });

  it('控制期间迟到的轮询不会把已暂停状态改回运行', async () => {
    const wait = deferred<PreanalysisStatus>();
    vi.mocked(api.getPreanalysisStatus).mockResolvedValueOnce(initialStatus({ status: 'running' })).mockReturnValueOnce(wait.promise);
    app = renderer.createApp(PreanalysisManager); app.mount(host); await settle();
    await vi.advanceTimersByTimeAsync(2500);
    await click(button(host, '暂停预解析'));
    wait.resolve(initialStatus({ status: 'running' })); await settle();
    expect(visibleText(host)).toContain('已暂停');
    expect(visibleText(host)).toContain('继续预解析');
  });

  it('失败时保留进度，完成状态禁用开始', async () => {
    vi.mocked(api.getPreanalysisStatus).mockResolvedValueOnce(initialStatus({ completed: 456, pending: 1544 })).mockRejectedValueOnce(new Error('服务暂时未连接'))
      .mockResolvedValueOnce(initialStatus({ status: 'completed', completed: 2000, pending: 0 }));
    app = renderer.createApp(PreanalysisManager); app.mount(host); await settle();
    await click(button(host, '刷新进度'));
    expect(visibleText(host)).toContain('456 / 2000 题');
    expect(visibleText(host)).toContain('服务暂时未连接');
    await click(button(host, '刷新进度'));
    expect(button(host, '全部已备好').props.disabled).toBe(true);
  });
});

describe('官方 API 渠道配置与密钥边界', () => {
  it('高级浏览器接口说明外部集成要求，保存不带密钥也不启动任务', async () => {
    await mountManager();
    expect(field('网页执行方式').options.map(option => option.props.value)).toEqual(['browser-ui', 'userscript']);
    await chooseChannel('official-api'); await enterKey('fixture-unused-api-draft');
    await chooseChannel('web'); await chooseWebDriver('browser-ui');
    expect(disabled(button(host, '开始预解析'))).toBe(true);
    expect(visibleText(host)).toContain('外部浏览器操作器或人工集成');
    expect(visibleText(host)).toContain('备考不内置聊天代理或浏览器操作器');
    expect(visibleText(host)).toContain('仅保存配置不会自动操作网页');
    expect(visibleText(host)).not.toContain('本聊天');
    await click(button(host, '开始预解析'));
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
    await submitSettings();
    expect(api.savePreanalysisSettings).toHaveBeenCalledExactlyOnceWith({ transport: 'web', webDriver: 'browser-ui' });
    expect(visibleText(host)).not.toContain('fixture-unused-api-draft');
    expect(descendants(host).some(node => node.props['aria-label'] === '官方 API Key')).toBe(false);
    expect(disabled(button(host, '开始预解析'))).toBe(false);
    const help = visibleText(descendants(host).find(node => node.props['data-testid'] === 'preanalysis-transport-help')!);
    expect(help).toContain('外部浏览器操作器或人工集成');
    expect(help).toContain('仅保存配置不会自动运行');
    expect(help).not.toContain('本聊天');
    expect(help).not.toContain('连接此页');
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
  });

  it('读取浏览器实际操作配置时只上报公开字段，并可明确切回页面脚本', async () => {
    settings = initialSettings({ transport: 'web', webDriver: 'browser-ui', configured: true, keyStorage: 'windows-dpapi' });
    const onSettingsChanged = vi.fn();
    vi.mocked(api.getPreanalysisSettings).mockResolvedValue({ ...settings, apiKey: 'fixture-not-public' } as Settings);
    app = renderer.createApp(PreanalysisManager, { onSettingsChanged }); app.mount(host); await settle(); await settle();
    expect(onSettingsChanged).toHaveBeenLastCalledWith(settings);
    expect(JSON.stringify(onSettingsChanged.mock.calls)).not.toContain('fixture-not-public');
    expect(visibleText(host)).not.toContain('清除本机密钥');
    expect(disabled(button(host, '开始预解析'))).toBe(false);
    await chooseWebDriver('userscript'); await submitSettings();
    expect(api.savePreanalysisSettings).toHaveBeenCalledExactlyOnceWith({ transport: 'web', webDriver: 'userscript' });
    expect(visibleText(host)).toContain('连接此页');
    expect(visibleText(host)).toContain('页面脚本需为 1.7.0');
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
  });

  it('有活动批次时禁止切换网页执行方式', async () => {
    settings = initialSettings({ transport: 'web', webDriver: 'browser-ui' });
    vi.mocked(api.getPreanalysisStatus).mockResolvedValue(initialStatus({ status: 'paused', currentJobId: 'active-web-job' }));
    await mountManager();
    expect(disabled(field('网页执行方式'))).toBe(true);
    await submitSettings();
    expect(api.savePreanalysisSettings).not.toHaveBeenCalled();
  });
  it('仅在本机填写密码，保存成功清空草稿，保存配置不启动生成', async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage);
    await mountManager();
    await chooseChannel('official-api');
    const input = field('官方 API Key');
    expect(input.props.type).toBe('password');
    expect(input.props.autocomplete).toBe('off');
    expect(disabled(button(host, '开始预解析'))).toBe(true);
    await enterKey('fixture-only-official-key');
    await click(button(host, '开始预解析'));
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
    await submitSettings();
    expect(api.savePreanalysisSettings).toHaveBeenCalledExactlyOnceWith({ transport: 'official-api', model: 'glm-4.7-flash', apiKey: 'fixture-only-official-key' });
    expect(field('官方 API Key').value).toBe('');
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(visibleText(host)).not.toContain('fixture-only-official-key');
    expect(visibleText(host)).toContain('尚未启动');
    expect(disabled(button(host, '开始预解析'))).toBe(false);
    await click(button(host, '开始预解析'));
    expect(api.controlPreanalysis).toHaveBeenCalledExactlyOnceWith({ action: 'start', batchSize: 3 });
  });

  it('保存失败不显示可能包含密钥的服务端错误，保留已有进度且不启动', async () => {
    await mountManager(); await chooseChannel('official-api'); await enterKey('fixture-secret-in-error');
    vi.mocked(api.savePreanalysisSettings).mockRejectedValueOnce(new Error('upstream rejected fixture-secret-in-error'));
    await submitSettings();
    expect(visibleText(host)).not.toContain('fixture-secret-in-error');
    expect(visibleText(host)).not.toContain('upstream rejected');
    expect(visibleText(host)).toContain('配置未保存');
    expect(visibleText(host)).toContain('12 / 2000 题');
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
    expect(disabled(button(host, '开始预解析'))).toBe(true);
  });

  it('显式选择另一个官方模型，保存前禁止调度，保留现有密钥且保存不启动', async () => {
    settings = initialSettings({ transport: 'official-api', configured: true, keyStorage: 'windows-dpapi' });
    await mountManager();
    expect(field('官方模型').options.map(option => option.props.value)).toEqual(['glm-4.7-flash', 'glm-4-flash-250414']);
    expect(visibleText(host)).not.toContain('免费');
    expect(visibleText(host)).toContain('账户额度、速率与并发限制');
    expect(descendants(host).some(node => node.tag === 'a' && node.props.href === 'https://bigmodel.cn/pricing')).toBe(true);
    expect(disabled(button(host, '开始预解析'))).toBe(false);
    await chooseModel('glm-4-flash-250414');
    expect(disabled(button(host, '开始预解析'))).toBe(true);
    expect(visibleText(host)).toContain('尚未保存，请先保存配置');
    await click(button(host, '开始预解析'));
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
    await submitSettings();
    expect(api.savePreanalysisSettings).toHaveBeenCalledExactlyOnceWith({ transport: 'official-api', model: 'glm-4-flash-250414' });
    expect(settings.configured).toBe(true);
    expect(field('官方 API Key').value).toBe('');
    expect(field('官方模型').value).toBe('glm-4-flash-250414');
    expect(visibleText(host)).toContain('密钥已在本机使用 Windows 账户加密保存');
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
    expect(disabled(button(host, '开始预解析'))).toBe(false);
  });

  it('重新填写或清除密钥都保留已选择的官方模型', async () => {
    settings = initialSettings({ transport: 'official-api', model: 'glm-4-flash-250414', configured: true, keyStorage: 'windows-dpapi' });
    await mountManager();
    await enterKey('fixture-only-replacement-key'); await submitSettings();
    expect(api.savePreanalysisSettings).toHaveBeenLastCalledWith({ transport: 'official-api', model: 'glm-4-flash-250414', apiKey: 'fixture-only-replacement-key' });
    expect(field('官方 API Key').value).toBe('');
    await click(button(host, '清除本机密钥'));
    expect(api.savePreanalysisSettings).toHaveBeenLastCalledWith({ clearApiKey: true });
    expect(visibleText(host)).toContain('所选模型为智谱官方 GLM-4-Flash-250414');
    expect(settings.model).toBe('glm-4-flash-250414');
    expect(disabled(button(host, '开始预解析'))).toBe(true);
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
  });

  it.each([
    { label: '运行中', status: 'running' as const, currentJobId: null },
    { label: '暂停但批次尚未结束', status: 'paused' as const, currentJobId: 'active-preanalysis-job' },
  ])('$label 时禁止修改渠道或密钥，直接触发handler也不发送配置', async ({ status, currentJobId }) => {
    settings = initialSettings({ transport: 'official-api', configured: true, keyStorage: 'windows-dpapi' });
    vi.mocked(api.getPreanalysisStatus).mockResolvedValue(initialStatus({ status, currentJobId }));
    await mountManager();
    for (const node of [field('通用讲解生成渠道'), field('官方模型'), field('官方 API Key'), button(host, '保存渠道配置'), button(host, '清除本机密钥')]) {
      expect(disabled(node)).toBe(true);
    }
    await submitSettings(); await click(button(host, '清除本机密钥'));
    expect(api.savePreanalysisSettings).not.toHaveBeenCalled();
  });

  it('配置尚未读取或读取失败时拒绝修改与启动，不显示读取错误详情', async () => {
    const wait = deferred<Settings>();
    vi.mocked(api.getPreanalysisSettings).mockReturnValueOnce(wait.promise);
    await mountManager();
    expect(disabled(field('通用讲解生成渠道'))).toBe(true);
    expect(disabled(button(host, '开始预解析'))).toBe(true);
    await submitSettings(); await click(button(host, '开始预解析'));
    expect(api.savePreanalysisSettings).not.toHaveBeenCalled(); expect(api.controlPreanalysis).not.toHaveBeenCalled();
    wait.resolve(initialSettings()); await settle();
    expect(disabled(field('通用讲解生成渠道'))).toBe(false);
    app?.unmount(); app = undefined; host = hostNode('root');
    vi.mocked(api.getPreanalysisSettings).mockRejectedValueOnce(new Error('unexpected-private-key-detail'));
    await mountManager();
    expect(visibleText(host)).toContain('暂时无法读取渠道配置');
    expect(visibleText(host)).not.toContain('unexpected-private-key-detail');
    expect(visibleText(host)).toContain('12 / 2000 题');
    expect(disabled(button(host, '开始预解析'))).toBe(true);
  });

  it('官方 API 没有密钥或有未保存草稿时，开始与重试均不会调度', async () => {
    settings = initialSettings({ transport: 'official-api' });
    vi.mocked(api.getPreanalysisStatus).mockResolvedValue(initialStatus({ status: 'paused', failed: 5, pending: 1983 }));
    await mountManager();
    for (const label of ['继续预解析', '重试未通过的批次']) {
      expect(disabled(button(host, label))).toBe(true); await click(button(host, label));
    }
    await enterKey('fixture-only-unsaved-key');
    for (const label of ['继续预解析', '重试未通过的批次']) await click(button(host, label));
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
    await submitSettings();
    expect(disabled(button(host, '继续预解析'))).toBe(false);
    await enterKey('fixture-replacement-unsaved-key');
    expect(disabled(button(host, '继续预解析'))).toBe(true);
    await click(button(host, '继续预解析')); await click(button(host, '重试未通过的批次'));
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
  });

  it('只清除本机加密密钥；环境变量密钥提示在环境中管理', async () => {
    settings = initialSettings({ transport: 'official-api', configured: true, keyStorage: 'windows-dpapi' });
    await mountManager(); await click(button(host, '清除本机密钥'));
    expect(api.savePreanalysisSettings).toHaveBeenCalledExactlyOnceWith({ clearApiKey: true });
    expect(visibleText(host)).toContain('本机保存的密钥已清除');
    expect(disabled(button(host, '开始预解析'))).toBe(true);
    app?.unmount(); app = undefined; host = hostNode('root');
    settings = initialSettings({ transport: 'official-api', configured: true, keyStorage: 'environment' });
    await mountManager();
    expect(visibleText(host)).toContain('环境变量');
    expect(descendants(host).some(node => node.tag === 'button' && visibleText(node).includes('清除本机密钥'))).toBe(false);
    expect(field('官方 API Key').value).toBe('');
    expect(disabled(button(host, '开始预解析'))).toBe(false);
  });

  it('官方模式提供控制台和价格链接，网页模式使用普通页面显式连接', async () => {
    settings = initialSettings({ transport: 'official-api', configured: true, keyStorage: 'environment' });
    await mountManager();
    const links = descendants(host).filter(node => node.tag === 'a').map(node => node.props.href);
    expect(links).toContain('https://bigmodel.cn/usercenter/proj-mgmt/apikeys'); expect(links).toContain('https://bigmodel.cn/pricing');
    expect(visibleText(host)).toContain('GLM-4.7-Flash');
    expect(visibleText(host)).toContain('模型标准 API');
    expect(visibleText(host)).toContain('Coding 套餐的密钥与模型标准 API 不通用');
    expect(visibleText(host)).toContain('账户额度、速率与并发限制');
    expect(visibleText(host)).toContain('不会自动切换模型');
    expect(visibleText(host)).not.toContain('免费');
    expect(visibleText(host)).toContain('不发送你的作答、笔记或学习记录');
    const help = () => visibleText(descendants(host).find(node => node.props['data-testid'] === 'preanalysis-transport-help')!);
    expect(help()).toContain('无需保持');
    await chooseChannel('web');
    expect(help()).toContain('无需保持'); // An unsaved draft never changes the active transport.
    await submitSettings();
    expect(help()).toContain('请保持备考与已连接的');
    expect(help()).toContain('连接此页');
    expect(help()).toContain('已有草稿不会覆盖');
    expect(help()).toContain('失联后暂停发送');
    expect(help()).not.toContain('专用标签');
    expect(help()).toContain('登录提示或使用限额');
    expect(api.controlPreanalysis).not.toHaveBeenCalled();
  });

  it.each(['windows-dpapi', 'environment'] as const)('%s 密钥存在但不可用时明确提示重新设置，不渲染服务端详情', async keyStorage => {
    settings = initialSettings({ transport: 'official-api', configured: false, keyStorage, message: 'fixture-private-key-error-detail' });
    await mountManager();
    expect(visibleText(host)).toContain('密钥暂不可用，请重新设置');
    expect(visibleText(host)).not.toContain('fixture-private-key-error-detail');
    expect(visibleText(host)).not.toContain('密钥已在本机使用 Windows 账户加密保存');
    expect(disabled(button(host, '开始预解析'))).toBe(true);
  });

  it('设置请求仅使用同源GET/PUT约定，不保存到浏览器存储', async () => {
    const actual = await vi.importActual<typeof import('@/api/study')>('@/api/study');
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const storage = { getItem: vi.fn(), setItem: vi.fn() }; vi.stubGlobal('localStorage', storage);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(initialSettings())))
      .mockResolvedValueOnce(new Response(JSON.stringify(initialSettings({ transport: 'official-api', configured: true, keyStorage: 'windows-dpapi' }))));
    vi.stubGlobal('fetch', fetchMock);
    await actual.getPreanalysisSettings();
    await actual.savePreanalysisSettings({ transport: 'official-api', apiKey: 'fixture-only-request-key' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/study-api/preanalysis/settings', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/study-api/preanalysis/settings', expect.objectContaining({ method: 'PUT',
      body: JSON.stringify({ transport: 'official-api', apiKey: 'fixture-only-request-key' }), headers: { 'Content-Type': 'application/json' } }));
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
