<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import * as api from '@/api/study';
import type { PreanalysisModel, PreanalysisSettings, PreanalysisSettingsChanges, PreanalysisStatus, PreanalysisTransport, PreanalysisWebDriver } from '@/api/study/types';

withDefaults(defineProps<{ providerName?: string }>(), { providerName: '智谱清言' });
const emit = defineEmits<{ settingsChanged: [settings: PreanalysisSettings] }>();
const status = ref<PreanalysisStatus | null>(null);
const batchSize = ref(3);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const settings = ref<PreanalysisSettings | null>(null);
const settingsLoading = ref(true);
const savingSettings = ref(false);
const settingsError = ref('');
const settingsMessage = ref('');
const transportDraft = ref<PreanalysisTransport>('web');
const webDriverDraft = ref<PreanalysisWebDriver>('userscript');
const modelDraft = ref<PreanalysisModel>('glm-4.7-flash');
const apiKeyDraft = ref('');
const percent = computed(() => status.value?.total ? Math.floor(status.value.completed / status.value.total * 100) : 0);
const stateName = computed(() => ({ idle: '尚未开始', running: '正在预解析', paused: '已暂停', completed: '全部已备好' }[status.value?.status || 'idle']));
const activeTransport = computed(() => status.value?.transport ?? settings.value?.transport ?? 'web');
const activeWebDriver = computed(() => status.value?.webDriver ?? settings.value?.webDriver ?? 'userscript');
const settingsLocked = computed(() => busy.value || savingSettings.value || settingsLoading.value || !settings.value || !status.value || status.value.status === 'running' || !!status.value.currentJobId);
const hasSettingsDraft = computed(() => !!settings.value && (transportDraft.value !== settings.value.transport ||
  transportDraft.value === 'official-api' && modelDraft.value !== settings.value.model ||
  transportDraft.value === 'web' && webDriverDraft.value !== (settings.value.webDriver ?? 'userscript') || !!apiKeyDraft.value.trim()));
const selectedModelName = computed(() => modelDraft.value === 'glm-4-flash-250414' ? 'GLM-4-Flash-250414' : 'GLM-4.7-Flash');
const missingKey = computed(() => settings.value?.transport === 'official-api' && !settings.value.configured);
const canStart = computed(() => !busy.value && !loading.value && !savingSettings.value && !settingsLoading.value && !!settings.value && !!status.value && !status.value.currentJobId && !hasSettingsDraft.value && !missingKey.value && !['running', 'completed'].includes(status.value.status));
const keyStorageMessage = computed(() => settings.value && !settings.value.configured && settings.value.keyStorage !== 'none'
  ? '密钥暂不可用，请重新设置模型标准 API 密钥，或检查本机环境变量。'
  : settings.value?.keyStorage === 'environment' ? '已通过本机环境变量配置密钥；请在环境变量中管理。'
    : settings.value?.keyStorage === 'windows-dpapi' ? '密钥已在本机使用 Windows 账户加密保存。' : '尚未配置官方 API 密钥。');
let disposed = false;
let sequence = 0;
let settingsSequence = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  if (pollTimer) clearTimeout(pollTimer);
  if (!disposed) pollTimer = setTimeout(() => { void refresh(); }, status.value?.status === 'running' ? 2500 : 5000);
}
async function refresh() {
  if (busy.value || savingSettings.value || disposed) return;
  const request = ++sequence;
  loading.value = !status.value;
  try {
    const incoming = await api.getPreanalysisStatus();
    if (disposed || request !== sequence) return;
    if (!status.value || incoming.status === 'running') batchSize.value = incoming.batchSize;
    status.value = incoming;
    error.value = '';
  } catch (failure: any) {
    if (!disposed && request === sequence) error.value = failure.message || '暂时无法读取预解析进度，已保存的讲解保留。';
  } finally {
    if (!disposed && request === sequence) { loading.value = false; schedule(); }
  }
}
async function control(action: 'start' | 'pause' | 'retry') {
  if (busy.value || savingSettings.value || disposed || action !== 'pause' && !canStart.value) return;
  ++sequence; // A response issued before this control must never replace its result.
  if (pollTimer) clearTimeout(pollTimer);
  busy.value = true;
  error.value = '';
  try {
    const incoming = await api.controlPreanalysis({ action, ...(action === 'pause' ? {} : { batchSize: batchSize.value }) });
    if (!disposed) status.value = incoming;
  } catch (failure: any) {
    if (!disposed) error.value = failure.message || '操作未完成，请重试；已保存的讲解保留。';
  } finally {
    if (!disposed) { busy.value = false; loading.value = false; schedule(); }
  }
}

