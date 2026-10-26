import { computed, ref } from 'vue';
import * as defaultApi from '@/api/study';
import type { BridgeJob, BridgeStatus, WebProvider } from '@/api/study/types';

type BridgeApi = Pick<typeof defaultApi, 'getBridgeStatus' | 'getBridgeOverview' | 'getBridgeJob' | 'createBridgeJob' | 'cancelBridgeJob'>;
type RequestPayload = { questionId: string; answer?: string[]; question?: string; provider?: WebProvider; expectedQuestionRevision?: number };
type AiRun = { questionId: string; previousText: string; requesting: boolean; requestError: string; progressSynced: boolean };
export interface BridgeControllerDeps {
  api?: BridgeApi;
  now?: () => number;
  getSavedText: (questionId: string) => string;
  syncProgress: () => Promise<void>;
  onCompleted?: (job: BridgeJob) => void;
  provider?: WebProvider;
}

const tokenStorageKey = 'yankao-pending-analysis-request';
const terminal = (job: BridgeJob | null) => !!job && ['completed', 'failed'].includes(job.status);

/** Application-owned task controller. Views only display snapshots; the server owns task lifetime. */
export function createBridgeController(deps: BridgeControllerDeps) {
  const api = deps.api || defaultApi;
  const now = deps.now || Date.now;
  const status = ref<BridgeStatus | null>(null);
  const checked = ref(false);
  const unavailable = ref(false);
  const job = ref<BridgeJob | null>(null);
  const run = ref<AiRun | null>(null);
  const error = ref('');
  const requesting = ref(false);
  const cancelling = ref(false);
  const clock = ref(now());
  const provider = ref<WebProvider>(deps.provider || 'zhipu');
  const providerName = computed(() => provider.value === 'deepseek' ? 'DeepSeek' : '智谱清言');
  const connected = computed(() => !!status.value?.connected);
  const active = computed(() => !!job.value && !terminal(job.value));
  const lastProgressAt = computed(() => {
    const value = Date.parse(job.value?.lastProgressAt || job.value?.updatedAt || job.value?.createdAt || '');
    return Number.isFinite(value) ? value : clock.value;
  });
  const stalled = computed(() => active.value && clock.value - lastProgressAt.value >= 15000);
  const healthMessage = computed(() => {
    if (unavailable.value) return '连接暂时中断，正在自动重连；任务与已有解析会保留。';
    if (error.value) return error.value;
    if (job.value?.status === 'failed') return job.value.error || '本轮解析已结束，可以重新解析。';
    if (active.value && (!connected.value || !status.value?.worker?.connected)) return `网页连接已中断，任务与已有解析会保留；请在${providerName.value}页面点击“连接此页”并核对本轮状态，也可结束本轮等待。`;
    if (stalled.value) return '一段时间没有收到新进展，正在核对任务；连续 2 分钟无进展会自动结束等待。';
    if (active.value) return `任务持续同步中；请保留已连接的${providerName.value}页面，完整回复确认后保存。`;
    return job.value?.status === 'completed' ? '本轮完整解析已保存，可以继续解析其他题目。' : `在普通${providerName.value}页面点击“连接此页”；同一时间只连接一页，已有草稿会保留。`;
  });
  let started = false;
  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | null = null;
  let failures = 0;
  let mutationVersion = 0;
  let requestToken: { fingerprint: string; requestId: string } | null = null;
  const synced = new Set<string>();
  const syncing = new Map<string, Promise<void>>();
  const observedActive = new Set<string>();
  const terminalSnapshots = new Map<string, BridgeJob>();
  const jobKey = (id: string, selectedProvider = provider.value) => `${selectedProvider}:${id}`;
  const currentContext = () => ({ provider: provider.value, version: mutationVersion, jobId: job.value?.id ?? null });
  const contextIsCurrent = (context: ReturnType<typeof currentContext>) => !disposed && context.provider === provider.value &&
    context.version === mutationVersion && context.jobId === (job.value?.id ?? null);
  try {
    const saved = JSON.parse(sessionStorage.getItem(tokenStorageKey) || 'null');
    if (saved && typeof saved.fingerprint === 'string' && typeof saved.requestId === 'string') requestToken = saved;
  } catch { /* Storage is optional. */ }

  function saveToken(value: typeof requestToken) {
    requestToken = value;
    try { if (value) sessionStorage.setItem(tokenStorageKey, JSON.stringify(value)); else sessionStorage.removeItem(tokenStorageKey); } catch { /* The in-memory token still prevents duplicate retries. */ }
  }
  function schedule(delay?: number) {
    if (!started || disposed) return;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    const backoff = failures ? Math.min(15000, 1500 * 2 ** Math.min(failures - 1, 4)) : active.value ? 650 : 2500;
    pollTimer = setTimeout(() => { pollTimer = undefined; void refresh(); }, delay ?? backoff);
  }
  async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('连接响应超时，正在重新连接。')), 10000);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  function assertProvider(incoming: BridgeJob | null, selectedProvider = provider.value) {
    if (incoming?.provider && incoming.provider !== selectedProvider) throw new Error('回复渠道与本轮任务不一致，未显示其他渠道的内容。');
  }
  function rememberTerminal(incoming: BridgeJob, selectedProvider = provider.value) {
    assertProvider(incoming, selectedProvider);
    const key = jobKey(incoming.id, selectedProvider);
    const next = terminalSnapshots.get(key) || incoming;
    if (terminal(next)) {
      terminalSnapshots.set(key, { ...next });
      if (terminalSnapshots.size > 100) terminalSnapshots.delete(terminalSnapshots.keys().next().value!);
    }
    return next;
  }
  function adopt(incoming: BridgeJob) {
    assertProvider(incoming);
    const next = rememberTerminal(incoming);
    if (!terminal(next)) observedActive.add(jobKey(next.id));
    if (job.value?.id !== next.id) {
      run.value = {
        questionId: next.questionId || '', previousText: deps.getSavedText(next.questionId || ''),
        requesting: false, requestError: '', progressSynced: synced.has(jobKey(next.id)),
      };
    }
    job.value = { ...next };
    if (run.value) run.value.requesting = false;
    if (next.requestId && next.requestId === requestToken?.requestId) saveToken(null);
  }
  async function syncCompletion(completed: BridgeJob | null) {
    assertProvider(completed);
    if (!completed || !(completed.status === 'completed' || (completed.status === 'failed' && completed.failureCode === 'save-conflict'))) return;
    const context = currentContext();
    const key = jobKey(completed.id, context.provider);
    if (synced.has(key)) return;
    // A completion read belongs to the exact displayed context that requested it.
    // A later provider or task can start a new read without inheriting this result.
    const operationKey = JSON.stringify([key, context.version, context.jobId]);
    const existing = syncing.get(operationKey);
    if (existing) return existing;
    const operation = (async () => {
      await bounded(deps.syncProgress());
      if (!contextIsCurrent(context)) return;
      synced.add(key);
      if (run.value && job.value?.id === completed.id) run.value.progressSynced = true;
      if (completed.status === 'completed' && job.value?.id === completed.id && observedActive.has(key)) deps.onCompleted?.(completed);
    })();
    syncing.set(operationKey, operation);
    try { await operation; } finally { syncing.delete(operationKey); }
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    if (document.hidden) { schedule(2500); return Promise.resolve(); }
    const version = mutationVersion;
    const selectedProvider = provider.value;
    const readIsCurrent = () => !disposed && selectedProvider === provider.value && version === mutationVersion;
    inFlight = (async () => {
      try {
        const results = await Promise.allSettled([bounded(api.getBridgeStatus(selectedProvider)), bounded(api.getBridgeOverview(selectedProvider))]);
        if (!readIsCurrent()) return;
        const [statusResult, overviewResult] = results;
        if (statusResult.status === 'fulfilled') {
          if (statusResult.value.provider && statusResult.value.provider !== selectedProvider) throw new Error('网页助手返回了其他渠道的连接状态。');
          status.value = statusResult.value;
        }
        checked.value = true;
        if (overviewResult.status === 'rejected') throw overviewResult.reason;
        const overview = overviewResult.value;
        // Validate both entries before any completion synchronization. An active
        // task from this channel does not authenticate a foreign latest task.
        assertProvider(overview.activeJob, selectedProvider);
        assertProvider(overview.latestJob, selectedProvider);
        unavailable.value = false;
        failures = 0;
        error.value = '';
        const incoming = overview.activeJob || overview.latestJob;
        if (version !== mutationVersion) return;
        if (incoming && (!requesting.value || incoming.requestId === requestToken?.requestId)) adopt(incoming);
        else if (active.value && job.value) {
          // A missing task is terminal, rather than an endless transient network failure.
          const target = { ...job.value };
          const fallbackVersion = mutationVersion;
          try {
            const restored = await bounded(api.getBridgeJob(target.id));
            if (!readIsCurrent() || fallbackVersion !== mutationVersion || job.value?.id !== target.id) return;
            adopt(restored);
          }
          catch (failure: any) {
            if (!readIsCurrent() || fallbackVersion !== mutationVersion || job.value?.id !== target.id) return;
            if (failure.status !== 404) throw failure;
            adopt({ ...target, status: 'failed', failureCode: 'missing', error: '原任务已失效，可以重新解析；已保存的解析保留。' });
          }
        }
        await syncCompletion(overview.latestJob);
        if (!readIsCurrent()) return;
        if (terminal(job.value)) await syncCompletion(job.value);
      } catch (failure: any) {
        if (readIsCurrent()) {
          failures++;
          unavailable.value = true;
          error.value = failure.message || '正在重新连接本机学习服务。';
        }
      } finally {
        inFlight = null;
        schedule();
      }
    })();
    return inFlight;
  }
  function wake() {
    if (disposed || document.hidden) return;
    clock.value = now();
    window.dispatchEvent(new CustomEvent('yankao-study-bridge-ping'));
    void refresh();
  }
  function start() {
    if (started || disposed) return;
    started = true;
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    clockTimer = setInterval(() => { clock.value = now(); }, 1000);
    wake();
  }
  async function request(payload: RequestPayload) {
    if (disposed || requesting.value || cancelling.value || active.value) return;
    requesting.value = true;
    mutationVersion++;
    run.value = { questionId: payload.questionId, previousText: deps.getSavedText(payload.questionId), requesting: true, requestError: '', progressSynced: false };
    error.value = '';
    const selectedProvider = payload.provider || provider.value;
    if (selectedProvider !== provider.value) { requesting.value = false; if (run.value) { run.value.requesting = false; run.value.requestError = '请先选择对应回复渠道，再发起解析。'; } return; }
    const body = { ...payload, provider: selectedProvider };
    let context = currentContext();
    const requestIsCurrent = () => selectedProvider === provider.value && contextIsCurrent(context);
    const fingerprint = JSON.stringify(body);
    if (!requestToken || requestToken.fingerprint !== fingerprint) saveToken({ fingerprint, requestId: crypto.randomUUID() });
    try {
      window.dispatchEvent(new CustomEvent('yankao-study-bridge-ping'));
      const next = await bounded(api.createBridgeJob({ ...body, requestId: requestToken!.requestId }));
      if (!requestIsCurrent()) return;
      assertProvider(next, selectedProvider);
      mutationVersion++;
      context = currentContext();
      saveToken(null);
      adopt(next);
      context = currentContext();
      window.dispatchEvent(new CustomEvent('yankao-study-bridge-job'));
      await syncCompletion(next);
    } catch (failure: any) {
      if (!requestIsCurrent()) return;
      if (failure.status === 409) {
        try {
          const overview = await bounded(api.getBridgeOverview(selectedProvider));
          if (!requestIsCurrent()) return;
          assertProvider(overview.activeJob, selectedProvider);
          assertProvider(overview.latestJob, selectedProvider);
          if (overview.activeJob) { mutationVersion++; adopt(overview.activeJob); return; }
        } catch { /* Preserve the original request error until the next reconnect. */ }
      }
      if (run.value?.questionId === payload.questionId) run.value.requestError = failure.message || '请求结果暂未确认，连接恢复后请重试；重复点击不会重复提交。';
    } finally {
      requesting.value = false;
      if (run.value) run.value.requesting = false;
      schedule(0);
    }
  }
  async function cancel() {
    if (!job.value || !active.value || cancelling.value || disposed) return;
    cancelling.value = true;
    const id = job.value.id;
    const selectedProvider = provider.value;
    let version = mutationVersion;
    const cancellationIsCurrent = () => !disposed && selectedProvider === provider.value && version === mutationVersion && job.value?.id === id;
    try {
      const ended = await bounded(api.cancelBridgeJob(id));
      if (disposed || selectedProvider !== provider.value) return;
      assertProvider(ended, selectedProvider);
      if (ended.id !== id) throw new Error('结束等待返回了其他任务，未替换当前任务。');
      // Another tab may have started a later task while this cancellation was in flight.
      // Keep A's terminal guard without replacing the currently displayed task B.
      rememberTerminal(ended, selectedProvider);
      if (!cancellationIsCurrent()) return;
      version = ++mutationVersion;
      adopt(ended);
      error.value = '';
      window.dispatchEvent(new CustomEvent('yankao-study-bridge-job'));
      await syncCompletion(ended);
    } catch (failure: any) {
      if (cancellationIsCurrent()) error.value = failure.message || '暂时未能结束等待，正在恢复连接。';
    } finally { cancelling.value = false; schedule(0); }
  }
  function clearCompletedFor(questionId: string) {
    if (!active.value && job.value?.questionId === questionId) {
      observedActive.delete(jobKey(job.value.id));
      mutationVersion++; job.value = null; run.value = null;
    }
  }
  function setProvider(next: WebProvider) {
    if (!['zhipu', 'deepseek'].includes(next) || disposed) return false;
    if (cancelling.value) return false;
    if (next === provider.value) return true;
    if (active.value || requesting.value) return false;
    mutationVersion++;
    observedActive.clear();
    provider.value = next;
    status.value = null; checked.value = false; unavailable.value = false;
    job.value = null; run.value = null; error.value = ''; failures = 0;
    schedule(0);
    return true;
  }
  function dispose() {
    disposed = true;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    if (clockTimer !== undefined) clearInterval(clockTimer);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('online', wake);
    window.removeEventListener('pageshow', wake);
  }
  return { provider, setProvider, status, checked, unavailable, job, run, error, requesting, cancelling, clock, connected, active, stalled, healthMessage, start, refresh, request, cancel, clearCompletedFor, dispose };
}

let singleton: ReturnType<typeof createBridgeController> | null = null;
export function useStudyBridge(deps: BridgeControllerDeps) { return singleton ||= createBridgeController(deps); }
/** Explicit application/test teardown; navigating away from a view must never dispose the task. */
export function resetStudyBridge() { singleton?.dispose(); singleton = null; }
