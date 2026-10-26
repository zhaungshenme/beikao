<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useStudyStore } from '@/store/modules/study';
import type { StudyQuestion, StudySession } from '@/api/study/types';
import AnswerCorrectionDialog from './AnswerCorrectionDialog.vue';
import { studyGradingResult } from '@/utils/studyGrading';

const props = defineProps<{ kind: 'bank' | 'history' }>();
const emit = defineEmits<{ review: [question: StudyQuestion]; session: [session: StudySession]; practice: [] }>();
const store = useStudyStore();
type ManagedSession = StudySession & { removed?: boolean; revision?: number };
type ManagementActions = {
  questionRecords?: Record<string, { removed?: boolean; revision?: number }>;
  removeQuestionRecords?: (ids: string[]) => Promise<unknown>;
  restoreQuestionRecords?: (ids: string[]) => Promise<unknown>;
  removeSessionRecords?: (ids: string[]) => Promise<unknown>;
  restoreSessionRecords?: (ids: string[]) => Promise<unknown>;
};
const management = store as typeof store & ManagementActions;
const query = ref('');
const category = ref('all');
const questionType = ref('all');
const difficulty = ref('all');
const sessionStatus = ref('all');
const tab = ref<'normal' | 'removed'>('normal');
const currentPage = ref(1);
const pageSizes = [20, 50, 100, 200];
const pageSizeKey = (kind: 'bank' | 'history') => `yankao-management-page-size-${kind}`;
function readPageSize(kind: 'bank' | 'history') {
  try {
    const saved = Number(localStorage.getItem(pageSizeKey(kind)));
    if (pageSizes.includes(saved)) return saved;
  } catch { /* 存储不可用时仍可在当前页面调整。 */ }
  return 20;
}
const pageSize = ref(readPageSize(props.kind));
const selectedIds = ref<string[]>([]);
const changing = ref(false);
const actionError = ref('');
const editingQuestionId = ref('');
const editingQuestion = computed(() => (store.questions || []).find(q => q.id === editingQuestionId.value));
const busy = computed(() => changing.value || !!store.busy);
const isBank = computed(() => props.kind === 'bank');
const modeNames: Record<string, string> = { sequential: '顺序练习', random: '随机练习', exam: '模拟考试', wrong: '错题重练', favorites: '收藏练习' };
const categories = computed(() => [...new Set((store.questions || []).map(q => q.category))]);
const difficulties = computed(() => [...new Set((store.questions || []).map(q => q.difficulty))]);
const questionRemoved = (id: string) => !!management.questionRecords?.[id]?.removed;
const sessions = computed(() => (store.sessions || []) as ManagedSession[]);
const removedCount = computed(() => isBank.value ? (store.questions || []).filter(q => questionRemoved(q.id)).length : sessions.value.filter(s => s.removed).length);
const totalCount = computed(() => isBank.value ? (store.questions || []).length : sessions.value.length);
const normalCount = computed(() => totalCount.value - removedCount.value);
const normalize = (value: unknown) => String(value ?? '').toLocaleLowerCase().trim();
const readValue = (event: Event) => (event.target as HTMLInputElement).value;
function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value || '时间未记录' : parsed.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
const filteredQuestions = computed(() => {
  const text = normalize(query.value);
  return (store.questions || []).filter(q => questionRemoved(q.id) === (tab.value === 'removed') &&
    (category.value === 'all' || q.category === category.value) &&
    (questionType.value === 'all' || q.type === questionType.value) &&
    (difficulty.value === 'all' || q.difficulty === difficulty.value) &&
    (!text || normalize([q.id, q.stem, q.knowledgePoint, ...q.options.map(o => o.text)].join(' ')).includes(text)));
});
const filteredSessions = computed(() => {
  const text = normalize(query.value);
  return sessions.value.filter(s => !!s.removed === (tab.value === 'removed') &&
    (sessionStatus.value === 'all' || s.status === sessionStatus.value) &&
    (!text || normalize([s.id, modeNames[s.mode] || s.mode, s.createdAt, date(s.createdAt)].join(' ')).includes(text)))
    .slice().sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
});
const filteredCount = computed(() => isBank.value ? filteredQuestions.value.length : filteredSessions.value.length);
const pageCount = computed(() => Math.max(1, Math.ceil(filteredCount.value / pageSize.value)));
const pageQuestions = computed(() => filteredQuestions.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
const pageSessions = computed(() => filteredSessions.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
const pageIds = computed(() => (isBank.value ? pageQuestions.value : pageSessions.value).map(item => item.id));
const allSelected = computed(() => !!pageIds.value.length && pageIds.value.every(id => selectedIds.value.includes(id)));
const partialSelected = computed(() => !!selectedIds.value.length && !allSelected.value);
const actionLabel = computed(() => `${tab.value === 'removed' ? '恢复' : '删除'}选中${isBank.value ? '题目' : '记录'}`);
watch([query, category, questionType, difficulty, sessionStatus, tab], () => {
  currentPage.value = 1; selectedIds.value = []; actionError.value = '';
}, { flush: 'sync' });
watch(currentPage, () => { selectedIds.value = []; }, { flush: 'sync' });
watch(() => props.kind, () => {
  query.value = ''; category.value = 'all'; questionType.value = 'all'; difficulty.value = 'all';
  sessionStatus.value = 'all'; tab.value = 'normal'; currentPage.value = 1;
  pageSize.value = readPageSize(props.kind);
  selectedIds.value = []; actionError.value = '';
}, { flush: 'sync' });
watch(pageCount, count => { if (currentPage.value > count) currentPage.value = count; }, { flush: 'sync' });
watch(pageIds, ids => {
  const visible = new Set(ids); selectedIds.value = selectedIds.value.filter(id => visible.has(id));
}, { flush: 'sync' });
function setTab(next: 'normal' | 'removed') { if (!busy.value) tab.value = next; }
function turnPage(next: number) { if (!busy.value) currentPage.value = Math.max(1, Math.min(pageCount.value, next)); }
function changePageSize(event: Event) {
  if (busy.value) return;
  const next = Number(readValue(event));
  if (!pageSizes.includes(next) || next === pageSize.value) return;
  // 先清理当前选择，避免页容量变化后误操作原先勾选的记录。
  selectedIds.value = []; actionError.value = ''; currentPage.value = 1;
  pageSize.value = next;
  try { localStorage.setItem(pageSizeKey(props.kind), String(next)); } catch { /* 当前选择仍然生效。 */ }
}
function selectOne(id: string, event: Event) {
  if (busy.value || !pageIds.value.includes(id)) return;
  selectedIds.value = (event.target as HTMLInputElement).checked ? [...new Set([...selectedIds.value, id])] : selectedIds.value.filter(value => value !== id);
}
function selectPage(event: Event) {
  if (!busy.value) selectedIds.value = (event.target as HTMLInputElement).checked ? [...pageIds.value] : [];
}
async function changeSelected() {
  if (busy.value) return;
  const visible = new Set(pageIds.value);
  const ids = selectedIds.value.filter(id => visible.has(id));
  if (!ids.length) return;
  const kind = props.kind, removing = tab.value === 'normal';
  changing.value = true; actionError.value = '';
  try {
    if (removing) {
      const message = kind === 'bank'
        ? `将选中的 ${ids.length} 道题移出后续练习。原作答记录、笔记和 AI 解析均保留，可在“已删除”中恢复。`
        : `将选中的 ${ids.length} 条记录移出学习记录列表。累计答题统计不回退，原答案和成绩保留，可在“已删除”中恢复。进行中的考试恢复后仍遵守原截止时间，不会重新计时。`;
      try { await ElMessageBox.confirm(message, kind === 'bank' ? '删除选中题目' : '删除选中记录', {
        confirmButtonText: '确认删除', cancelButtonText: '保留记录', type: 'info',
      }); } catch { return; }
    }
    const operation = kind === 'bank'
      ? removing ? management.removeQuestionRecords : management.restoreQuestionRecords
      : removing ? management.removeSessionRecords : management.restoreSessionRecords;
    if (typeof operation !== 'function') throw new Error('管理功能暂未就绪，请刷新页面后再试。');
    await operation.call(store, ids);
    selectedIds.value = selectedIds.value.filter(id => !ids.includes(id));
    ElMessage.success(`已${removing ? '删除' : '恢复'} ${ids.length} ${kind === 'bank' ? '道题目' : '条记录'}`);
  } catch (failure: any) {
    actionError.value = failure?.status === 409
      ? `已同步最新状态，请核对后重新选择。${failure.message || '记录已在其他页面发生变化。'}`
      : failure?.message || '操作未完成，选中记录仍保留，请重试。';
    ElMessage.error(actionError.value);
  } finally { changing.value = false; }
}
function referenceUrls(question: StudyQuestion) {
  return [...new Set(question.referenceUrls || [])].filter(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
  });
}
const questionById = (id: string) => (store.questions || []).find(question => question.id === id);
const answerText = (answer?: string[]) => answer?.length ? answer.join('、') : '未作答';
const submitted = (session: StudySession, id: string) => (session.submittedQuestionIds || []).includes(id);
const historicalResult = (session: StudySession, id: string) => {
  const question = questionById(id);
  return question ? studyGradingResult(question, session) : null;
};
</script>

<template>
  <section class="management" :aria-label="isBank ? '题库管理' : '答题记录管理'" :aria-busy="busy">
    <header class="management-heading">
      <div><p class="eyebrow">{{ isBank ? 'QUESTION LIBRARY' : 'STUDY RECORDS' }}</p><h1>{{ isBank ? '把题库，看得清清楚楚。' : '每一次作答，都有记录。' }}</h1>
        <p>{{ isBank ? '浏览完整题目、核对答案与解析，发现错误可以直接纠正。' : '继续未完成的练习，或回看已经提交的答案与成绩。' }}</p></div>
      <button v-if="isBank && tab === 'normal'" class="manage-button primary" :disabled="busy" @click="emit('practice')">开始练习 →</button>
    </header>
    <div class="management-panel">
      <div class="management-tabs" role="group" aria-label="记录状态">
        <button class="tab" :class="{ active: tab === 'normal' }" :aria-pressed="tab === 'normal'" :disabled="busy" @click="setTab('normal')">{{ isBank ? '正常题目' : '正常记录' }} <span>{{ normalCount }}</span></button>
        <button class="tab" :class="{ active: tab === 'removed' }" :aria-pressed="tab === 'removed'" :disabled="busy" @click="setTab('removed')">已删除 <span>{{ removedCount }}</span></button>
      </div>
      <div class="management-filters">
        <label class="search-label"><span>搜索</span><input :value="query" :disabled="busy" :aria-label="isBank ? '搜索题库' : '搜索答题记录'" :placeholder="isBank ? '题号、题干、选项、知识点…' : '模式、日期或记录编号…'" @input="query = readValue($event)"></label>
        <template v-if="isBank">
          <label><span>分类</span><select :value="category" :disabled="busy" aria-label="按分类筛选" @change="category = readValue($event)"><option value="all">全部分类</option><option v-for="item in categories" :key="item" :value="item">{{ item }}</option></select></label>
          <label><span>题型</span><select :value="questionType" :disabled="busy" aria-label="按题型筛选" @change="questionType = readValue($event)"><option value="all">全部题型</option><option value="single">单选</option><option value="multiple">多选</option></select></label>
          <label><span>难度</span><select :value="difficulty" :disabled="busy" aria-label="按难度筛选" @change="difficulty = readValue($event)"><option value="all">全部难度</option><option v-for="level in difficulties" :key="level" :value="level">{{ level }}</option></select></label>
        </template>
        <label v-else><span>完成状态</span><select :value="sessionStatus" :disabled="busy" aria-label="按完成状态筛选" @change="sessionStatus = readValue($event)"><option value="all">全部状态</option><option value="active">进行中</option><option value="completed">已完成</option></select></label>
      </div>
      <p v-if="tab === 'removed'" class="management-notice">{{ isBank ? '这里的题目已移出后续练习；旧作答、笔记与解析仍然保留，恢复后可重新练习。' : '这里的记录可预览和恢复。进行中的考试恢复后仍按原截止时间计时，不会重新获得完整时长。' }}</p>
      <div class="selection-toolbar">
        <label class="check-label"><input type="checkbox" aria-label="全选本页" :checked="allSelected" :indeterminate="partialSelected" :disabled="busy || !pageIds.length" @change="selectPage"><span>全选本页</span></label>
        <span class="selected-count" role="status">已选 {{ selectedIds.length }} 条</span>
        <label class="page-size-control"><span>每页</span><select :value="pageSize" :disabled="busy" aria-label="每页条数" @change="changePageSize"><option v-for="size in pageSizes" :key="size" :value="size">{{ size }} 条</option></select></label>
        <button class="manage-button" :disabled="busy || !selectedIds.length" @click="changeSelected">{{ changing ? '正在处理…' : actionLabel }}</button>
      </div>
      <p v-if="actionError" class="management-error" role="alert">{{ actionError }}</p>
      <div v-if="!filteredCount" class="management-empty"><h2>{{ tab === 'removed' ? '这里还没有已删除的记录' : '没有符合条件的记录' }}</h2><p>可以调整搜索或筛选条件，查看其他内容。</p></div>
      <div v-if="isBank" class="management-list">
        <article v-for="question in pageQuestions" :key="question.id" class="management-row" :aria-label="`题目 ${question.id}`">
          <label class="row-check"><input type="checkbox" :aria-label="`选择题目 ${question.id}`" :checked="selectedIds.includes(question.id)" :disabled="busy" @change="selectOne(question.id, $event)"><span class="sr-only">选择此题</span></label>
          <div class="row-content"><div class="row-meta"><code>{{ question.id }}</code><span>{{ question.category }}</span><span class="pill">{{ question.type === 'single' ? '单选' : '多选' }}</span><span>{{ question.difficulty }}</span></div>
            <h2>{{ question.stem }}</h2><p class="knowledge">{{ question.knowledgePoint }}</p>
            <details class="record-details"><summary>展开选项、答案与解析</summary><ol class="question-options"><li v-for="option in question.options" :key="option.id"><b>{{ option.id }}.</b> {{ option.text }}</li></ol><p class="correct-answer"><b>正确答案：</b>{{ answerText(question.answer) }}</p><p class="explanation">{{ question.explanation }}</p><p class="source">{{ question.source }}</p><div class="reference-list"><b>参考来源</b><a v-for="url in referenceUrls(question)" :key="url" :href="url" target="_blank" rel="noopener noreferrer">{{ url }} ↗</a><span v-if="!referenceUrls(question).length">本题暂未提供 HTTPS 参考链接。</span></div></details>
            <p v-if="question.answerRevision" class="answer-revision">答案已纠正 · 版本 {{ question.answerRevision }}<span v-if="question.answerCorrectionNote"> · {{ question.answerCorrectionNote }}</span></p>
          </div><div class="row-actions"><button class="manage-button" :aria-label="`纠正题目 ${question.id} 的答案`" :disabled="busy" @click="editingQuestionId = question.id">纠正答案</button><button class="manage-button row-action" :aria-label="`研究题目 ${question.id}`" :disabled="busy" @click="emit('review', question)">研究这道题 →</button></div>
        </article>
      </div>
      <div v-else class="management-list">
        <article v-for="session in pageSessions" :key="session.id" class="management-row" :aria-label="`答题记录 ${session.id}`">
          <label class="row-check"><input type="checkbox" :aria-label="`选择记录 ${session.id}`" :checked="selectedIds.includes(session.id)" :disabled="busy" @change="selectOne(session.id, $event)"><span class="sr-only">选择此记录</span></label>
          <div class="row-content"><div class="row-meta"><code>{{ session.id }}</code><span>{{ date(session.createdAt) }}</span><span class="pill">{{ session.status === 'active' ? '进行中' : '已完成' }}</span></div>
            <h2>{{ modeNames[session.mode] || session.mode }}</h2><p class="knowledge">{{ session.questionIds.length }} 题 · 已提交 {{ session.submittedQuestionIds?.length || 0 }} 题<span v-if="session.status === 'completed'"> · 成绩 {{ session.score ?? '尚未结算' }}{{ session.score === undefined ? '' : '%' }}</span></p>
            <p v-if="session.status === 'active' && session.deadlineAt" class="deadline">原截止时间：{{ date(session.deadlineAt) }}；恢复记录不会重新计时。</p>
            <details class="record-details"><summary>预览本次题目与作答</summary><ol class="session-questions"><li v-for="(id, index) in session.questionIds" :key="id"><p class="preview-stem"><b>{{ index + 1 }}. {{ id }}</b> {{ questionById(id)?.stem || '题目暂不可用，原作答记录仍保留。' }}</p><ol v-if="questionById(id)" class="question-options"><li v-for="option in questionById(id)!.options" :key="option.id"><b>{{ option.id }}.</b> {{ option.text }}</li></ol><p><b>我的答案：</b>{{ answerText(session.answers?.[id]) }} <span class="submission">{{ submitted(session, id) ? '已提交' : '未提交' }}</span></p><template v-if="questionById(id) && (session.status === 'completed' || submitted(session, id))"><p><b>{{ historicalResult(session, id)?.standardUpdated ? '当时标准答案：' : '正确答案：' }}</b>{{ answerText(historicalResult(session, id)?.answer) }}</p><p v-if="historicalResult(session, id)?.standardUpdated" class="management-notice">标准答案已更新为 {{ answerText(questionById(id)!.answer) }}；本次记录与成绩保留当时判分标准。</p><p class="explanation">{{ historicalResult(session, id)?.explanation }}</p></template></li></ol></details>
          </div><button v-if="!session.removed" class="manage-button row-action" :aria-label="`打开记录 ${session.id}`" :disabled="busy" @click="emit('session', session)">{{ session.status === 'active' ? '继续答题 →' : '查看复盘 →' }}</button>
        </article>
      </div>
      <footer class="management-pagination"><div class="page-summary"><label class="page-size-control"><span>每页</span><select :value="pageSize" :disabled="busy" aria-label="每页条数（底部）" @change="changePageSize"><option v-for="size in pageSizes" :key="size" :value="size">{{ size }} 条</option></select></label><span>· {{ filteredCount ? (currentPage - 1) * pageSize + 1 : 0 }}—{{ Math.min(currentPage * pageSize, filteredCount) }} / {{ filteredCount }} 条</span></div><nav aria-label="管理列表分页"><button class="manage-button" aria-label="上一页" :disabled="busy || currentPage <= 1" @click="turnPage(currentPage - 1)">← 上一页</button><span>第 {{ currentPage }} / {{ pageCount }} 页</span><button class="manage-button" aria-label="下一页" :disabled="busy || currentPage >= pageCount" @click="turnPage(currentPage + 1)">下一页 →</button></nav></footer>
    </div>
    <AnswerCorrectionDialog v-if="editingQuestion" :key="editingQuestion.id" :question="editingQuestion" @close="editingQuestionId = ''" />
  </section>
</template>

<style scoped>
.management{font-family:"Microsoft YaHei","微软雅黑",sans-serif;font-size:17px;line-height:1.85;color:var(--study-text);min-width:0}.management *{box-sizing:border-box}.management button,.management input,.management select{font:inherit}.management-heading{display:flex;justify-content:space-between;align-items:center;gap:24px;margin:8px 0 28px}.eyebrow{font-size:12px;letter-spacing:2px;color:var(--study-text-muted);margin:0 0 8px}.management h1{font:31px/1.6 "SimSun","宋体",serif;margin:0 0 9px;color:#171717}.management-heading p:last-child{color:var(--study-text-secondary);margin:0}.management-panel{border:1px solid #dedede;border-radius:13px;background:#fff;padding:0 26px;min-width:0}.management-tabs{display:flex;gap:24px;border-bottom:1px solid #e3e3e3}.tab{border:0;border-bottom:3px solid transparent;background:none;padding:20px 0 17px;color:var(--study-text-muted);cursor:pointer}.tab.active{border-color:#222;color:#111;font-weight:650}.tab span{font-size:14px;background:#eee;border-radius:12px;padding:2px 8px;margin-left:8px}.management-filters{display:grid;grid-template-columns:minmax(230px,2fr) repeat(3,minmax(110px,1fr));gap:17px;padding:22px 0}.management-filters label{display:flex;flex-direction:column;gap:7px;color:var(--study-text-secondary);font-size:15px;min-width:0}.management-filters input,.management-filters select{border:1px solid var(--study-control-border);border-radius:7px;padding:10px 12px;background:#fff;color:var(--study-text);min-width:0;width:100%;font-size:16px}.selection-toolbar{display:flex;align-items:center;gap:20px;padding:16px 0;border-top:1px solid #e9e9e9;border-bottom:1px solid #e4e4e4;flex-wrap:wrap}.check-label{display:flex;align-items:center;gap:11px;cursor:pointer}.management input[type=checkbox]{width:20px;height:20px;accent-color:#222;cursor:pointer;flex-shrink:0;margin:0}.selected-count{color:var(--study-text-secondary);font-size:16px}.selection-toolbar>.manage-button{margin-left:auto}.manage-button{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--study-control-border);background:#fff;color:var(--study-text);border-radius:7px;padding:9px 15px;min-height:43px;cursor:pointer;white-space:nowrap;font-size:16px;line-height:1.5;transition:transform .15s,background .15s,box-shadow .15s}.manage-button.primary{background:#171717;color:#fff;border-color:#171717}.manage-button:hover:not(:disabled){background:#eee;transform:translateY(-1px);box-shadow:0 3px 7px #00000012}.manage-button.primary:hover:not(:disabled){background:#000}.management button:disabled,.management input:disabled,.management select:disabled{opacity:1;cursor:not-allowed;color:#555;background:#e8e8e8;border-color:#a5a5a5}.management input:disabled,.management select:disabled{-webkit-text-fill-color:#555}.management input::placeholder{color:#555;opacity:1}.management button:focus-visible,.management input:focus-visible,.management select:focus-visible,.management summary:focus-visible{outline:2px solid #222;outline-offset:3px}.management-notice{background:#f4f4f4;border-radius:7px;padding:13px 16px;color:var(--study-text-secondary);font-size:16px;margin:0 0 18px}.management-error{padding:13px 16px;border:1px dashed #777;background:#f5f5f5;border-radius:7px;color:var(--study-text);overflow-wrap:anywhere}.management-row{display:flex;align-items:flex-start;gap:18px;padding:25px 0;border-bottom:1px solid #e5e5e5;min-width:0}.management-row:last-child{border-bottom:0}.row-check{padding-top:6px;display:flex;cursor:pointer}.row-content{min-width:0;flex:1}.row-meta{display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:14px;color:var(--study-text-secondary);margin-bottom:10px}.row-meta code{font-family:inherit;font-size:14px;color:var(--study-text);overflow-wrap:anywhere}.pill{background:#f0f0f0;border-radius:5px;padding:1px 8px}.row-content h2{font-size:19px;font-weight:600;line-height:1.9;margin:0 0 8px;color:var(--study-text)}.knowledge{color:var(--study-text-muted);font-size:16px;margin:0 0 12px}.row-action{margin-top:2px;flex-shrink:0}.record-details summary{font-size:16px;color:var(--study-text);cursor:pointer;padding:3px 0;width:fit-content;border-bottom:1px solid transparent}.record-details summary:hover{color:#111;border-color:#777}.record-details[open]{padding-bottom:8px}.record-details[open] summary{margin-bottom:15px}.question-options{list-style:none;margin:10px 0 15px;padding:0;display:grid;gap:8px}.question-options li{padding:9px 12px;border:1px solid #a5a5a5;border-radius:6px;overflow-wrap:anywhere}.question-options b{margin-right:6px}.correct-answer{margin:13px 0}.explanation{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.95;margin:12px 0;color:var(--study-text)}.source{font-size:14px;color:var(--study-text-muted);margin:16px 0 8px}.reference-list{display:flex;flex-direction:column;gap:6px;font-size:14px;color:var(--study-text-muted)}.reference-list b{font-weight:500}.reference-list a{color:var(--study-text);overflow-wrap:anywhere;width:fit-content;text-decoration:underline;text-underline-offset:3px}.reference-list a:hover{color:#000;background:#eee}.session-questions{padding:0;list-style:none}.session-questions>li{border-top:1px solid #e7e7e7;padding:16px 0}.preview-stem{font-size:17px;margin:0 0 12px}.preview-stem>b{font-size:15px;margin-right:8px}.submission{font-size:14px;color:var(--study-text-muted);margin-left:12px}.deadline{color:var(--study-text-secondary);font-size:15px;margin:8px 0 14px}.management-empty{text-align:center;padding:45px 20px;color:var(--study-text-muted)}.management-empty h2{font-size:20px;color:var(--study-text-secondary);margin:0 0 9px}.management-empty p{font-size:16px;margin:0}.management-pagination{display:flex;justify-content:space-between;align-items:center;gap:18px;border-top:1px solid #e4e4e4;padding:22px 0;color:var(--study-text-secondary);font-size:15px;flex-wrap:wrap}.management-pagination nav{display:flex;align-items:center;gap:15px}.management-pagination .manage-button{font-size:15px;padding:8px 12px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media(max-width:1000px){.management-filters{grid-template-columns:repeat(3,minmax(0,1fr))}.management-filters .search-label{grid-column:1/-1}.management-row{flex-wrap:wrap;gap:13px}.row-content{flex-basis:calc(100% - 40px)}.row-action{margin-left:38px}.management-heading{align-items:flex-start}.management h1{font-size:28px}}
@media(max-width:640px){.management-heading{flex-direction:column;gap:17px}.management h1{font-size:25px}.management-panel{padding:0 17px}.management-tabs{gap:20px}.management-filters{grid-template-columns:1fr 1fr;gap:13px}.management-filters .search-label{grid-column:1/-1}.management-filters label{font-size:14px}.selection-toolbar{gap:13px}.selection-toolbar>.manage-button{margin-left:0}.management-row{padding:22px 0}.row-meta{gap:8px}.row-content h2{font-size:18px}.management-pagination nav{width:100%;justify-content:space-between;gap:8px}.management-pagination .manage-button{padding:8px 10px}.management-pagination{font-size:14px}.management-notice{font-size:15px}}
@media(prefers-reduced-motion:reduce){.management .manage-button{transition:none}.management .manage-button:hover:not(:disabled){transform:none}}
.page-size-control{display:flex;flex-direction:row;align-items:center;gap:8px;color:var(--study-text-secondary);font-size:15px;white-space:nowrap}.page-size-control select{width:auto;min-width:98px;padding:8px 10px;border:1px solid var(--study-control-border);border-radius:7px;color:var(--study-text);background:#fff;font-size:16px;line-height:1.5;cursor:pointer;transition:border-color .15s,box-shadow .15s}.page-size-control select:hover:not(:disabled){border-color:#171717}.page-size-control select:disabled{cursor:not-allowed}.page-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.selection-toolbar .page-size-control{margin-left:auto}.selection-toolbar>.manage-button{margin-left:0}@media(max-width:640px){.selection-toolbar .page-size-control{margin-left:0}.page-summary{width:100%}}
.row-actions{display:flex;flex-direction:column;gap:10px;flex-shrink:0}.row-actions .row-action{margin:0}.answer-revision{color:#333;font-size:15px;margin:12px 0 0;overflow-wrap:anywhere}@media(max-width:1000px){.row-actions{margin-left:38px;flex-direction:row;flex-wrap:wrap}}
</style>
