import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBridgeController } from '@/store/modules/studyBridge';

const initialTime = new Date('2026-10-21T00:00:00Z');
const savedText = '原先已经保存的完整解析';
const finalText = '本轮完整确认的最终解析';
const queuedJob = () => ({ id: 'task-1', questionId: 'Q-1', status: 'queued', createdAt: initialTime.toISOString(), lastProgressAt: initialTime.toISOString() });
const controllers: ReturnType<typeof createBridgeController>[] = [];
let browserEvents: Map<string, Set<(...args: any[]) => void>>;

function eventTarget() {
  return {
    addEventListener(name: string, listener: (...args: any[]) => void) {
      if (!browserEvents.has(name)) browserEvents.set(name, new Set());
      browserEvents.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: (...args: any[]) => void) { browserEvents.get(name)?.delete(listener); },
    dispatchEvent(event: { type: string }) { for (const listener of browserEvents.get(event.type) || []) listener(event); return true; },
  };
}
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function harness() {
  let remote: any = null;
  let saved = savedText;
  const overview = () => ({
    activeJob: remote && !['completed', 'failed'].includes(remote.status) ? { ...remote } : null,
    latestJob: remote && ['completed', 'failed'].includes(remote.status) ? { ...remote } : null,
    serverTime: new Date().toISOString(), limits: { totalTimeoutMs: 240000, idleTimeoutMs: 120000 },
  });
  const api = {
    getBridgeStatus: vi.fn(async () => ({ connected: true, provider: 'zhipu', version: '1.6.0', lastSeenAt: new Date().toISOString(),
      worker: { connected: true, provider: 'zhipu', version: '1.6.0', state: 'idle', jobId: null, message: '', lastSeenAt: new Date().toISOString() } })),
    getBridgeOverview: vi.fn(async () => overview()),
    getBridgeJob: vi.fn(async () => { if (!remote) throw Object.assign(new Error('任务已失效'), { status: 404 }); return { ...remote }; }),
    createBridgeJob: vi.fn(async (payload: any) => { remote = { ...queuedJob(), ...payload }; return { ...remote }; }),
    cancelBridgeJob: vi.fn(async () => { remote = { ...remote, status: 'failed', failureCode: 'cancelled', error: '本轮等待已结束，原解析保留。' }; return { ...remote }; }),
  };
  const syncProgress = vi.fn(async () => { saved = remote?.status === 'completed' ? remote.text : saved; });
  const onCompleted = vi.fn();
  const controller = createBridgeController({ api: api as any, getSavedText: () => saved, syncProgress, onCompleted });
  controllers.push(controller);
  return { controller, api, overview, syncProgress, onCompleted,
    get saved() { return saved; },
    setRemote(job: any) { remote = job; },
    complete() { remote = { ...remote, status: 'completed', text: finalText }; },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(initialTime);
  browserEvents = new Map();
  vi.stubGlobal('window', { ...eventTarget(), setTimeout, clearTimeout });
  vi.stubGlobal('document', { ...eventTarget(), hidden: false });
  vi.stubGlobal('sessionStorage', storage());
  vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('独立解析任务控制器的故障恢复', () => {
  it('旧渠道完成同步的迟到失败不能把新渠道标为断线', async () => {
    const h = harness();
    h.setRemote({ ...queuedJob(), provider: 'zhipu', status: 'completed', text: finalText });
    const held = deferred<void>();
    h.syncProgress.mockImplementationOnce(() => held.promise);
    const oldRefresh = h.controller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.syncProgress).toHaveBeenCalledTimes(1);
    expect(h.controller.setProvider('deepseek')).toBe(true);
    held.reject(new Error('旧渠道进度读取失败'));
    await oldRefresh;
    expect(h.controller.provider.value).toBe('deepseek');
    expect(h.controller.unavailable.value).toBe(false);
    expect(h.controller.error.value).toBe('');
    expect(h.controller.job.value).toBe(null);
    expect(h.onCompleted).not.toHaveBeenCalled();
  });

  it.each(['provider', 'version', 'job'] as const)('完成同步迟到成功必须遵守 %s 边界，不能标记或通知旧上下文', async (boundary) => {
    const h = harness();
    h.setRemote({ ...queuedJob(), provider: 'zhipu' });
    await h.controller.refresh();
    h.complete();
    const held = deferred<void>();
    h.syncProgress.mockImplementationOnce(() => held.promise);
    const oldRefresh = h.controller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.job.value?.status).toBe('completed');
    if (boundary === 'job') h.controller.clearCompletedFor('Q-1');
    else {
      expect(h.controller.setProvider('deepseek')).toBe(true);
      if (boundary === 'version') expect(h.controller.setProvider('zhipu')).toBe(true);
    }
    held.resolve();
    await oldRefresh;
    expect(h.controller.job.value).toBe(null);
    expect(h.controller.run.value).toBe(null);
    expect(h.onCompleted).not.toHaveBeenCalled();
    expect(h.controller.unavailable.value).toBe(false);
    // A stale read did not mark this completion synchronized for a future view.
    const selected = h.controller.provider.value;
    h.api.getBridgeStatus.mockResolvedValueOnce({ connected: true, provider: selected, version: '1.7.0' } as any);
    h.setRemote({ ...queuedJob(), provider: selected, status: 'completed', text: finalText });
    await h.controller.refresh();
    expect(h.syncProgress).toHaveBeenCalledTimes(2);
    expect(h.controller.run.value?.progressSynced).toBe(true);
    expect(h.onCompleted).not.toHaveBeenCalled();
  });

  it('有效active旁的其他渠道latest也须整轮拒绝，不能触发进度同步', async () => {
    const h = harness();
    h.api.getBridgeOverview.mockResolvedValueOnce({
      ...h.overview(), activeJob: { ...queuedJob(), provider: 'zhipu' },
      latestJob: { ...queuedJob(), id: 'foreign', provider: 'deepseek', status: 'completed', text: '其他渠道正文' },
    });
    await h.controller.refresh();
    expect(h.controller.job.value).toBe(null);
    expect(h.controller.error.value).toContain('渠道');
    expect(h.syncProgress).not.toHaveBeenCalled();
    expect(h.onCompleted).not.toHaveBeenCalled();
  });

  it('不同渠道即使返回相同jobId也不能复用旧终态或同步标记', async () => {
    const h = harness();
    h.setRemote({ ...queuedJob(), provider: 'zhipu', status: 'completed', text: finalText });
    await h.controller.refresh();
    expect(h.syncProgress).toHaveBeenCalledTimes(1);
    expect(h.controller.setProvider('deepseek')).toBe(true);
    h.api.getBridgeStatus.mockResolvedValue({ connected: true, provider: 'deepseek', version: '1.7.0' } as any);
    h.setRemote({ ...queuedJob(), provider: 'deepseek' });
    await h.controller.refresh();
    expect(h.controller.job.value).toMatchObject({ provider: 'deepseek', status: 'queued' });
    expect(h.controller.run.value?.progressSynced).toBe(false);
    h.complete();
    await h.controller.refresh();
    expect(h.syncProgress).toHaveBeenCalledTimes(2);
    expect(h.onCompleted).toHaveBeenCalledTimes(1);
    expect(h.onCompleted).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek' }));
  });

  it('取消失败迟到时不能给已经接续的新任务写入旧错误', async () => {
    const h = harness();
    h.setRemote({ ...queuedJob(), provider: 'zhipu' });
    await h.controller.refresh();
    const held = deferred<any>();
    h.api.cancelBridgeJob.mockReturnValueOnce(held.promise);
    const cancellation = h.controller.cancel();
    h.setRemote({ ...queuedJob(), id: 'task-2', questionId: 'Q-2', provider: 'zhipu' });
    await h.controller.refresh();
    held.reject(new Error('旧任务取消失败'));
    await cancellation;
    expect(h.controller.job.value?.id).toBe('task-2');
    expect(h.controller.error.value).toBe('');
    expect(h.controller.unavailable.value).toBe(false);
    expect(h.controller.cancelling.value).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)('取消已返回完成、进度同步迟到%s时不能影响同渠道接续任务', async (result) => {
    const h = harness();
    h.setRemote({ ...queuedJob(), provider: 'zhipu' });
    await h.controller.refresh();
    h.api.cancelBridgeJob.mockResolvedValueOnce({ ...queuedJob(), provider: 'zhipu', status: 'completed', text: finalText });
    const held = deferred<void>();
    h.syncProgress.mockImplementationOnce(() => held.promise);
    const cancellation = h.controller.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.job.value?.status).toBe('completed');
    expect(h.syncProgress).toHaveBeenCalledTimes(1);
    // A server overview may reveal the next task without a local channel switch.
    h.setRemote({ ...queuedJob(), id: 'task-2', questionId: 'Q-2', provider: 'zhipu' });
    await h.controller.refresh();
    expect(h.controller.job.value?.id).toBe('task-2');
    if (result === 'resolve') held.resolve();
    else held.reject(new Error('旧任务完成后的同步失败'));
    await cancellation;
    expect(h.controller.job.value).toMatchObject({ id: 'task-2', status: 'queued' });
    expect(h.controller.run.value?.progressSynced).toBe(false);
    expect(h.controller.error.value).toBe('');
    expect(h.controller.unavailable.value).toBe(false);
    expect(h.onCompleted).not.toHaveBeenCalled();
  });

  it('取消尚在等待时即使任务自然完成也拒绝切换或新建请求', async () => {
    const h = harness();
    h.setRemote({ ...queuedJob(), provider: 'zhipu' });
    await h.controller.refresh();
    const held = deferred<any>();
    h.api.cancelBridgeJob.mockReturnValueOnce(held.promise);
    const cancellation = h.controller.cancel();
    h.complete();
    await h.controller.refresh();
    expect(h.controller.active.value).toBe(false);
    expect(h.controller.setProvider('deepseek')).toBe(false);
    await h.controller.request({ questionId: 'Q-2' });
    expect(h.api.createBridgeJob).not.toHaveBeenCalled();
    held.resolve({ ...queuedJob(), provider: 'zhipu', status: 'failed', failureCode: 'cancelled' });
    await cancellation;
    expect(h.controller.setProvider('deepseek')).toBe(true);
  });

  it('取消返回其他provider或job时保留当前任务', async () => {
    const h = harness();
    h.setRemote({ ...queuedJob(), provider: 'zhipu' });
    await h.controller.refresh();
    h.api.cancelBridgeJob.mockResolvedValueOnce({ ...queuedJob(), provider: 'deepseek', status: 'failed' });
    await h.controller.cancel();
    expect(h.controller.job.value).toMatchObject({ provider: 'zhipu', status: 'queued' });
    expect(h.controller.error.value).toContain('渠道');
    h.api.cancelBridgeJob.mockResolvedValueOnce({ ...queuedJob(), id: 'another-task', provider: 'zhipu', status: 'failed' });
    await h.controller.cancel();
    expect(h.controller.job.value?.id).toBe('task-1');
    expect(h.controller.error.value).toContain('其他任务');
    expect(h.syncProgress).not.toHaveBeenCalled();
  });

  it('请求保留题目标准版本，版本变化不复用旧幂等编号', async () => {
    const h = harness();
    h.api.createBridgeJob.mockRejectedValue(new Error('响应丢失'));
    await h.controller.request({ questionId: 'Q-1', expectedQuestionRevision: 2 });
    await h.controller.request({ questionId: 'Q-1', expectedQuestionRevision: 3 });
    const [first, second] = h.api.createBridgeJob.mock.calls.map(call => call[0]);
    expect(first.expectedQuestionRevision).toBe(2);
    expect(second.expectedQuestionRevision).toBe(3);
    expect(first.requestId).not.toBe(second.requestId);
  });

  it('渠道切换不发任务，旧渠道的迟到读取不能覆盖新渠道状态', async () => {
    const h = harness();
    const held = deferred<any>();
    h.api.getBridgeStatus.mockImplementationOnce(() => held.promise);
    const oldRefresh = h.controller.refresh();
    expect(h.controller.setProvider('deepseek')).toBe(true);
    held.resolve({ connected: true, provider: 'zhipu', version: '1.7.0', lastSeenAt: initialTime.toISOString() });
    await oldRefresh;
    expect(h.controller.status.value).toBe(null);
    h.api.getBridgeStatus.mockResolvedValueOnce({ connected: true, provider: 'deepseek', version: '1.7.0', lastSeenAt: initialTime.toISOString() } as any);
    await h.controller.refresh();
    expect(h.api.getBridgeStatus).toHaveBeenLastCalledWith('deepseek');
    expect(h.api.getBridgeOverview).toHaveBeenLastCalledWith('deepseek');
    expect(h.controller.status.value?.provider).toBe('deepseek');
    expect(h.api.createBridgeJob).not.toHaveBeenCalled();
  });

  it('任务固定提供商，活跃任务期间拒绝切换，不收另一个平台的回复', async () => {
    const h = harness();
    expect(h.controller.setProvider('deepseek')).toBe(true);
    await h.controller.request({ questionId: 'Q-1', answer: ['B'] });
    expect(h.api.createBridgeJob).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek' }));
    expect(h.controller.setProvider('zhipu')).toBe(false);
    h.setRemote({ ...queuedJob(), provider: 'zhipu', status: 'completed', text: '其他平台的内容' });
    h.api.getBridgeStatus.mockResolvedValueOnce({ connected: true, provider: 'deepseek', version: '1.7.0', lastSeenAt: initialTime.toISOString() } as any);
    await h.controller.refresh();
    expect(h.controller.job.value?.status).toBe('queued');
    expect(h.controller.job.value?.text).toBeUndefined();
    expect(h.controller.error.value).toContain('渠道');
    expect(h.syncProgress).not.toHaveBeenCalled();
  });

  it('跨渠道复用相同题目时使用不同requestId，丢失的请求仍只在原渠道重试', async () => {
    const h = harness();
    h.api.createBridgeJob.mockRejectedValue(Object.assign(new Error('响应丢失'), { status: 502 }));
    await h.controller.request({ questionId: 'Q-1' });
    await h.controller.request({ questionId: 'Q-1' });
    const [first, retry] = h.api.createBridgeJob.mock.calls.map(call => call[0]);
    expect(first.requestId).toBe(retry.requestId); expect(first.provider).toBe('zhipu');
    expect(h.controller.setProvider('deepseek')).toBe(true);
    await h.controller.request({ questionId: 'Q-1' });
    const next = h.api.createBridgeJob.mock.calls[2][0];
    expect(next.provider).toBe('deepseek'); expect(next.requestId).not.toBe(first.requestId);
  });
  it('本机心跳正常但网页失联时提示显式连接，保留原任务并不重复创建', async () => {
    const h = harness();
    h.setRemote(queuedJob());
    const connected = await h.api.getBridgeStatus();
    h.api.getBridgeStatus.mockResolvedValueOnce({ ...connected, worker: { ...connected.worker, connected: false } });
    await h.controller.refresh();
    expect(h.controller.healthMessage.value).toContain('网页连接已中断');
    expect(h.controller.healthMessage.value).toContain('连接此页');
    expect(h.controller.job.value?.id).toBe('task-1');
    expect(h.api.createBridgeJob).not.toHaveBeenCalled();
    expect(h.saved).toBe(savedText);
  });
  it('唤醒、发送与取消只使用当前桥接事件命名', async () => {
    const h = harness();
    const dispatched = vi.spyOn(window, 'dispatchEvent');
    h.controller.start();
    await h.controller.refresh();
    await h.controller.request({ questionId: 'Q-1', answer: ['A'] });
    await h.controller.cancel();
    expect(dispatched.mock.calls.map(([event]) => event.type)).toEqual([
      'yankao-study-bridge-ping', 'yankao-study-bridge-ping',
      'yankao-study-bridge-job', 'yankao-study-bridge-job',
    ]);
  });

  it('保存冲突刷新真正已保存的解析，同时保留候选且不通知保存成功', async () => {
    const h = harness();
    h.setRemote(queuedJob());
    await h.controller.refresh();
    h.setRemote({ ...queuedJob(), status: 'failed', failureCode: 'save-conflict', text: finalText, error: '其他页面已保存新解析，候选已保留在历史中。' });
    await h.controller.refresh();
    await h.controller.refresh();
    expect(h.syncProgress).toHaveBeenCalledTimes(1);
    expect(h.onCompleted).not.toHaveBeenCalled();
    expect(h.controller.job.value?.text).toBe(finalText);
    expect(h.controller.job.value?.status).toBe('failed');
    expect(h.controller.run.value?.progressSynced).toBe(true);
    expect(h.saved).toBe(savedText);
  });
  it('重复 start 和并发 refresh 共享同一轮网络查询', async () => {
    const h = harness();
    const held = deferred<any>();
    h.api.getBridgeOverview.mockReturnValueOnce(held.promise);
    h.controller.start();
    h.controller.start();
    const first = h.controller.refresh();
    const second = h.controller.refresh();
    await vi.advanceTimersByTimeAsync(9000);
    expect(h.api.getBridgeOverview).toHaveBeenCalledTimes(1);
    held.resolve(h.overview());
    await Promise.all([first, second]);
    expect(h.api.getBridgeStatus).toHaveBeenCalledTimes(1);
  });

  it('请求挂起超过10秒后释放查询并自动重新连接', async () => {
    const h = harness();
    h.api.getBridgeOverview.mockReturnValueOnce(new Promise(() => {}));
    h.controller.start();
    await vi.advanceTimersByTimeAsync(10001);
    expect(h.controller.unavailable.value).toBe(true);
    expect(h.controller.healthMessage.value).toContain('自动重连');
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.api.getBridgeOverview).toHaveBeenCalledTimes(2);
    expect(h.controller.unavailable.value).toBe(false);
  });

  it('短暂断线退避，online事件立即恢复原任务而不重复创建', async () => {
    const h = harness();
    h.setRemote(queuedJob());
    h.controller.start();
    await h.controller.refresh();
    h.api.getBridgeOverview.mockRejectedValueOnce(new TypeError('短暂断线'));
    await h.controller.refresh();
    const countAfterFailure = h.api.getBridgeOverview.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1499);
    expect(h.api.getBridgeOverview).toHaveBeenCalledTimes(countAfterFailure);
    h.complete();
    window.dispatchEvent(new Event('online'));
    await h.controller.refresh();
    expect(h.controller.job.value?.status).toBe('completed');
    expect(h.saved).toBe(finalText);
    expect(h.api.createBridgeJob).not.toHaveBeenCalled();
  });

  it('丢失创建响应后重试同一payload复用requestId', async () => {
    const h = harness();
    h.api.createBridgeJob.mockRejectedValueOnce(new TypeError('响应丢失'));
    const payload = { questionId: 'Q-1', answer: ['B'], question: '解释易混点' };
    await h.controller.request(payload);
    expect(h.controller.run.value?.requestError).toContain('响应丢失');
    await h.controller.request(payload);
    const [first, second] = h.api.createBridgeJob.mock.calls.map(call => call[0]);
    expect(first.requestId).toBeTruthy();
    expect(second.requestId).toBe(first.requestId);
    expect(h.controller.active.value).toBe(true);
  });

  it('重新创建控制器后同次未确认请求仍复用持久化requestId', async () => {
    const h = harness();
    h.api.createBridgeJob.mockRejectedValueOnce(new TypeError('响应丢失'));
    const payload = { questionId: 'Q-1', answer: ['A'] };
    await h.controller.request(payload);
    const requestId = h.api.createBridgeJob.mock.calls[0][0].requestId;
    h.controller.dispose();
    const reloaded = harness();
    await reloaded.controller.request(payload);
    expect(reloaded.api.createBridgeJob.mock.calls[0][0].requestId).toBe(requestId);
  });

  it('取消期间迟到的旧概览不能复活任务或保存临时正文', async () => {
    const h = harness();
    h.setRemote({ ...queuedJob(), status: 'streaming', text: '未完成的临时正文' });
    await h.controller.refresh();
    const staleSnapshot = h.overview();
    const held = deferred<any>();
    h.api.getBridgeOverview.mockReturnValueOnce(held.promise);
    const staleRead = h.controller.refresh();
    await h.controller.cancel();
    held.resolve(staleSnapshot);
    await staleRead;
    expect(h.controller.job.value?.status).toBe('failed');
    expect(h.controller.job.value?.failureCode).toBe('cancelled');
    expect(h.controller.active.value).toBe(false);
    expect(h.saved).toBe(savedText);
    expect(h.syncProgress).not.toHaveBeenCalled();
  });

  it('取消旧任务的迟到响应不能覆盖概览中已经接续的新任务', async () => {
    const h = harness();
    const oldJob = queuedJob();
    h.setRemote(oldJob);
    await h.controller.refresh();
    const held = deferred<any>();
    h.api.cancelBridgeJob.mockReturnValueOnce(held.promise);
    const cancellation = h.controller.cancel();
    h.setRemote({ ...queuedJob(), id: 'task-2', questionId: 'Q-2' });
    await h.controller.refresh();
    expect(h.controller.job.value?.id).toBe('task-2');

    held.resolve({ ...oldJob, status: 'failed', failureCode: 'cancelled' });
    await cancellation;

    expect(h.controller.job.value).toMatchObject({ id: 'task-2', questionId: 'Q-2', status: 'queued' });
    expect(h.controller.active.value).toBe(true);
    expect(h.saved).toBe(savedText);
    expect(h.syncProgress).not.toHaveBeenCalled();
  });

  it.each(['missing', 'snapshot'] as const)('旧任务补查迟到的 %s 结果不能覆盖随后创建的新任务', async (result) => {
    const h = harness();
    const oldJob = queuedJob();
    h.setRemote(oldJob);
    await h.controller.refresh();
    h.setRemote(null);
    const held = deferred<any>();
    h.api.getBridgeJob.mockReturnValueOnce(held.promise);
    const staleRead = h.controller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.getBridgeJob).toHaveBeenCalledWith(oldJob.id);

    h.api.cancelBridgeJob.mockResolvedValueOnce({ ...oldJob, status: 'failed', failureCode: 'cancelled' });
    await h.controller.cancel();
    h.api.createBridgeJob.mockImplementationOnce(async (payload: any) => {
      const next = { ...queuedJob(), ...payload, id: 'task-2' };
      h.setRemote(next);
      return next;
    });
    await h.controller.request({ questionId: 'Q-2', answer: ['C'] });
    expect(h.controller.job.value?.id).toBe('task-2');

    if (result === 'missing') held.reject(Object.assign(new Error('旧任务已失效'), { status: 404 }));
    else held.resolve({ ...oldJob, status: 'streaming', text: '旧任务迟到的临时片段' });
    await staleRead;

    expect(h.controller.job.value).toMatchObject({ id: 'task-2', questionId: 'Q-2', status: 'queued' });
    expect(h.controller.active.value).toBe(true);
    expect(h.controller.unavailable.value).toBe(false);
    expect(h.controller.error.value).toBe('');
    expect(h.saved).toBe(savedText);
    expect(h.syncProgress).not.toHaveBeenCalled();
  });

  it('重复的旧活动快照不能回退已经确认的终态', async () => {
    const h = harness();
    h.setRemote(queuedJob());
    await h.controller.refresh();
    h.complete();
    await h.controller.refresh();
    h.setRemote({ ...queuedJob(), status: 'streaming', text: '迟到片段' });
    await h.controller.refresh();
    expect(h.controller.job.value?.status).toBe('completed');
    expect(h.controller.job.value?.text).toBe(finalText);
    expect(h.syncProgress).toHaveBeenCalledTimes(1);
    expect(h.onCompleted).toHaveBeenCalledTimes(1);
  });

  it('overview只有最新完成任务也能收尾并仅同步一次', async () => {
    const h = harness();
    h.setRemote({ ...queuedJob(), status: 'completed', text: finalText });
    await Promise.all([h.controller.refresh(), h.controller.refresh()]);
    await h.controller.refresh();
    expect(h.controller.run.value?.progressSynced).toBe(true);
    expect(h.syncProgress).toHaveBeenCalledTimes(1);
    expect(h.onCompleted).not.toHaveBeenCalled();
    expect(h.saved).toBe(finalText);
  });

  it('完整回复已完成但进度刷新失败时可自动补齐', async () => {
    const h = harness();
    h.setRemote({ ...queuedJob(), status: 'completed', text: finalText });
    h.syncProgress.mockRejectedValueOnce(new TypeError('保存结果读取失败'));
    await h.controller.refresh();
    expect(h.controller.run.value?.progressSynced).toBe(false);
    await h.controller.refresh();
    expect(h.controller.run.value?.progressSynced).toBe(true);
    expect(h.syncProgress).toHaveBeenCalledTimes(2);
    expect(h.saved).toBe(finalText);
  });

  it('无进展显示可恢复提示，服务端超时终态解除等待', async () => {
    const h = harness();
    h.setRemote(queuedJob());
    h.controller.start();
    await h.controller.refresh();
    await vi.advanceTimersByTimeAsync(15000);
    expect(h.controller.stalled.value).toBe(true);
    expect(h.controller.healthMessage.value).toContain('没有收到新进展');
    h.setRemote({ ...queuedJob(), status: 'failed', failureCode: 'no-progress', error: '两分钟没有实质进展，本轮已结束。' });
    await h.controller.refresh();
    expect(h.controller.active.value).toBe(false);
    expect(h.saved).toBe(savedText);
  });
});