function applySettings(incoming: PreanalysisSettings) {
  // Only public configuration enters component state; keys remain in the password draft.
  settings.value = { transport: incoming.transport, webDriver: incoming.webDriver ?? 'userscript', configured: incoming.configured, model: incoming.model, baseUrl: incoming.baseUrl, keyStorage: incoming.keyStorage };
  transportDraft.value = incoming.transport;
  webDriverDraft.value = incoming.webDriver ?? 'userscript';
  modelDraft.value = incoming.model;
  emit('settingsChanged', { ...settings.value });
}
async function loadSettings() {
  if (savingSettings.value || disposed) return;
  const request = ++settingsSequence;
  settingsLoading.value = true;
  settingsError.value = '';
  try {
    const incoming = await api.getPreanalysisSettings();
    if (!disposed && request === settingsSequence) applySettings(incoming);
  } catch {
    if (!disposed && request === settingsSequence) settingsError.value = '暂时无法读取渠道配置，请确认本机服务正常后重新读取。';
  } finally {
    if (!disposed && request === settingsSequence) settingsLoading.value = false;
  }
}
async function saveSettings(clearApiKey = false) {
  if (settingsLocked.value || clearApiKey && settings.value?.keyStorage !== 'windows-dpapi') return;
  if (!clearApiKey && transportDraft.value === 'official-api' && !settings.value?.configured && !apiKeyDraft.value.trim()) {
    settingsError.value = '请先在官方控制台创建模型标准 API Key，并在本机填写。';
    return;
  }
  ++settingsSequence; // An earlier configuration read must not replace this save.
  ++sequence;
  if (pollTimer) clearTimeout(pollTimer);
  savingSettings.value = true;
  settingsError.value = '';
  settingsMessage.value = '';
  const changes: PreanalysisSettingsChanges = clearApiKey ? { clearApiKey: true } : {
    transport: transportDraft.value,
    ...(transportDraft.value === 'web' ? { webDriver: webDriverDraft.value } : {}),
    ...(transportDraft.value === 'official-api' ? { model: modelDraft.value } : {}),
    ...(transportDraft.value === 'official-api' && apiKeyDraft.value.trim() ? { apiKey: apiKeyDraft.value.trim() } : {}),
  };
  try {
    const incoming = await api.savePreanalysisSettings(changes);
    if (disposed) return;
    applySettings(incoming);
    apiKeyDraft.value = '';
    if (status.value) status.value = { ...status.value, transport: incoming.transport, webDriver: incoming.webDriver ?? 'userscript' };
    settingsMessage.value = clearApiKey ? '本机保存的密钥已清除。' : '渠道配置已保存，尚未启动；请点击下方开始或继续预解析。';
  } catch (failure: any) {
    // A provider or server error may contain the submitted key: never render it here.
    if (!disposed) settingsError.value = failure?.status === 409
      ? '当前仍有预解析任务，请先暂停并等待本轮结束，再保存配置。'
      : '配置未保存，请检查本机服务与密钥配置后重试。';
  } finally {
    if (!disposed) { savingSettings.value = false; loading.value = false; schedule(); }
  }
}
function refreshAll() {
  void refresh();
  if (!hasSettingsDraft.value) void loadSettings();
}
onMounted(() => { void refresh(); void loadSettings(); });
onUnmounted(() => { disposed = true; ++sequence; ++settingsSequence; apiKeyDraft.value = ''; if (pollTimer) clearTimeout(pollTimer); });
</script>

