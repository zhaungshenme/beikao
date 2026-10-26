<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { loadQuestionAnswerHistory } from '@/api/study';
import type { AnswerHistoryEntry, StudyQuestion } from '@/api/study/types';
import { useStudyStore } from '@/store/modules/study';

const props = defineProps<{ question: StudyQuestion }>();
const emit = defineEmits<{ close: [] }>();
const store = useStudyStore();
const base = ref<StudyQuestion>({ ...props.question, answer: [...props.question.answer] });
const answer = ref([...props.question.answer]);
const explanation = ref(props.question.explanation);
const note = ref('');
const entries = ref<AnswerHistoryEntry[]>([]);
const loading = ref(true), saving = ref(false), loaded = ref(false);
const error = ref('');
const loadError = ref(false);
const conflictQuestion = ref<StudyQuestion | null>(null);
const dialog = ref<HTMLElement | null>(null);
let disposed = false;
const returnFocus = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null;
const revision = computed(() => base.value.answerRevision ?? 0);
const dirty = computed(() => answer.value.slice().sort().join('|') !== base.value.answer.slice().sort().join('|') || explanation.value !== base.value.explanation || !!note.value);
const changed = computed(() => answer.value.slice().sort().join('|') !== base.value.answer.slice().sort().join('|') || explanation.value !== base.value.explanation);
const busy = computed(() => loading.value || saving.value);
const valid = computed(() => answer.value.length > 0 && (base.value.type !== 'single' || answer.value.length === 1) && explanation.value.trim().length > 0 && explanation.value.length <= 20000 && note.value.length <= 2000);
const date = (value: string) => Number.isNaN(Date.parse(value)) ? '原始版本' : new Date(value).toLocaleString('zh-CN');
function adopt(question: StudyQuestion) {
  // 编辑器始终保有自己的基线，外页刷新不能悄悄替换尚未保存的草稿。
  base.value = { ...question, answer: [...question.answer] };
  answer.value = [...question.answer]; explanation.value = question.explanation; note.value = '';
  conflictQuestion.value = null;
}
async function load(initial = false, justSaved = false) {
  loading.value = true; error.value = ''; loadError.value = false;
  try {
    const result = await loadQuestionAnswerHistory(props.question.id);
    if (disposed) return;
    entries.value = result.entries;
    if (initial) adopt(result.question);
    loaded.value = true;
  } catch (failure: any) {
    if (!disposed) {
      loadError.value = true;
      error.value = justSaved ? `纠正已保存，但版本历史刷新失败：${failure.message || '请重试读取历史。'}`
        : loaded.value ? `当前答案和编辑内容已保留，但版本历史读取失败：${failure.message || '请重试。'}` : failure.message || '版本记录读取失败，请重试。';
    }
  }
  finally { if (!disposed) loading.value = false; }
}
function choose(id: string, event: Event) {
  if (busy.value) return;
  if (base.value.type === 'single') answer.value = [id];
  else answer.value = (event.target as HTMLInputElement).checked ? [...new Set([...answer.value, id])].sort() : answer.value.filter(value => value !== id);
}
async function confirmDiscard() {
  if (!dirty.value) return true;
  try {
    await ElMessageBox.confirm('当前有尚未保存的纠正内容。放弃后可重新编辑，已保存的答案不受影响。', '放弃未保存的修改？', { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'info' });
    return true;
  } catch { return false; }
}
async function close() { if (!saving.value && await confirmDiscard()) emit('close'); }
function failureMessage(failure: any) {
  error.value = failure.message || '保存未完成，修改内容仍保留，请重试。';
  if (failure.code === 'WRITE_CONFLICT' && failure.current?.id === props.question.id) {
    conflictQuestion.value = failure.current;
    error.value = '该题已在另一页面更新。本次未覆盖，下面保留了你的草稿，请先比较最新版本。';
  }
}
async function save() {
  if (busy.value || !loaded.value || !valid.value || !changed.value || conflictQuestion.value) return;
  saving.value = true; error.value = '';
  try {
    const updated = await store.correctQuestionAnswer(props.question.id, { answer: [...answer.value], explanation: explanation.value, note: note.value, expectedRevision: revision.value });
    adopt(updated); ElMessage.success('答案纠正已保存，后续判分使用新标准');
    await load(false, true);
  } catch (failure: any) { failureMessage(failure); }
  finally { saving.value = false; }
}
async function reloadLatest() {
  if (busy.value || !conflictQuestion.value || !await confirmDiscard()) return;
  adopt(conflictQuestion.value); await load();
}
async function keepDraft() {
  if (busy.value || !conflictQuestion.value) return;
  // 只有用户明确比较后才更新保存基线，不能在冲突后自动重试覆盖。
  base.value = { ...conflictQuestion.value, answer: [...conflictQuestion.value.answer] };
  conflictQuestion.value = null; error.value = ''; await load();
}
async function restore(entry: AnswerHistoryEntry) {
  if (busy.value || conflictQuestion.value || entry.revision === revision.value) return;
  if (!await confirmDiscard()) return;
  try {
    await ElMessageBox.confirm(`将标准答案恢复为 ${entry.answer.join('、')}，并恢复该版本的解析。恢复会生成新版本，当前版本仍可找回；已判分记录和成绩保持原样。`, `恢复版本 ${entry.revision}`, { confirmButtonText: '确认恢复', cancelButtonText: '取消', type: 'info' });
  } catch { return; }
  saving.value = true; error.value = '';
  try {
    const updated = await store.restoreQuestionAnswerVersion(props.question.id, entry.id, revision.value);
    adopt(updated); ElMessage.success('已恢复为新版本'); await load(false, true);
  } catch (failure: any) { failureMessage(failure); }
  finally { saving.value = false; }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || saving.value) { event.preventDefault(); event.returnValue = ''; } }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); void close(); }
  if (event.key !== 'Tab' || !dialog.value?.querySelectorAll) return;
  // Collapsed history and disabled fieldsets contain unfocusable descendants.
  const elements = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
    .filter(element => !element.matches(':disabled') && element.getClientRects().length > 0);
  const first = elements[0], last = elements[elements.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
onMounted(() => { dialog.value?.focus?.(); window.addEventListener?.('beforeunload', beforeUnload); void load(true); });
onBeforeUnmount(() => { disposed = true; window.removeEventListener?.('beforeunload', beforeUnload); returnFocus?.focus?.(); });
</script>

<template>
  <div class="correction-backdrop" @keydown="keydown">
    <section ref="dialog" class="correction-dialog" role="dialog" aria-modal="true" aria-labelledby="correction-title" :aria-busy="busy" tabindex="-1">
      <header class="dialog-heading"><div><p>答案维护 · {{ question.id }} · 版本 {{ revision }}</p><h2 id="correction-title">纠正答案</h2></div><button class="correction-button" :disabled="saving" aria-label="关闭答案纠正" @click="close">关闭 ×</button></header>
      <p class="correction-notice">新标准用于后续判分和 AI 解析。过去已判分的记录与成绩保留当时标准；原有笔记和 AI 解析保留，内容可能需要重新核对。</p>
      <p class="question-stem">{{ question.stem }}</p>
      <p v-if="error" class="correction-error" role="alert">{{ error }}</p>
      <section v-if="conflictQuestion" class="conflict-panel" aria-label="最新保存版本">
        <b>另一页面已保存版本 {{ conflictQuestion.answerRevision ?? 0 }} · 标准答案 {{ conflictQuestion.answer.join('、') }}</b><p class="preserve-lines">{{ conflictQuestion.explanation }}</p><p v-if="conflictQuestion.answerCorrectionNote">纠正说明：{{ conflictQuestion.answerCorrectionNote }}</p>
        <div class="button-group"><button class="correction-button" :disabled="busy" @click="reloadLatest">载入最新版本</button><button class="correction-button" :disabled="busy" @click="keepDraft">已比较，保留我的修改</button></div>
      </section>
      <p v-if="loading" role="status">正在读取最新版本…</p>
      <button v-if="loadError && !loading" class="correction-button" :disabled="saving" @click="load(!loaded)">重试读取版本</button>
      <fieldset :disabled="busy || !loaded"><legend>正确选项 <span>{{ question.type === 'single' ? '（单选，选择 1 项）' : '（多选，至少选择 1 项）' }}</span></legend><label v-for="option in question.options" :key="option.id" class="answer-option" :class="{ selected: answer.includes(option.id) }"><input :type="question.type === 'single' ? 'radio' : 'checkbox'" :name="`correct-answer-${question.id}`" :checked="answer.includes(option.id)" :aria-label="`正确选项 ${option.id}`" @change="choose(option.id, $event)"><b>{{ option.id }}.</b><span>{{ option.text }}</span></label></fieldset>
      <label class="editor-label">题目解析 <textarea v-model="explanation" aria-label="纠正后的题目解析" :disabled="busy || !loaded" rows="5" maxlength="20000" placeholder="说明正确答案的依据，以及易混选项的区别。" /></label>
      <label class="editor-label">纠正说明（选填）<textarea v-model="note" aria-label="答案纠正说明" :disabled="busy || !loaded" rows="2" maxlength="2000" placeholder="例如参考资料、纠正原因，便于日后核对。" /></label>
      <footer class="editor-actions"><span role="status">{{ saving ? '正在保存…' : dirty ? changed ? '修改尚未保存' : '请修改答案或解析后再保存纠正说明' : '当前答案：' + base.answer.join('、') }}</span><button class="correction-button" :disabled="saving" @click="close">取消</button><button class="correction-button primary" :disabled="busy || !loaded || !valid || !changed || !!conflictQuestion" @click="save">保存纠正</button></footer>
      <details class="version-history"><summary>版本历史与恢复（{{ entries.length }}）</summary><p>原始版本始终保留。恢复会生成新版本，不会删除已有历史。</p><article v-for="entry in entries" :key="entry.id" class="version-row"><div class="version-heading"><b>版本 {{ entry.revision }} · {{ entry.answer.join('、') }}{{ entry.revision === revision ? ' · 当前' : '' }}</b><span>{{ entry.source === 'original' ? '题库原始版本' : date(entry.createdAt) }}</span></div><p class="preserve-lines">{{ entry.explanation }}</p><p v-if="entry.note" class="version-note">说明：{{ entry.note }}</p><button class="correction-button" :disabled="busy || !!conflictQuestion || entry.revision === revision" :aria-label="`恢复答案版本 ${entry.revision}`" @click="restore(entry)">{{ entry.revision === revision ? '当前版本' : '恢复此版本' }}</button></article></details>
    </section>
  </div>
</template>

<style scoped>
.correction-backdrop{position:fixed;inset:0;z-index:2000;background:#0008;display:flex;align-items:center;justify-content:center;padding:24px;font:17px/1.8 "Microsoft YaHei","微软雅黑",sans-serif;color:#171717}.correction-dialog{width:900px;max-width:100%;max-height:92vh;overflow:auto;background:#fff;border:1px solid #888;border-radius:14px;padding:28px 32px;box-shadow:0 16px 70px #0004;outline:none}.correction-dialog *{box-sizing:border-box}.dialog-heading,.version-heading{display:flex;justify-content:space-between;align-items:center;gap:18px}.dialog-heading p{font-size:15px;color:#444;margin:0}.dialog-heading h2{font:29px/1.6 "SimSun","宋体",serif;margin:4px 0 12px}.question-stem{font-size:20px;font-weight:600;line-height:1.9;margin:20px 0;white-space:pre-wrap}.correction-notice{background:#f2f2f2;border-left:3px solid #333;padding:12px 16px;font-size:16px;color:#333}.correction-error{border:1px dashed #555;background:#f4f4f4;padding:12px 16px;overflow-wrap:anywhere}.correction-dialog fieldset{margin:18px 0;border:0;padding:0;min-width:0}.correction-dialog legend{font-weight:600;margin-bottom:10px}.correction-dialog legend span{font-weight:400;color:#333}.answer-option{display:flex;gap:12px;align-items:baseline;padding:13px 15px;border:1px solid #929292;border-radius:7px;margin:9px 0;cursor:pointer;transition:background .15s,box-shadow .15s,transform .15s}.answer-option:hover{background:#eee;transform:translateX(2px);box-shadow:0 2px 6px #0001}.answer-option.selected{border:2px solid #171717;background:#eee;padding:12px 14px}.answer-option input{width:19px;height:19px;accent-color:#171717;cursor:pointer;flex-shrink:0}.answer-option span{overflow-wrap:anywhere}.editor-label{display:flex;flex-direction:column;gap:9px;font-weight:600;margin:20px 0}.editor-label textarea{font:17px/1.9 "Microsoft YaHei","微软雅黑",sans-serif;font-weight:400;color:#171717;border:1px solid #858585;border-radius:7px;padding:12px;width:100%;resize:vertical;min-height:90px;background:#fff}.editor-label textarea::placeholder{color:#555;opacity:1}.correction-button{font:16px/1.5 "Microsoft YaHei","微软雅黑",sans-serif;border:1px solid #858585;border-radius:7px;padding:10px 15px;min-height:43px;background:#fff;color:#171717;cursor:pointer;transition:background .15s,transform .15s,box-shadow .15s}.correction-button:hover:not(:disabled){background:#e9e9e9;transform:translateY(-1px);box-shadow:0 3px 7px #0002}.correction-button.primary{background:#171717;color:#fff;border-color:#171717}.correction-button.primary:hover:not(:disabled){background:#000}.correction-dialog button:disabled,.correction-dialog textarea:disabled{cursor:not-allowed;background:#e8e8e8;color:#555;border-color:#aaa}.correction-dialog button:focus-visible,.correction-dialog textarea:focus-visible,.correction-dialog input:focus-visible,.correction-dialog summary:focus-visible{outline:2px solid #171717;outline-offset:3px}.editor-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:24px 0}.editor-actions>span{margin-right:auto;font-size:15px;color:#333}.version-history{border-top:1px solid #aaa;padding-top:16px}.version-history summary{cursor:pointer;width:fit-content;padding:7px 0;font-weight:600;text-underline-offset:5px}.version-history summary:hover{text-decoration:underline}.version-history>p{font-size:15px;color:#333}.version-row{padding:18px 0;border-top:1px solid #ccc}.version-heading{align-items:baseline;flex-wrap:wrap;font-size:16px}.version-heading span,.version-note{font-size:15px;color:#333}.preserve-lines{white-space:pre-wrap;overflow-wrap:anywhere}.conflict-panel{border:2px solid #333;border-radius:7px;padding:16px;background:#f5f5f5}.button-group{display:flex;gap:12px;flex-wrap:wrap}@media(max-width:640px){.correction-backdrop{padding:8px}.correction-dialog{padding:20px 17px;max-height:96vh}.dialog-heading h2{font-size:25px}.question-stem{font-size:18px}.dialog-heading{gap:10px}.editor-actions>span{width:100%}}@media(prefers-reduced-motion:reduce){.answer-option,.correction-button{transition:none}.answer-option:hover,.correction-button:hover:not(:disabled){transform:none}}
</style>
