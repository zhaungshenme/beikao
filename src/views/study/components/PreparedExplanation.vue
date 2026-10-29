<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import * as api from '@/api/study';
import type { PreparedExplanation, StudyQuestion } from '@/api/study/types';

const props = defineProps<{ question: StudyQuestion }>();
const emit = defineEmits<{ (event: 'standard-updated'): void }>();
const prepared = ref<PreparedExplanation | null>(null);
const error = ref('');
const loading = ref(false);
const standardMismatch = ref(false);
const ready = computed(() => prepared.value?.questionId === props.question.id && prepared.value.state === 'ready' && !standardMismatch.value && !!prepared.value.text.trim());
const stateText = computed(() => {
  if (standardMismatch.value) return '标准已在其他页面更新，请刷新题目';
  if (ready.value) return '已保存 · 可立即阅读';
  if (prepared.value?.state === 'review') return 'AI 回复待核验，先看题库讲解';
  if (prepared.value?.state === 'stale') return '标准已更新，通用讲解等待重新生成';
  return '通用 AI 讲解尚未备好，先看题库讲解';
});
const generatedTime = computed(() => {
  const time = prepared.value?.generatedAt;
  return time && Number.isFinite(Date.parse(time)) ? new Date(time).toLocaleString('zh-CN', { hour12: false }) : '';
});
// Content changes, not just IDs, must discard a previous question/version response.
const version = computed(() => JSON.stringify([props.question.id, props.question.type, props.question.stem,
  props.question.options.map(option => [option.id, option.text]), [...props.question.answer].sort(), props.question.explanation,
  props.question.answerRevision ?? 0]));
let disposed = false;
let generation = 0;
let requestSequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const notifiedVersions = new Set<string>();

async function load(request: number, questionId: string) {
  if (disposed) return;
  const sequence = ++requestSequence;
  if (timer) clearTimeout(timer);
  loading.value = true;
  try {
    const incoming = await api.getPreparedExplanation(questionId);
    if (disposed || request !== generation || sequence !== requestSequence || props.question.id !== questionId) return;
    if (incoming.questionId !== questionId) throw new Error('通用讲解的题号未通过校验，已保留题库讲解。');
    if (incoming.contentVersion !== version.value || incoming.questionRevision !== (props.question.answerRevision ?? 0)) {
      // Another tab can correct the standard while this page still has its old
      // question. Do not place a new explanation beside that old grading key.
      prepared.value = null;
      standardMismatch.value = true;
      error.value = '';
      if (typeof incoming.contentVersion === 'string' && !notifiedVersions.has(incoming.contentVersion)) {
        notifiedVersions.add(incoming.contentVersion);
        emit('standard-updated');
      }
      return;
    }
    prepared.value = incoming;
    standardMismatch.value = false;
    error.value = '';
  } catch (failure: any) {
    if (!disposed && request === generation && sequence === requestSequence) error.value = failure.message || '通用讲解暂时无法读取，题库讲解仍可阅读。';
  } finally {
    if (!disposed && request === generation && sequence === requestSequence) {
      loading.value = false;
      // Ready content is revalidated too: a correction made in another page
      // must withdraw the former answer, even if this view remains open.
      timer = setTimeout(() => { void load(request, questionId); }, ready.value ? 15000 : 5000);
    }
  }
}
function focus() { void load(generation, props.question.id); }
watch(version, () => {
  if (timer) clearTimeout(timer);
  prepared.value = null;
  standardMismatch.value = false;
  error.value = '';
  void load(++generation, props.question.id);
}, { immediate: true });
onMounted(() => { if (typeof window !== 'undefined') window.addEventListener?.('focus', focus); });
onUnmounted(() => {
  disposed = true; ++generation; ++requestSequence;
  if (timer) clearTimeout(timer);
  if (typeof window !== 'undefined') window.removeEventListener?.('focus', focus);
});
</script>

<template>
  <section class="prepared-explanation" :aria-label="ready ? '通用 AI 讲解' : '题库讲解'">
    <div class="prepared-heading"><h3>{{ ready ? '通用 AI 讲解' : '题库讲解' }}</h3><span>{{ stateText }}</span></div>
    <p class="explanation-body">{{ standardMismatch ? '题目标准与服务器版本不一致，已暂时收起旧讲解，正在同步最新题目。' : ready ? prepared?.text : question.explanation || '这道题暂未提供题库讲解，可检索并保存本题网页与文档资料。' }}</p>
    <p v-if="ready" class="prepared-source">{{ prepared?.source || '来源未记录' }}<span v-if="generatedTime"> · {{ generatedTime }}</span><span v-if="prepared?.validation?.answer === 'not-recorded'"> · 历史记录未保存答案快照</span></p>
    <details v-if="ready && question.explanation" class="original"><summary>查看题库原解析</summary><p class="explanation-body">{{ question.explanation }}</p></details>
    <p v-if="error" class="prepared-note" role="status">{{ error }}</p>
    <p class="prepared-note">{{ standardMismatch ? '同步完成后将按最新题目显示讲解；此前已保存的学习记录和历史成绩保留。' : ready ? '这是此前保存的题目通用讲解；资料检索仅查找公开网页正文与文档摘录，不会重新调用生成模型。' : '可直接阅读题库讲解；也可通过 Search／Fetch 检索并保存本题网页正文与文档摘录，不调用生成模型。' }}</p>
  </section>
</template>

<style scoped>
.prepared-explanation{padding:24px;border:1px solid #8c8c8c;border-radius:12px;background:#fafafa;color:#171717;font:17px/1.9 "Microsoft YaHei","微软雅黑",sans-serif}.prepared-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.prepared-heading h3{margin:0;font:700 24px/1.5 SimSun,"宋体",serif}.prepared-heading span{color:#3f3f3f;font-size:14px}.explanation-body{white-space:pre-wrap;overflow-wrap:anywhere;margin:16px 0;color:#171717}.prepared-source,.prepared-note{font-size:14px;color:#3f3f3f;margin:12px 0 0}.original{margin-top:16px;padding-top:12px;border-top:1px solid #aaa}.original summary{display:inline-block;padding:5px 10px;border:1px solid #777;border-radius:6px;background:#fff;cursor:pointer;transition:background .15s,transform .15s}.original summary:hover{background:#e5e5e5;transform:translateX(3px)}.original summary:focus-visible{outline:3px solid #171717;outline-offset:3px}.original .explanation-body{font-size:16px}@media(max-width:640px){.prepared-explanation{padding:18px}}@media(prefers-reduced-motion:reduce){.original summary{transition:none}.original summary:hover{transform:none}}
</style>