<template>
  <section class="preanalysis-manager" aria-label="题库预解析">
    <div class="heading"><div><p class="eyebrow">提前备好 · 随时阅读</p><h3>题库预解析</h3></div><span class="status" :class="{ running: status?.status === 'running' }">{{ stateName }}</span></div>
    <p class="intro">提前生成并保存通用讲解，只使用题库和标准答案，不发送你的作答、笔记或学习记录。你主动点击 AI 解析时，再比较本次选择。</p>
    <form class="channel-settings" aria-label="预解析渠道配置" @submit.prevent="saveSettings()">
      <h4>生成渠道</h4>
      <label>通用讲解生成渠道
        <select v-model="transportDraft" aria-label="通用讲解生成渠道" :disabled="settingsLocked">
          <option value="official-api">智谱官方 API</option>
          <option value="web">{{ providerName }} 网页</option>
        </select>
      </label>
      <template v-if="transportDraft === 'official-api'">
        <label>官方模型
          <select v-model="modelDraft" aria-label="官方模型" :disabled="settingsLocked">
            <option value="glm-4.7-flash">GLM-4.7-Flash</option>
            <option value="glm-4-flash-250414">GLM-4-Flash-250414</option>
          </select>
        </label>
        <p class="help">所选模型为智谱官方 {{ selectedModelName }}。使用“模型标准 API”密钥；如已在本机保存，可留空保留现有密钥。尚未配置时，可到 <a href="https://bigmodel.cn/usercenter/proj-mgmt/apikeys" target="_blank" rel="noopener noreferrer">官方控制台密钥管理</a> 创建后在本机填写，无需把密钥发到聊天。个人或团队 Coding 套餐的密钥与模型标准 API 不通用。</p>
        <p class="help">模型价格、账户额度、速率与并发限制以 <a href="https://bigmodel.cn/pricing" target="_blank" rel="noopener noreferrer">官方价格页</a> 及账户规则为准。模型需要明确选择并保存，不会自动切换模型。</p>
        <label>官方 API Key
          <input v-model="apiKeyDraft" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="官方 API Key" maxlength="2000" :placeholder="settings?.configured ? '已配置，留空保留现有密钥' : '仅在本机填写官方 API Key'" :disabled="settingsLocked">
        </label>
        <p class="help" role="status">{{ keyStorageMessage }}</p>
      </template>
      <template v-else>
        <label>网页执行方式
          <select v-model="webDriverDraft" aria-label="网页执行方式" :disabled="settingsLocked">
            <option value="browser-ui">浏览器操作接口（高级，需外部集成）</option>
            <option value="userscript">页面脚本</option>
          </select>
        </label>
        <p v-if="webDriverDraft === 'browser-ui'" class="help">此高级接口需外部浏览器操作器或人工集成，操作 {{ providerName }} 网页并回传完整回复。备考不内置聊天代理或浏览器操作器；仅保存配置不会自动操作网页。无需 API Key 或页面脚本，使用前请先确认外部集成可用。</p>
        <p v-else class="help">打开普通 {{ providerName }} 页面，点击页面脚本的“连接此页”后生成；同一时间只连接一页，已有草稿会保留。页面脚本需为 1.7.0，实际可用性取决于网页结构与账户状态。</p>
      </template>
      <div class="settings-actions">
        <button type="submit" :disabled="settingsLocked || !hasSettingsDraft">{{ savingSettings ? '正在保存…' : '保存渠道配置' }}</button>
        <button v-if="transportDraft === 'official-api' && settings?.keyStorage === 'windows-dpapi'" type="button" :disabled="settingsLocked" @click="saveSettings(true)">清除本机密钥</button>
        <button v-if="settingsError && !settings" type="button" :disabled="settingsLoading || savingSettings" @click="loadSettings">重新读取渠道配置</button>
      </div>
      <p v-if="settingsLoading" class="help" role="status">正在读取渠道配置…</p>
      <p v-if="status?.status === 'running' || status?.currentJobId" class="help">请先暂停并等待当前批次结束，再修改渠道或密钥。</p>
      <p v-if="settingsError" class="error" role="alert">{{ settingsError }}</p>
      <p v-if="settingsMessage" class="help" role="status">{{ settingsMessage }}</p>
    </form>
    <div v-if="status" class="progress-area" aria-live="polite">
      <div class="count"><strong>{{ status.completed }} <span>/ {{ status.total }} 题</span></strong><span>{{ percent }}%</span></div>
      <progress :max="status.total || 1" :value="status.completed" :aria-label="`已预解析 ${status.completed} 题，共 ${status.total} 题`"></progress>
      <p class="counts">待解析 {{ status.pending }}<span v-if="status.failed"> · 待重试 {{ status.failed }}</span><span v-if="status.stale"> · 标准更新后待重做 {{ status.stale }}</span></p>
      <p v-if="status.message" class="message">{{ status.message }}</p>
    </div>
    <p v-else-if="loading" role="status">正在读取已保存进度…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="controls">
      <label>每轮题量 <select v-model.number="batchSize" aria-label="预解析每轮题量" :disabled="busy || savingSettings || status?.status === 'running'"><option :value="1">1 题 · 更稳妥</option><option :value="3">3 题 · 推荐</option><option :value="5">5 题 · 更少轮次</option></select></label>
      <button v-if="status?.status === 'running'" type="button" :disabled="busy" @click="control('pause')">暂停预解析</button>
      <button v-else type="button" class="primary" :disabled="!canStart" @click="control('start')">{{ busy ? '正在处理…' : status?.status === 'paused' ? '继续预解析' : status?.status === 'completed' ? '全部已备好' : '开始预解析' }}</button>
      <button v-if="status?.failed" type="button" :disabled="!canStart || status.status === 'running'" @click="control('retry')">重试未通过的批次</button>
      <button type="button" :disabled="busy || loading || savingSettings" @click="refreshAll">刷新进度</button>
    </div>
    <p v-if="hasSettingsDraft" class="help">渠道、模型、网页执行方式或密钥尚未保存，请先保存配置，再启动预解析。</p>
    <p v-else-if="missingKey" class="help">请先保存官方 API 密钥，再启动预解析。</p>
    <p v-if="activeTransport === 'official-api'" class="help" data-testid="preanalysis-transport-help">官方 API 由本机服务逐批生成，无需保持备考和 {{ providerName }} 网页打开；请保持本机服务运行。遇到账户限制或回复校验失败会暂停，已完成的题目保留。</p>
    <p v-else-if="activeWebDriver === 'browser-ui'" class="help" data-testid="preanalysis-transport-help">当前使用高级浏览器操作接口，需外部浏览器操作器或人工集成完成 {{ providerName }} 网页操作与回复回传。备考不内置聊天代理或浏览器操作器；仅保存配置不会自动运行。请保持网页与外部集成可用。登录提示、验证码或使用限额需在原页处理，已完成讲解保留。此设置不改变主动点击的个性化解析渠道。</p>
    <p v-else class="help" data-testid="preanalysis-transport-help">请保持备考与已连接的 {{ providerName }} 页面打开；普通网页点击“连接此页”即可使用。已有草稿不会覆盖，失联后暂停发送；重新连接前先核对本轮状态。遇到登录提示或使用限额时，需先在网页处理。已完成的题目保留，主动点击的解析优先。</p>
  </section>
</template>

<style scoped>
.channel-settings{margin:18px 0;padding:18px;border:1px solid #949494;border-radius:10px}.channel-settings h4{margin:0 0 12px;font-size:18px}.channel-settings label{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0}.channel-settings input,.channel-settings select,.settings-actions button{box-sizing:border-box;max-width:100%;min-height:44px;padding:8px 12px;border:1px solid #737373;border-radius:8px;background:#fff;color:#171717;font:inherit}.channel-settings input{width:350px}.channel-settings a{color:#171717;text-decoration:underline;text-underline-offset:3px}.settings-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}.settings-actions button{cursor:pointer}.settings-actions button:hover:not(:disabled){background:#ededed}.channel-settings :focus-visible{outline:3px solid #171717;outline-offset:3px}.channel-settings :disabled{cursor:not-allowed;background:#e5e5e5;color:#484848;border-color:#999}
.preanalysis-manager{box-sizing:border-box;padding:26px;border:1px solid #949494;border-radius:16px;background:#fff;color:#171717;font:16px/1.7 "Microsoft YaHei","微软雅黑",sans-serif}.heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.eyebrow{font-size:14px;color:#3f3f3f;margin:0}.heading h3{margin:2px 0 0;font-size:25px;font-family:SimSun,"宋体",serif}.status{padding:4px 12px;background:#ededed;border:1px solid #8c8c8c;border-radius:100px;white-space:nowrap;font-size:15px}.status.running{color:#fff;background:#171717;border-color:#171717}.intro{margin:16px 0;color:#333}.progress-area{padding:18px;background:#f3f3f3;border-radius:10px}.count{display:flex;justify-content:space-between;align-items:center;gap:16px}.count strong{font-size:27px}.count strong span{font-size:17px;font-weight:400}.progress-area progress{display:block;width:100%;height:12px;margin:10px 0;accent-color:#171717}.counts,.message{margin:6px 0 0;font-size:15px;color:#333}.controls{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin-top:18px}.controls label{display:flex;gap:8px;align-items:center}.controls select,.controls button{font:inherit;min-height:44px;padding:8px 14px;background:white;border:1px solid #737373;border-radius:8px;color:#171717}.controls button,.controls select{cursor:pointer;transition:transform .15s,background .15s,box-shadow .15s}.controls button:hover:not(:disabled){transform:translateY(-2px);background:#ededed;box-shadow:0 3px 0 #d4d4d4}.controls button.primary{background:#171717;color:white;border-color:#171717}.controls button.primary:hover:not(:disabled){background:#333}.controls :focus-visible{outline:3px solid #171717;outline-offset:3px}.controls :disabled{cursor:not-allowed;background:#e5e5e5;color:#484848;border-color:#999}.help{font-size:14px;color:#3f3f3f;margin:16px 0 0}.error{padding:10px 14px;border:1px solid #666;background:#eee;font-size:16px;color:#171717}@media(max-width:640px){.preanalysis-manager{padding:18px}.controls{align-items:stretch}.controls label{flex-wrap:wrap}.controls button{flex-grow:1}}@media(prefers-reduced-motion:reduce){.controls button,.controls select{transition:none}.controls button:hover:not(:disabled){transform:none}}
</style>
