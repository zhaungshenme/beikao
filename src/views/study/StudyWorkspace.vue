<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useStudyStore, emptyProgress } from '@/store/modules/study';
import StudyManagement from './StudyManagement.vue';
import PreparedExplanation from './components/PreparedExplanation.vue';
import { studyGradingResult } from '@/utils/studyGrading';
import * as api from '@/api/study';
import type { AiHistoryEntry, AiSource, RetrievalArchiveEntry, RetrievalSource, StudyMode, StudyQuestion, StudySession } from '@/api/study/types';

type Page = 'home' | 'practice' | 'bank' | 'answer' | 'wrong' | 'favorites' | 'history' | 'settings';
const store = useStudyStore();
const sidebarStorageKey = 'yankao-sidebar-width';
const sidebarDefaultWidth = 224;
const sidebarMinWidth = 180;
const preferredSidebarWidth = ref(sidebarDefaultWidth);
const viewportWidth = ref(window.innerWidth);
const desktopSidebar = computed(() => viewportWidth.value > 640);
const sidebarMaxWidth = computed(() => Math.min(360, Math.max(sidebarMinWidth, viewportWidth.value - 320)));
const sidebarWidth = computed(() => Math.max(sidebarMinWidth, Math.min(preferredSidebarWidth.value, sidebarMaxWidth.value)));
const resizingSidebar = ref(false);
let sidebarDrag: { id: number; x: number; width: number; target: HTMLElement } | null = null;
const page = ref<Page>('home');
const previousPage = ref<Page>('home');
const reviewId = ref('');
const displayedSessionId = ref('');
const search = ref('');
const wrongFilter = ref('pending');
const selectedWrongIds = ref<string[]>([]);
const wrongBatchBusy = ref(false);
const wrongActionError = ref('');
const wrongActionBusy = computed(() => wrongBatchBusy.value || store.busy);
const filter = reactive({ category: 'all', chapter: 'all', type: 'all', difficulty: 'all', mode: 'sequential' as StudyMode, count: 20, minutes: 30 });
const questionCountValid = computed(() => Number.isInteger(filter.count) && filter.count >= 1 && filter.count <= 500);
const aiPanel = ref<HTMLElement | null>(null);
const clock = ref(Date.now());
const apiBusy = ref(false);
const apiTask = ref<'retrieve' | 'read' | null>(null);
const apiSaving = ref(false);
const apiError = ref<{ questionId: string; message: string; unconfirmed?: boolean } | null>(null);
const retrievalOpen = ref(false);
const retrievalLoading = ref(false);
const retrievalError = ref('');
const retrievedEntries = reactive<Record<string, RetrievalArchiveEntry[]>>({});
const uncertainRetrievalIds = reactive(new Set<string>());
let retrievalReadRequest = 0;
const aiBusy = computed(() => apiBusy.value || apiSaving.value);
const aiDraft = reactive({ apiKey: '' });
const importInput = ref<HTMLInputElement | null>(null);
let timer: ReturnType<typeof setInterval>;
let disposed = false;
let autoFinishedId = '';
const apiUi = computed(() => ({ state: store.ai.configured ? 'ready' : 'offline', symbol: store.ai.configured ? '●' : '○', label: store.ai.configured ? '检索已配置' : '检索未配置', detail: '固定使用 DeepSeek 官方 Search／Fetch，只有主动检索时才访问网页资料，不调用生成模型。' }));

function rememberSidebarWidth() {
  try { localStorage.setItem(sidebarStorageKey, String(preferredSidebarWidth.value)); } catch { /* 浏览器禁用存储时，当前页面仍可调整。 */ }
}
function setSidebarWidth(width: number, persist = false) {
  preferredSidebarWidth.value = Math.round(Math.max(sidebarMinWidth, Math.min(width, sidebarMaxWidth.value)));
  if (persist) rememberSidebarWidth();
}
function stopSidebarResize(event?: PointerEvent) {
  if (!sidebarDrag || (event && event.pointerId !== sidebarDrag.id)) return;
  const drag = sidebarDrag;
  sidebarDrag = null;
  resizingSidebar.value = false;
  if (drag.target.hasPointerCapture(drag.id)) drag.target.releasePointerCapture(drag.id);
  rememberSidebarWidth();
}
function beginSidebarResize(event: PointerEvent) {
  if (!desktopSidebar.value || event.button !== 0) return;
  const target = event.currentTarget as HTMLElement;
  event.preventDefault();
  target.focus({ preventScroll: true });
  target.setPointerCapture(event.pointerId);
  sidebarDrag = { id: event.pointerId, x: event.clientX, width: sidebarWidth.value, target };
  resizingSidebar.value = true;
}
function moveSidebarResize(event: PointerEvent) {
  if (sidebarDrag && event.pointerId === sidebarDrag.id) setSidebarWidth(sidebarDrag.width + event.clientX - sidebarDrag.x);
}
function resetSidebarWidth() { preferredSidebarWidth.value = sidebarDefaultWidth; rememberSidebarWidth(); }
function resizeSidebarByKey(event: KeyboardEvent) {
  if (!desktopSidebar.value || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const step = event.shiftKey ? 20 : 8;
  const width = event.key === 'Home' ? sidebarMinWidth : event.key === 'End' ? sidebarMaxWidth.value : sidebarWidth.value + (event.key === 'ArrowLeft' ? -step : step);
  setSidebarWidth(width, true);
}
function updateViewportWidth() {
  viewportWidth.value = window.innerWidth;
  if (!desktopSidebar.value) stopSidebarResize();
}
const nav = [
  { id: 'home', icon: '◈', label: '学习概览' }, { id: 'practice', icon: '▤', label: '题库练习' },
  { id: 'bank', icon: '▦', label: '题库管理' },
  { id: 'wrong', icon: '↻', label: '错题研究' }, { id: 'favorites', icon: '☆', label: '我的收藏' },
  { id: 'history', icon: '◷', label: '学习记录' }, { id: 'settings', icon: '⚙', label: '学习设置' },
] as const;
const titles: Record<Page, string> = { home: '学习概览', practice: '题库练习', bank: '题库管理', answer: '专注答题', wrong: '错题研究', favorites: '我的收藏', history: '学习记录', settings: '学习设置' };
const modeNames: Record<StudyMode, string> = { sequential: '顺序练习', random: '随机练习', exam: '模拟考试', wrong: '错题重练', favorites: '收藏练习' };
const availableBank = computed(() => store.questions.filter(q => !store.questionRecords?.[q.id]?.removed));
const availableCategories = computed(() => [...new Set(availableBank.value.map(q => q.category))]);
const availableDifficulties = computed(() => [...new Set(availableBank.value.map(q => q.difficulty))]);
const availableAnsweredCount = computed(() => availableBank.value.filter(q => (store.progress[q.id]?.attempts || 0) > 0).length);
const visibleSessions = computed(() => store.sessions.filter(s => !s.removed));
const pendingWrong = computed(() => store.wrongQuestions.filter(q => !store.progress[q.id]?.mastered));
const masteredWrong = computed(() => store.wrongQuestions.filter(q => store.progress[q.id]?.mastered));
const completed = computed(() => visibleSessions.value.filter(s => s.status === 'completed'));
const chapters = computed(() => [...new Set(availableBank.value.filter(q => filter.category === 'all' || q.category === filter.category).map(q => q.chapter))]);
const filtered = computed(() => availableBank.value.filter(q =>
  (filter.category === 'all' || q.category === filter.category) && (filter.chapter === 'all' || q.chapter === filter.chapter) &&
  (filter.type === 'all' || q.type === filter.type) && (filter.difficulty === 'all' || q.difficulty === filter.difficulty)));
const collection = computed(() => (page.value === 'favorites' ? store.favoriteQuestions : wrongFilter.value === 'removed' ? store.removedWrongQuestions : store.wrongQuestions).filter(q =>
  (page.value !== 'wrong' || ['all', 'removed'].includes(wrongFilter.value) || (wrongFilter.value === 'mastered' ? store.progress[q.id]?.mastered : !store.progress[q.id]?.mastered)) &&
  (!search.value || `${q.stem} ${q.category} ${q.knowledgePoint}`.toLowerCase().includes(search.value.toLowerCase()))));
const practiceCollection = computed(() => page.value === 'wrong' ? wrongFilter.value === 'removed' ? [] : collection.value.filter(q => !store.progress[q.id]?.mastered) : collection.value);
const wrongSelectedCount = computed(() => selectedWrongIds.value.length);
const allWrongSelected = computed(() => collection.value.length > 0 && wrongSelectedCount.value === collection.value.length);
const selectedPendingWrongIds = computed(() => collection.value.filter(q => selectedWrongIds.value.includes(q.id) && !store.progress[q.id]?.mastered).map(q => q.id));
const selectedMasteredWrongIds = computed(() => collection.value.filter(q => selectedWrongIds.value.includes(q.id) && store.progress[q.id]?.mastered).map(q => q.id));
watch([page, wrongFilter, search], () => { selectedWrongIds.value = []; wrongActionError.value = ''; }, { flush: 'sync' });
watch(collection, items => {
  const visible = new Set(items.map(q => q.id));
  selectedWrongIds.value = selectedWrongIds.value.filter(id => visible.has(id));
});
// Keep the opened record as the display target when store selection changes after deletion.
const session = computed(() => store.currentSession?.id === displayedSessionId.value ? store.currentSession : null);
const question = computed(() => reviewId.value ? store.questionMap[reviewId.value]
  : session.value ? store.questionMap[session.value.questionIds[session.value.cursor || 0]] : undefined);
const progress = computed(() => question.value ? store.progress[question.value.id] || emptyProgress() : emptyProgress());
type NoteDraft = { note: string; reason: string; baseNote: string; baseReason: string; pending?: { note?: string; reason?: string }; revision?: number; error?: string };
type TextVersion = { id: string; field: 'note' | 'reason' | 'aiNote'; text: string; createdAt: string; source: string };
const draftKey = 'yankao-note-drafts-v1';
const drafts = reactive<Record<string, NoteDraft>>({});
const draftStorageError = ref('');
try {
  const raw = sessionStorage.getItem(draftKey);
  if (raw) {
    const saved = JSON.parse(raw);
    for (const [id, value] of Object.entries(saved)) {
      const item = value as NoteDraft;
      if (item && ['note', 'reason', 'baseNote', 'baseReason'].every(key => typeof item[key as keyof NoteDraft] === 'string') &&
        item.note.length <= 10000 && item.baseNote.length <= 10000 && item.reason.length <= 100 && item.baseReason.length <= 100) {
        drafts[id] = { note: item.note, reason: item.reason, baseNote: item.baseNote, baseReason: item.baseReason };
        if (item.pending && typeof item.pending === 'object' && !Array.isArray(item.pending) &&
          Object.keys(item.pending).every(key => ['note', 'reason'].includes(key)) &&
          Object.entries(item.pending).every(([key, text]) => typeof text === 'string' && text.length <= (key === 'note' ? 10000 : 100))) {
          drafts[id].pending = { ...item.pending };
          drafts[id].error = '上次保存结果尚未确认，草稿已保留；请核对当前已保存内容。';
        }
      }
    }
  }
} catch { draftStorageError.value = '暂未能读取本页草稿，请先检查已保存内容。'; }
const currentDraft = computed(() => question.value ? drafts[question.value.id] : undefined);
function editDraft(field: 'note' | 'reason', value: string) {
  const draft = currentDraft.value;
  if (draft) { draft[field] = value; draft.revision = (draft.revision || 0) + 1; }
}
const note = computed({ get: () => currentDraft.value?.note || '', set: value => editDraft('note', value) });
const reason = computed({ get: () => currentDraft.value?.reason || '', set: value => editDraft('reason', value) });
const noteDirty = computed(() => !!currentDraft.value && (!!currentDraft.value.pending || note.value !== currentDraft.value.baseNote || reason.value !== currentDraft.value.baseReason));
const noteConflict = computed(() => {
  const draft = currentDraft.value;
  return !!draft && (!!draft.pending || (draft.note !== draft.baseNote && progress.value.note !== draft.baseNote) ||
    (draft.reason !== draft.baseReason && progress.value.reason !== draft.baseReason));
});
const noteSavingIds = reactive(new Set<string>());
const noteSaving = computed(() => !!question.value && noteSavingIds.has(question.value.id));
const historyOpen = ref(false);
const historyLoading = ref(false);
const historyError = ref('');
const historyEntries = ref<TextVersion[]>([]);
let historyRequest = 0;
const versionNames = { note: '学习笔记', reason: '错因', aiNote: 'AI 解析' };
const aiHistoryOpen = ref(false);
const aiHistoryLoading = ref(false);
const aiHistoryError = ref('');
const aiHistoryEntries = ref<AiHistoryEntry[]>([]);
let aiHistoryRequest = 0;
function reconcileNoteDraft(id: string | undefined, savedNote = '', savedReason = '') {
  if (!id || noteSavingIds.has(id)) return;
  const draft = drafts[id];
  if (!draft) drafts[id] = { note: savedNote || '', reason: savedReason || '', baseNote: savedNote || '', baseReason: savedReason || '' };
  else {
    for (const [field, base, saved] of [['note', 'baseNote', savedNote], ['reason', 'baseReason', savedReason]] as const) {
      if (draft.pending && Object.hasOwn(draft.pending, field)) {
        // A refreshed page may confirm the transmitted payload, never later local edits.
        if (saved === draft.pending[field]) { draft[base] = saved; delete draft.pending[field]; }
      } else if (draft[field] === draft[base]) draft[field] = draft[base] = saved;
    }
    if (draft.pending && !Object.keys(draft.pending).length) { delete draft.pending; draft.error = ''; }
  }
}
watch(drafts, () => {
  try {
    const dirty = Object.fromEntries(Object.entries(drafts).filter(([, draft]) => draft.pending || draft.note !== draft.baseNote || draft.reason !== draft.baseReason));
    sessionStorage.setItem(draftKey, JSON.stringify(dirty));
    draftStorageError.value = '';
  } catch { draftStorageError.value = '浏览器未能暂存草稿，刷新或关闭前请先复制。'; }
}, { deep: true, flush: 'sync' });
watch(() => [question.value?.id, progress.value.note, progress.value.reason] as const, ([id, savedNote, savedReason]) => reconcileNoteDraft(id, savedNote, savedReason), { immediate: true });
const currentRetrievedEntries = computed(() => question.value ? retrievedEntries[question.value.id] ?? [] : []);
function safeAiSources(sources: AiSource[] = []) {
  return sources.flatMap(source => {
    try {
      const url = new URL(source.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
      return [{ id: source.id, title: source.title || url.hostname, url: url.href }];
    } catch { return []; }
  });
}
function retrievalSourceUrl(source: RetrievalSource) {
  return safeAiSources([{ ...source, url: source.originalUrl || source.url }])[0]?.url || safeAiSources([source])[0]?.url;
}
function retrievalSourceDescription(source: RetrievalSource) {
  if (source.sourceKind === 'document-extract' && source.documentType === 'pdf') {
    return `Search 返回的 PDF 文字摘录${source.fetchSkipped ? '；未调用 Fetch' : ''}；非 PDF 全文或已核验解析`;
  }
  return source.contentOrigin === 'search' ? 'Search 返回的网页正文' : source.contentOrigin === 'fetch' ? 'Fetch 抓取的网页正文' : '网页正文（旧记录未标注获取方式）';
}
function locallyRecoveredSources(entry: RetrievalArchiveEntry) {
  const recovery = entry.localRecovery;
  if (entry.status !== 'failed' || recovery?.kind !== 'saved-search-text' || recovery.parentArchiveId !== entry.id ||
    recovery.networkRequested !== false || recovery.modelRequested !== false) return [];
  return recovery.sources.filter(source => !entry.sources.some(saved => saved.url === source.url)).slice(0, Math.max(0, 2 - entry.sources.length));
}
const aiActionLabel = computed(() => apiSaving.value ? '正在保存配置…' : apiBusy.value ? apiTask.value === 'read' ? '正在读取检索记录…' : '正在检索网页…' : question.value && uncertainRetrievalIds.has(question.value.id) ? '读取检索记录' : currentRetrievedEntries.value.some(entry => entry.currentFingerprintMatch) ? '查看已保存网页资料' : store.ai.configured ? '检索网页并保存' : '配置网页检索');
const answer = computed(() => question.value ? (reviewId.value ? progress.value.lastAnswer : session.value?.answers[question.value.id] || []) : []);
const revealed = computed(() => !!reviewId.value || session.value?.status === 'completed' || !!(question.value && session.value?.submittedQuestionIds.includes(question.value.id)));
const grading = computed(() => question.value ? studyGradingResult(question.value, reviewId.value ? null : session.value, answer.value) : undefined);
function wasIncorrect(id: string) {
  const q = store.questionMap[id];
  return !!q && !!session.value && !studyGradingResult(q, session.value).correct;
}
const examActive = computed(() => !reviewId.value && session.value?.mode === 'exam' && session.value.status === 'active');
const remaining = computed(() => session.value?.deadlineAt ? Math.max(0, Math.ceil((Date.parse(session.value.deadlineAt) - clock.value) / 1000)) : 0);
const timeText = computed(() => `${Math.floor(remaining.value / 60).toString().padStart(2, '0')}:${(remaining.value % 60).toString().padStart(2, '0')}`);
const selectedCount = computed(() => session.value ? session.value.questionIds.filter(id => session.value!.answers[id]?.length).length : 0);
const date = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const categoryInfo = computed(() => availableCategories.value.map(name => {
  const qs = availableBank.value.filter(q => q.category === name);
  return { name, chapters: [...new Set(qs.map(q => q.chapter))].slice(0, 3).join(' · '), index: store.categories.indexOf(name) + 1, count: qs.length, done: qs.filter(q => store.progress[q.id]?.attempts).length, wrong: qs.filter(q => (store.progress[q.id]?.wrongCount || 0) > 0 && !store.progress[q.id]?.wrongRemoved && !store.progress[q.id]?.mastered).length };
}));
const bankSingleCount = computed(() => availableBank.value.filter(q => q.type === 'single').length);
const questionReferences = computed(() => (question.value?.referenceUrls || []).filter(url => {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password; } catch { return false; }
}));
const referenceName = (url: string) => new URL(url).hostname;
async function safe(action: () => unknown | Promise<unknown>) { try { return await action(); } catch (e: any) { ElMessage.error(e.message || '操作未完成，请重试'); } }
function go(next: Page) { page.value = next; search.value = ''; }
function configure(category = 'all', mode: StudyMode = 'sequential') { Object.assign(filter, { category, chapter: 'all', mode }); go('practice'); }
async function start(mode = filter.mode, ids?: string[]) {
  if (!questionCountValid.value) { ElMessage.error('每次请选择 1—500 道题，可分多次完成题库。'); return; }
  await safe(async () => {
    const s = await store.startSession({ ...filter, mode, ...(ids ? { questionIds: ids, category: 'all', chapter: 'all', type: 'all', difficulty: 'all' } : {}) });
    if (s) { clock.value = Date.now(); displayedSessionId.value = s.id; reviewId.value = ''; previousPage.value = 'practice'; page.value = 'answer'; }
  });
}
function resume(s?: StudySession) { void safe(() => { if (s) store.resumeSession(s); else store.resume(); if (!store.activeSession || store.activeSession.removed) throw new Error('该学习记录已删除，请到学习记录中恢复后再继续。'); displayedSessionId.value = store.activeSession.id; reviewId.value = ''; page.value = 'answer'; previousPage.value = 'home'; }); }
function review(q: StudyQuestion) { previousPage.value = page.value; reviewId.value = q.id; page.value = 'answer'; }
function selectWrong(id: string, event: Event) {
  if (wrongActionBusy.value) return;
  const checked = (event.target as HTMLInputElement).checked;
  selectedWrongIds.value = checked ? [...new Set([...selectedWrongIds.value, id])] : selectedWrongIds.value.filter(value => value !== id);
}
function selectAllWrong(event: Event) {
  if (wrongActionBusy.value) return;
  selectedWrongIds.value = (event.target as HTMLInputElement).checked ? collection.value.map(q => q.id) : [];
}
async function changeSelectedWrong() {
  if (wrongActionBusy.value || !selectedWrongIds.value.length || page.value !== 'wrong') return;
  const ids = [...selectedWrongIds.value];
  const removing = wrongFilter.value !== 'removed';
  wrongBatchBusy.value = true; wrongActionError.value = '';
  try {
    if (removing) {
      try {
        await ElMessageBox.confirm(`将选中的 ${ids.length} 条记录移出错题本。原作答记录、笔记和 AI 解析均保留，可在“已删除”中恢复；再次答错会自动重新加入。`, '删除选中记录', { confirmButtonText: '确认删除', cancelButtonText: '保留记录', type: 'info' });
      } catch { return; }
      await store.removeWrongRecords(ids);
    } else await store.restoreWrongRecords(ids);
    selectedWrongIds.value = selectedWrongIds.value.filter(id => !ids.includes(id));
    ElMessage.success(removing ? `已删除 ${ids.length} 条错题记录，可在“已删除”中恢复` : `已恢复 ${ids.length} 条错题记录`);
  } catch (failure: any) {
    wrongActionError.value = failure.message || '操作未完成，选中记录仍保留，请重试';
    ElMessage.error(wrongActionError.value);
  } finally { wrongBatchBusy.value = false; }
}
async function changeWrongMastery(ids: string[], mastered: boolean) {
  if (wrongActionBusy.value || !ids.length) return;
  wrongBatchBusy.value = true; wrongActionError.value = '';
  try {
    const result = await (mastered ? store.markWrongMastered(ids) : store.markWrongPending(ids));
    selectedWrongIds.value = [];
    const count = result.changedCount;
    ElMessage.success(mastered ? `已将 ${count} 道错题标记为已掌握，可在“已掌握”中查看` : `已将 ${count} 道错题放回待巩固`);
  } catch (failure: any) {
    wrongActionError.value = failure.status === 409
      ? `错题状态已有变化，本次未覆盖。请核对最新状态后重试。${failure.message || ''}`
      : failure.message || '掌握状态保存失败，原状态保留，请重试。';
    ElMessage.error(wrongActionError.value);
  } finally { wrongBatchBusy.value = false; }
}
async function toggleWrongMastery(id: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const mastered = input.checked;
  // Native checkboxes change before the network save. Show only confirmed state,
  // including on failure, rather than leaving a misleading successful checkmark.
  input.checked = !!store.progress[id]?.mastered;
  if (wrongActionBusy.value || page.value !== 'wrong' || wrongFilter.value === 'removed' || !collection.value.some(q => q.id === id)) return;
  await changeWrongMastery([id], mastered);
  input.checked = !!store.progress[id]?.mastered;
}
function markSelectedWrong(mastered: boolean) {
  if (page.value !== 'wrong' || wrongFilter.value === 'removed') return;
  return changeWrongMastery(mastered ? [...selectedPendingWrongIds.value] : [...selectedMasteredWrongIds.value], mastered);
}
async function toggleQuestionMastery() {
  const q = question.value;
  if (!q || wrongActionBusy.value || progress.value.wrongRemoved || store.questionRecords?.[q.id]?.removed) return;
  const mastered = !progress.value.mastered;
  if (progress.value.wrongCount > 0) await changeWrongMastery([q.id], mastered);
  else await patch({ mastered });
}
function history(s: StudySession) { if (s.removed) return; if (s.status === 'active') { resume(s); previousPage.value = 'history'; return; } void safe(() => { store.viewHistory(s); displayedSessionId.value = s.id; reviewId.value = ''; previousPage.value = 'history'; page.value = 'answer'; }); }
function select(id: string) {
  if (!question.value || revealed.value || !session.value || store.busy) return;
  const chosen = question.value.type === 'single' ? [id] : answer.value.includes(id) ? answer.value.filter(v => v !== id) : [...answer.value, id];
  void safe(() => store.persistAnswer(question.value!.id, chosen));
}
async function finish(auto = false) {
  if (!store.activeSession || store.busy) return;
  if (!auto) {
    try { await ElMessageBox.confirm(`已作答 ${selectedCount.value} / ${session.value?.questionIds.length} 题。交卷后将统一判分，未答题按错误计入。`, '结束本次答题', { confirmButtonText: '确认交卷', cancelButtonText: '继续作答', type: 'info' }); } catch { return; }
  }
  await safe(async () => { await store.finish(); ElMessage.success(auto ? '考试时间到，已自动交卷' : '已交卷，学习记录已保存'); });
}
async function patch(data: any) { if (question.value) await safe(() => store.patchProgress(question.value!.id, data)); }
async function saveNotes() {
  const id = question.value?.id;
  const draft = currentDraft.value;
  if (!id || !draft || noteSavingIds.has(id)) return;
  if (draft.pending) {
    try {
      await store.refreshProgress();
      reconcileNoteDraft(id, store.progress[id]?.note || '', store.progress[id]?.reason || '');
    } catch (failure: any) { draft.error = failure.message || '尚未能确认上次保存结果，草稿已保留。'; ElMessage.error(draft.error); return; }
    if (drafts[id] !== draft || noteSavingIds.has(id)) return;
    if (draft.pending) { draft.error = '上次保存结果尚未确认，已暂停再次写入。请先复制草稿并核对当前已保存版本。'; ElMessage.error(draft.error); return; }
  }
  const changes: { note?: string; reason?: string } = {};
  const expected: { note?: string; reason?: string } = {};
  if (draft.note !== draft.baseNote) { changes.note = draft.note; expected.note = draft.baseNote; }
  if (draft.reason !== draft.baseReason) { changes.reason = draft.reason; expected.reason = draft.baseReason; }
  if (!Object.keys(changes).length) { ElMessage.info('当前笔记没有未保存的修改'); return; }
  noteSavingIds.add(id);
  draft.pending = { ...changes };
  draft.error = '';
  try {
    await store.patchProgress(id, changes, expected);
    // Saving confirms this payload only. Edits made while it was travelling remain dirty.
    if (changes.note !== undefined) draft.baseNote = changes.note;
    if (changes.reason !== undefined) draft.baseReason = changes.reason;
    delete draft.pending;
    const dirty = draft.note !== draft.baseNote || draft.reason !== draft.baseReason;
    ElMessage.success(dirty ? '本次内容已保存，新增修改仍未保存' : '笔记已保存');
  } catch (failure: any) {
    draft.error = failure.status === 409 ? '其他页面已修改这份内容，本次没有覆盖；你的草稿仍保留。' : failure.message || '笔记暂未保存，草稿已保留。';
    if (failure.status === 409) { try { await store.refreshProgress(); } catch {} }
    ElMessage.error(draft.error);
  } finally { noteSavingIds.delete(id); reconcileNoteDraft(id, store.progress[id]?.note || '', store.progress[id]?.reason || ''); }
}
async function copyDraft() {
  await safe(async () => { await navigator.clipboard.writeText(`学习笔记：\n${note.value}\n错因：${reason.value}`); ElMessage.success('当前草稿已复制'); });
}
async function adoptSavedNotes() {
  const id = question.value?.id;
  if (!id) return;
  const originalDraft = drafts[id];
  const revision = originalDraft?.revision || 0;
  if (noteDirty.value) {
    try { await ElMessageBox.confirm('这会放弃本题未保存草稿。请先复制需要保留的内容，再载入已保存版本。', '载入已保存版本', { confirmButtonText: '确认载入', cancelButtonText: '保留草稿' }); } catch { return; }
  }
  await safe(async () => {
    await store.refreshProgress();
    if (drafts[id] !== originalDraft || (originalDraft?.revision || 0) !== revision || noteSavingIds.has(id)) {
      if (drafts[id]) drafts[id].error = '载入期间有新的编辑，已保留草稿；请核对后再决定是否载入。';
      ElMessage.info('载入期间有新的编辑，已保留草稿');
      return;
    }
    const saved = store.progress[id] || emptyProgress();
    drafts[id] = { note: saved.note || '', reason: saved.reason || '', baseNote: saved.note || '', baseReason: saved.reason || '' };
  });
}
async function loadTextHistory() {
  const id = question.value?.id;
  if (!id) return;
  const request = ++historyRequest;
  historyOpen.value = true; historyLoading.value = true; historyError.value = '';
  try {
    const result = await api.loadQuestionHistory(id);
    if (request === historyRequest && question.value?.id === id) historyEntries.value = result.entries;
  } catch (failure: any) { if (request === historyRequest) historyError.value = failure.message || '历史暂未载入'; }
  finally { if (request === historyRequest) historyLoading.value = false; }
}
async function loadAiHistory(id = question.value?.id, open = true) {
  if (!id || question.value?.id !== id || (!open && !aiHistoryOpen.value)) return;
  const request = ++aiHistoryRequest;
  if (open) aiHistoryOpen.value = true;
  aiHistoryLoading.value = true; aiHistoryError.value = '';
  try {
    const result = await api.loadAiHistory(id);
    if (request === aiHistoryRequest && question.value?.id === id && aiHistoryOpen.value) aiHistoryEntries.value = result.entries;
  } catch (failure: any) {
    if (request === aiHistoryRequest && question.value?.id === id && aiHistoryOpen.value) aiHistoryError.value = failure.message || 'AI 解析历史暂未载入';
  } finally {
    if (request === aiHistoryRequest) aiHistoryLoading.value = false;
  }
}
async function toggleAiHistory() {
  if (!aiHistoryOpen.value) { await loadAiHistory(); return; }
  aiHistoryRequest++;
  aiHistoryOpen.value = false;
  aiHistoryLoading.value = false;
}
function refreshOpenAiHistory(id?: string) {
  // Saving or rereading a response must not reopen a history panel that the
  // learner closed or replace a different question's pending history request.
  // History has its own loading/error state; it must not extend API busy time.
  if (id && question.value?.id === id && aiHistoryOpen.value) void loadAiHistory(id, false);
}
function aiProviderLabel(entry: AiHistoryEntry) {
  if (entry.transport === 'legacy') return '旧版保存解析';
  if (entry.transport === 'web') return entry.provider === 'zhipu' ? '智谱清言网页' : entry.provider === 'deepseek' ? 'DeepSeek 网页' : `${entry.provider} 网页`;
  return entry.model ? `模型 API · ${entry.model}` : '模型 API';
}
function aiHistoryStatus(entry: AiHistoryEntry) {
  if (entry.status === 'legacy') return '生成信息未记录';
  return entry.status === 'conflict' ? '冲突时保留' : '已保存为当时结果';
}
async function restoreTextVersion(entry: TextVersion) {
  const id = question.value?.id;
  if (!id) return;
  const expected = store.progress[id]?.[entry.field] || '';
  await safe(async () => {
    await api.restoreQuestionHistory(id, { historyId: entry.id, expected });
    await store.refreshProgress();
    ElMessage.success('已恢复历史版本，恢复前的内容也已保留');
    if (question.value?.id === id) await loadTextHistory();
  });
}
async function reloadSavedAnswers() {
  const id = session.value?.id;
  if (!id) return;
  try { await ElMessageBox.confirm('本页未保存的答案将被已保存答案替换，请先记下需要保留的选择。', '重新载入已保存答案', { confirmButtonText: '确认载入', cancelButtonText: '保留本页选择' }); } catch { return; }
  await safe(() => store.reloadServerSession(id));
}
async function requestExplanation() {
  if (aiBusy.value || !question.value || !revealed.value || examActive.value) return;
  aiPanel.value?.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  aiPanel.value?.focus?.({ preventScroll: true });
  const targetId = question.value.id;
  const expectedQuestionRevision = question.value.answerRevision ?? 0;
  const readOnly = uncertainRetrievalIds.has(targetId);
  apiBusy.value = true;
  apiTask.value = 'read';
  try {
    // Reconcile durable local records before any potentially charged request.
    const existing = await api.loadRetrievalHistory(targetId);
    retrievedEntries[targetId] = existing.entries;
    if (disposed || question.value?.id !== targetId || page.value !== 'answer') return;
    retrievalOpen.value = true;
    apiError.value = null;
    const current = existing.entries.find(entry => entry.currentFingerprintMatch);
    if (current) { reportRetrieval(current, true); return; }
    if (readOnly) {
      apiError.value = { questionId: targetId, unconfirmed: true, message: '上次检索结果仍未确认，仅重读本机记录，未重新调用 Search／Fetch。' };
      return;
    }
    if (!store.ai.configured) { go('settings'); ElMessage.info('请先配置 DeepSeek 官方检索密钥。'); return; }
    apiTask.value = 'retrieve';
    const result = await api.retrieveStudyQuestion({ questionId: targetId, expectedQuestionRevision, requestId: crypto.randomUUID() });
    // Retain each result under its target; navigating never displays it on another question.
    retrievedEntries[targetId] = [result.entry, ...existing.entries.filter(entry => entry.questionFingerprint !== result.entry.questionFingerprint)];
    if (result.entry.status === 'running' || result.entry.status === 'unknown') uncertainRetrievalIds.add(targetId);
    else uncertainRetrievalIds.delete(targetId);
    if (!disposed && question.value?.id === targetId) { retrievalReadRequest++; retrievalLoading.value = false; reportRetrieval(result.entry, result.cached); }
  } catch (failure: any) {
    const unconfirmed = apiTask.value === 'retrieve' && (!failure.status || failure.status >= 500);
    if (unconfirmed) uncertainRetrievalIds.add(targetId);
    apiError.value = { questionId: targetId, unconfirmed, message: `${failure.message || '网页检索未完成，已保存资料保留。'}${unconfirmed ? ' 结果未确认，请读取检索记录，不会自动重发。' : ''}` };
  } finally { apiBusy.value = false; apiTask.value = null; }
}
function retrievalStatus(entry: RetrievalArchiveEntry) {
  if (entry.status === 'completed' && entry.partial) return '部分来源未抓取，已保存可用正文';
  if (entry.status === 'completed' && entry.sources.some(source => source.sourceKind === 'document-extract')) return '网页／文档资料已保存';
  return { completed: '网页正文已保存', running: '检索进行中', failed: '检索失败，未自动重试', unknown: '结果未知，未自动重发' }[entry.status];
}
function reportRetrieval(entry: RetrievalArchiveEntry, cached: boolean) {
  if (entry.status === 'running' || entry.status === 'unknown') uncertainRetrievalIds.add(entry.questionId);
  else uncertainRetrievalIds.delete(entry.questionId);
  if (entry.status === 'completed') {
    apiError.value = null;
    const hasDocumentExtract = entry.sources.some(source => source.sourceKind === 'document-extract');
    ElMessage.success(entry.partial ? cached ? '已读取本机可用正文，部分来源未抓取' : '部分来源未抓取，已保存可用正文' : hasDocumentExtract ? cached ? '已读取本机网页／文档资料，未再次检索' : '网页／文档资料已保存' : cached ? '已读取本机网页资料，未再次检索' : '网页来源与正文已保存');
  } else apiError.value = { questionId: entry.questionId, unconfirmed: entry.status === 'running' || entry.status === 'unknown', message: entry.error || retrievalStatus(entry) };
}
async function loadRetrievalHistory(open = true) {
  const id = question.value?.id;
  if (!id || (!open && !retrievalOpen.value)) return;
  const request = ++retrievalReadRequest;
  if (open) retrievalOpen.value = true;
  retrievalLoading.value = true; retrievalError.value = '';
  try {
    const result = await api.loadRetrievalHistory(id);
    if (request === retrievalReadRequest && question.value?.id === id && retrievalOpen.value) retrievedEntries[id] = result.entries;
  } catch (failure: any) {
    if (request === retrievalReadRequest && question.value?.id === id && retrievalOpen.value) retrievalError.value = failure.message || '检索记录暂未载入';
  } finally { if (request === retrievalReadRequest) retrievalLoading.value = false; }
}
async function toggleRetrievalHistory() {
  if (!retrievalOpen.value) { await loadRetrievalHistory(); return; }
  retrievalReadRequest++; retrievalOpen.value = false; retrievalLoading.value = false;
}
async function saveApi(clearApiKey = false) {
  if (aiBusy.value) return;
  apiSaving.value = true;
  try {
    const saved = await api.saveAiSettings({ baseUrl: 'https://api.deepseek.com/v1', ...(clearApiKey ? { clearApiKey: true } : { apiKey: aiDraft.apiKey }) });
    store.ai = { ...saved, retrievalAvailable: saved.retrievalAvailable === true, retrievalEnabled: saved.retrievalAvailable === true && saved.retrievalEnabled === true };
    aiDraft.apiKey = '';
    ElMessage.success(clearApiKey ? '本机检索密钥已清除' : store.ai.configured ? '网页检索配置已保存' : '请填写 DeepSeek 官方 API 密钥。');
  } catch { ElMessage.error('配置未保存，请检查本机服务和配置格式。'); }
  finally { apiSaving.value = false; }
}
async function exportData() {
  await safe(async () => {
    const data = await api.exportStudyData();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `备考学习记录-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
  });
}
async function importData(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0]; if (!file) return;
  const historyTargetId = question.value?.id;
  await safe(async () => {
    if (file.size > 64 * 1024 * 1024) throw new Error('备份不能超过 64MB');
    const data = JSON.parse(await file.text());
    const response = await fetch('/study-api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '导入失败');
    await store.bootstrap(); ElMessage.success(`新增 ${result.progressCount || 0} 道题目记录、${result.sessionCount || 0} 条练习；保留现有内容，${result.conflictCount || 0} 项差异未覆盖。`);
    refreshOpenAiHistory(historyTargetId);
  });
  target.value = '';
}
watch(() => filter.category, () => { filter.chapter = 'all'; });
watch(() => store.activeSession?.id, () => { autoFinishedId = ''; });
watch(() => question.value?.id, () => { historyRequest++; historyOpen.value = false; historyEntries.value = []; historyError.value = ''; historyLoading.value = false; aiHistoryRequest++; aiHistoryOpen.value = false; aiHistoryEntries.value = []; aiHistoryError.value = ''; aiHistoryLoading.value = false; retrievalReadRequest++; retrievalOpen.value = false; retrievalLoading.value = false; retrievalError.value = ''; });
onMounted(async () => {
  try {
    const saved = localStorage.getItem(sidebarStorageKey);
    if (saved !== null && Number.isFinite(Number(saved))) preferredSidebarWidth.value = Math.max(sidebarMinWidth, Math.min(360, Number(saved)));
  } catch { /* 未允许存储时使用默认宽度。 */ }
  updateViewportWidth();
  window.addEventListener('resize', updateViewportWidth);
  await safe(async () => { await store.bootstrap(); });
  if (disposed) return;
  timer = setInterval(() => {
    clock.value = Date.now();
    const active = store.activeSession;
    if (active?.mode === 'exam' && !active.removed && active.deadlineAt && clock.value >= Date.parse(active.deadlineAt) && autoFinishedId !== active.id && !store.busy) {
      autoFinishedId = active.id;
      void finish(true);
    }
  }, 1000);
});
onUnmounted(() => { disposed = true; clearInterval(timer); window.removeEventListener('resize', updateViewportWidth); stopSidebarResize(); });
</script>

<template>
  <div :class="['workspace', { 'resizing-sidebar': resizingSidebar }]" :style="{ '--sidebar-width': sidebarWidth + 'px' }">
    <aside id="study-sidebar" class="sidebar">
      <a class="brand" href="/study/" @click.prevent="go('home')"><span class="brand-mark">备</span><span>备考<small>个人刷题平台</small></span></a>
      <div class="nav-caption">我的学习</div>
      <nav aria-label="学习导航"><button v-for="item in nav" :key="item.id" :class="['nav-item', { active: page === item.id || (page === 'answer' && item.id === previousPage) }]" @click="go(item.id)"><span class="nav-icon">{{ item.icon }}</span>{{ item.label }}<b v-if="item.id === 'wrong' && pendingWrong.length">{{ pendingWrong.length }}</b></button></nav>
      <div class="sidebar-note"><span class="status-dot"></span> 本机学习空间<p>专注理解每一个知识点。<br>每次练习，都会留下进步。</p><button @click="exportData">导出学习记录 ↗</button></div>
      <div class="profile"><span>学</span><div>学习者<small>个人学习版</small></div><span class="online-dot"></span></div>
    </aside>
    <div v-if="desktopSidebar" class="sidebar-resizer" role="separator" tabindex="0" aria-label="调整左侧导航宽度" aria-orientation="vertical" aria-controls="study-sidebar study-main" :aria-valuemin="sidebarMinWidth" :aria-valuemax="sidebarMaxWidth" :aria-valuenow="sidebarWidth" :aria-valuetext="sidebarWidth + ' 像素'" title="左右拖动调整宽度；方向键微调，双击恢复默认" @pointerdown="beginSidebarResize" @pointermove="moveSidebarResize" @pointerup="stopSidebarResize" @pointercancel="stopSidebarResize" @lostpointercapture="stopSidebarResize" @keydown="resizeSidebarByKey" @dblclick="resetSidebarWidth"><span aria-hidden="true"></span></div>

    <main id="study-main" class="main">
      <header class="topbar"><div><span class="breadcrumb">我的学习 <i>/</i></span> {{ titles[page] }}</div><div class="topbar-status"><button class="ai-status" :data-state="apiUi.state" :title="apiUi.detail" @click="go('settings')"><span aria-hidden="true">{{ apiUi.symbol }}</span><span role="status" aria-live="polite">{{ '网页资料 · ' + apiUi.label }}</span></button><div class="top-meta"><span class="tiny-dot"></span> 学习记录保存在本机 <span class="today">{{ new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) }}</span></div></div></header>
      <div v-if="store.loading" class="loading-state">正在打开你的学习空间…</div>
      <div v-else-if="!store.loaded" class="empty-state"><h2>暂时未能连接学习服务</h2><p>{{ store.error }}</p><button class="btn primary" @click="safe(() => store.bootstrap())">重新连接</button></div>
      <div v-else class="content">


        <template v-if="page === 'home'">
          <section v-if="!store.questions.length" class="panel bank-setup" role="status" aria-label="安装自有题库">
            <h2>学习空间已就绪，请先添加自己的题库</h2>
            <p>公开版只提供项目，不附带题目。准备符合题库格式的 JSON 文件，停止学习服务后，在项目目录运行：</p>
            <pre>node study/import-bank.mjs "你的题库.json"</pre>
            <p>导入成功后重新启动服务并刷新页面。格式说明见项目 README；学习设置中的“导入备份”仅恢复学习记录，不会导入题目。</p>
            <button class="btn ghost" @click="safe(() => store.bootstrap())">重新检查题库</button>
          </section>
          <section class="welcome"><div><p class="eyebrow">YOUR NEXT CHAPTER</p><h1>把每一道错题，<br>变成下一次的底气<span>。</span></h1><p class="welcome-copy">从今天的练习开始，复盘思路、逐步巩固。</p><div class="hero-actions"><button class="btn primary" :disabled="!availableBank.length" @click="configure()">开始今日练习 <span>→</span></button><button v-if="store.activeSession" class="btn ghost" @click="resume()">继续上次答题 <span aria-hidden="true">→</span></button><button v-else class="btn ghost" :disabled="!availableBank.length" @click="configure('all', 'exam')">来一场模拟考试 <span aria-hidden="true">↗</span></button></div></div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-card"><span>LEARNING IS A PROCESS</span><b>日拱一卒</b><small>知其然，也知其所以然。</small><div class="art-rule"></div><em>01 — {{ availableBank.length }}</em></div><div class="art-star">✦</div></div></section>
          <section class="metrics" aria-label="学习统计"><div><span>已练题目</span><strong>{{ availableAnsweredCount }}<small>/ {{ availableBank.length }}</small></strong><p>一点一滴，积累知识版图</p></div><div><span>累计正确率</span><strong>{{ store.answeredCount ? store.accuracy + '%' : '—' }}</strong><p>按全部已判分作答次数统计</p></div><div><span>待巩固错题</span><strong class="warm">{{ pendingWrong.length }}<small>题</small></strong><button @click="go('wrong')">去研究错因 →</button></div><div><span>已完成练习</span><strong>{{ completed.length }}<small>次</small></strong><button @click="go('history')">查看学习足迹 →</button></div></section>
          <div class="section-heading"><div><p class="eyebrow">QUESTION BANK</p><h2>按方向，逐个攻克</h2></div><span>{{ availableBank.length }} 道可用题目 · 附答案与解析</span><button class="btn ghost" @click="go('bank')">浏览与管理题库 →</button></div>
          <section class="category-grid"><button v-for="item in categoryInfo" :key="item.name" class="category-card" @click="configure(item.name)"><div class="category-top"><span class="category-index">0{{ item.index }}</span><span class="category-count">{{ item.count }} 题</span></div><h3>{{ item.name }}</h3><p>{{ item.chapters }}</p><div class="progress-track"><span :style="{ width: item.done / item.count * 100 + '%' }"></span></div><footer><span>已练 {{ item.done }} / {{ item.count }}</span><b>{{ item.wrong ? item.wrong + ' 题待巩固' : '进入练习 →' }}</b></footer></button></section>
          <div class="home-bottom"><section class="panel compact"><div class="section-heading small-heading"><h2>最近的学习足迹</h2><button class="text-btn" @click="go('history')">全部记录 →</button></div><div v-if="!visibleSessions.length" class="inline-empty">你的第一次练习，会从这里开始。</div><button v-for="s in visibleSessions.slice(0, 3)" :key="s.id" class="history-line" @click="history(s)"><span class="record-icon">{{ s.mode === 'exam' ? '◎' : '▤' }}</span><span><b>{{ modeNames[s.mode] }}</b><small>{{ date(s.createdAt) }} · {{ s.questionIds.length }} 题</small></span><strong>{{ s.status === 'active' ? '继续答题 →' : s.score + '%' }}</strong></button></section><section class="ai-promo"><span class="eyebrow">UNDERSTAND, DON'T MEMORIZE</span><h2>不止知道答案，<br>更要理解为什么。</h2><p>用 Search／Fetch 保存公开网页来源与原文，按题目随时回看。</p><button class="text-btn" @click="go('settings')">配置网页检索 →</button></section></div>
        </template>

        <StudyManagement v-if="page === 'bank' || page === 'history'" :key="page" :kind="page === 'bank' ? 'bank' : 'history'" @review="review" @session="history" @practice="configure()" />



        <template v-if="page === 'practice'">
          <div class="page-intro"><p class="eyebrow">MAKE IT YOUR PRACTICE</p><h1>按你的节奏，开始练习。</h1><p>选择范围和方式，构建这一次的学习计划。</p><button class="btn ghost" @click="go('bank')">浏览全部题目 / 管理题库 →</button></div>
          <div class="practice-layout"><section class="panel config-panel"><h2>选择答题方式</h2><div class="mode-grid"><button v-for="mode in (['sequential', 'random', 'exam'] as const)" :key="mode" :class="['mode-card', { selected: filter.mode === mode }]" @click="filter.mode = mode"><b>{{ modeNames[mode] }}</b><small>{{ mode === 'sequential' ? '循序渐进，逐题理解' : mode === 'random' ? '打散顺序，检验掌握' : '限时作答，整卷判分' }}</small></button></div><h2 class="spaced">圈定练习范围</h2><div class="form-grid"><label>知识方向<select v-model="filter.category" aria-label="知识方向"><option value="all">全部方向</option><option v-for="c in availableCategories" :key="c">{{ c }}</option></select></label><label>章节<select v-model="filter.chapter" aria-label="章节"><option value="all">全部章节</option><option v-for="c in chapters" :key="c">{{ c }}</option></select></label><label>题型<select v-model="filter.type" aria-label="题型"><option value="all">单选 + 多选</option><option value="single">单选题</option><option value="multiple">多选题</option></select></label><label>难度<select v-model="filter.difficulty" aria-label="难度"><option value="all">全部难度</option><option v-for="level in availableDifficulties" :key="level">{{ level }}</option></select></label><label>本次题量<input v-model.number="filter.count" aria-label="本次题量" type="number" min="1" :max="Math.min(500, Math.max(1, filtered.length))"></label><label v-if="filter.mode === 'exam'">考试时长（分钟）<input v-model.number="filter.minutes" aria-label="考试时长" type="number" min="1" max="360"></label></div></section><aside class="panel plan-summary"><p class="eyebrow">READY WHEN YOU ARE</p><h2>这一次，专注一点。</h2><dl><div><dt>答题方式</dt><dd>{{ modeNames[filter.mode] }}</dd></div><div><dt>可用题目</dt><dd>{{ filtered.length }} 题</dd></div><div><dt>实际组题</dt><dd>{{ Math.min(filter.count || 0, filtered.length, 500) }} 题</dd></div><div v-if="filter.mode === 'exam'"><dt>限时</dt><dd>{{ filter.minutes }} 分钟</dd></div></dl><p>{{ filter.mode === 'exam' ? '整卷交卷后显示答案。刷新页面不会重置计时，到时自动交卷。' : '选择答案后提交查看解析，多选题须全部选对。答题进度自动保存。' }}</p><button class="btn primary full" :disabled="store.busy || !filtered.length || !questionCountValid" @click="start()">{{ store.busy ? '正在组题…' : '开始答题 →' }}</button><small>每次最多 500 题，可分多次练习。请核对自有题库的来源与答案。</small></aside></div>
        </template>

        <section v-if="page === 'answer' && !question" class="panel empty-state" role="status"><h2>这条记录暂不可继续</h2><p>{{ store.error || '记录可能已在其他页面删除，请到学习记录中查看或恢复。' }}</p><button class="btn ghost" @click="go('history')">查看学习记录 →</button></section>

        <template v-if="page === 'answer' && question">
          <div class="answer-heading"><button class="text-btn" @click="go(previousPage)">← 返回{{ titles[previousPage] }}</button><span v-if="examActive" class="exam-clock">剩余时间 {{ timeText }}</span><span v-else class="muted">{{ reviewId ? '研究易错点，形成自己的理解' : store.saveState === 'saving' ? '正在保存…' : store.saveState === 'error' ? '保存失败，请重选答案重试' : '答题进度已保存' }}</span></div>
          <div v-if="!reviewId && session?.status === 'completed'" class="result-banner"><div><small>本次已完成</small><h2>正确率 {{ session.score }}%</h2><p>答对 {{ session.correctCount }} / {{ session.questionIds.length }} 题 · 可以逐题复盘</p></div><button class="btn light" @click="go('wrong')">研究错题 →</button></div>
          <div v-if="store.hasAnswerConflicts" class="integrity-warning answer-conflict" role="alert"><b>其他页面已更改答案，本页选择已保留，提交已暂停。</b><p>请先记下需要保留的选择，再载入已保存答案。</p><button class="btn ghost" @click="reloadSavedAnswers">载入已保存答案</button></div><div class="answer-layout"><div class="answer-main"><section class="panel question-panel"><div class="question-meta"><div><span class="pill">{{ question.type === 'single' ? '单选题' : '多选题' }}</span><span>{{ question.category }}</span><span>· {{ question.difficulty }}</span></div><button class="text-btn favorite" @click="patch({ favorite: !progress.favorite })">{{ progress.favorite ? '★ 已收藏' : '☆ 收藏本题' }}</button></div><p class="question-number">{{ reviewId ? question.id : `${(session?.cursor || 0) + 1} / ${session?.questionIds.length}` }} <span>{{ question.chapter }}</span></p><h1 class="question-stem">{{ question.stem }}</h1><p v-if="question.type === 'multiple'" class="selection-hint">请选择所有正确选项，全部选对才计为正确。</p><div class="option-list"><button v-for="o in question.options" :key="o.id" :class="['option', { chosen: answer.includes(o.id), correct: revealed && grading?.answer.includes(o.id), incorrect: revealed && answer.includes(o.id) && !grading?.answer.includes(o.id) }]" :disabled="revealed || store.busy" :aria-pressed="answer.includes(o.id)" @click="select(o.id)"><span class="option-letter">{{ o.id }}</span><span>{{ o.text }}</span><b v-if="revealed && grading?.answer.includes(o.id)">✓</b><b v-else-if="revealed && answer.includes(o.id)">×</b></button></div><div class="question-actions"><span class="muted">{{ answer.length ? '已选 ' + answer.join('、') : '请选择你的答案' }}</span><button v-if="!revealed && !examActive" class="btn primary" :disabled="!answer.length || store.busy || store.hasAnswerConflicts" @click="safe(() => store.checkCurrent())">提交答案</button><span v-if="examActive" class="muted">整卷提交后查看解析</span></div><footer v-if="!reviewId && session" class="question-footer"><button class="btn ghost" :disabled="!session.cursor" @click="safe(() => store.navigate((session?.cursor || 0) - 1))">← 上一题</button><button v-if="(session.cursor || 0) < session.questionIds.length - 1" class="btn primary" @click="safe(() => store.navigate((session?.cursor || 0) + 1))">下一题 →</button><button v-else-if="session.status === 'active'" class="btn primary" :disabled="store.busy || store.hasAnswerConflicts" @click="finish()">完成并交卷</button><button v-else class="btn primary" @click="go('history')">返回学习记录</button></footer><div v-if="revealed" class="explanation"><div class="result-line"><b :class="grading?.correct ? 'good' : 'bad'">{{ grading?.correct ? '✓ 回答正确' : '✕ 还需要巩固' }}</b><span>{{ grading?.snapshot ? '当时标准答案' : '当前标准答案' }} <strong>{{ grading?.answer.join('、') }}</strong> <i>你的答案 {{ answer.join('、') || '未作答' }}</i></span></div><div class="result-ai-entry"><div><b>查找本题网页与文档资料</b><p>Search 查找来源与文档摘录，Fetch 保存网页原文；不调用生成模型。</p></div><button class="btn primary" aria-label="检索本题网页资料" :disabled="aiBusy" @click="requestExplanation">{{ aiActionLabel }}</button></div><div v-if="grading?.standardUpdated" class="standard-update" role="status"><b>标准答案已更新</b><br>本次记录保留当时判分标准、解析和成绩。当前标准答案：{{ question.answer.join('、') }}。<details><summary>查看当前解析</summary><p>{{ question.explanation }}</p></details></div><p v-if="reviewId" class="muted">按当前标准比对最后一次作答；原学习记录和成绩保持不变。</p><h3>{{ grading?.snapshot ? '当时题目解析' : '题目解析' }}</h3><p>{{ grading?.explanation }}</p><div class="knowledge">知识点 · {{ question.knowledgePoint }}</div></div></section>
            <section v-if="revealed" class="panel research-panel">
              <div class="section-heading small-heading"><h2>错因与学习笔记</h2><button v-if="!progress.wrongRemoved && !store.questionRecords?.[question.id]?.removed" class="text-btn" :disabled="wrongActionBusy" @click="toggleQuestionMastery">{{ progress.mastered ? '✓ 已掌握 · 重新巩固' : '标记为已掌握' }}</button></div>
              <p v-if="wrongActionError" class="mastery-error" role="alert">{{ wrongActionError }}</p>
              <p class="draft-status" role="status">{{ noteSaving ? '正在保存本次内容…' : noteDirty ? '有未保存修改 · 本页暂存草稿' : '与已保存内容一致' }}</p>
              <p v-if="draftStorageError || currentDraft?.error" class="integrity-warning" role="alert">{{ currentDraft?.error || draftStorageError }}</p>
              <label>这次主要卡在哪里？<select v-model="reason" aria-label="错因"><option value="">选择错因</option><option>概念不清</option><option>知识混淆</option><option>审题疏漏</option><option>记忆不牢</option><option>推理失误</option><option>需要核查题目</option></select></label>
              <label>写下你自己的理解<textarea v-model="note" aria-label="学习笔记" placeholder="用自己的话说明：为什么选它？下次如何避免再错？" rows="4" maxlength="10000"></textarea></label>
              <div v-if="noteConflict" class="saved-comparison"><h3>另一页面已保存的内容</h3><p>你的草稿保留在上方。请对照后复制需要的内容，或载入已保存版本。</p><dl><dt>学习笔记</dt><dd>{{ progress.note || '暂无笔记' }}</dd><dt>错因</dt><dd>{{ progress.reason || '未选择' }}</dd></dl></div>
              <div class="note-actions"><button class="text-btn" @click="copyDraft">复制草稿</button><button v-if="noteConflict" class="btn ghost" :disabled="noteSaving" @click="adoptSavedNotes">载入已保存版本</button><button class="btn primary" :disabled="noteSaving" @click="saveNotes">保存笔记</button></div>
              <div class="text-history"><button class="text-btn history-toggle" @click="historyOpen ? historyOpen = false : loadTextHistory()">{{ historyOpen ? '收起历史 ↑' : '查看笔记与解析历史 ↓' }}</button><div v-if="historyOpen"><p v-if="historyLoading" role="status">正在读取历史…</p><p v-else-if="historyError" role="alert">{{ historyError }}</p><p v-else-if="!historyEntries.length" class="muted">暂时没有旧版本。修改已保存正文时，会在这里保留原内容。</p><article v-for="entry in historyEntries" :key="entry.id" class="text-version"><div class="version-heading"><b>{{ versionNames[entry.field] }}</b><span>{{ date(entry.createdAt) }}</span></div><small>{{ entry.source.includes('conflict') ? '冲突时保留的内容' : entry.source.includes('restore') ? '恢复前保留的内容' : '历史版本' }}</small><pre>{{ entry.text || '（空内容）' }}</pre><button class="btn ghost" @click="restoreTextVersion(entry)">恢复这个版本</button></article></div></div>
            </section>
            <PreparedExplanation v-if="revealed" :key="question.id" :question="question" @standard-updated="safe(() => store.refreshProgress())" />
            <section v-if="revealed" ref="aiPanel" class="panel ai-panel" tabindex="-1" aria-labelledby="question-ai-heading">
              <div class="section-heading small-heading"><div><span class="eyebrow">SEARCH / FETCH</span><h2 id="question-ai-heading">本题网页／文档资料</h2></div><span :class="['connection', { connected: store.ai.configured }]">{{ apiUi.label }}</span></div>
              <p class="muted">固定使用 DeepSeek 官方 Search 查找公开网页与文档资料、Fetch 读取网页正文，并按题目保存来源与返回文本。PDF 只保留 Search 返回的文字摘录，不调用 Fetch。不调用生成模型，不发送个人作答、追问或笔记。</p>
              <p v-if="!store.ai.configured" class="prepared-note" role="status">请先在学习设置中配置官方检索密钥；已有题目讲解和历史仍然可读。</p>
              <p v-if="(question.answerRevision || 0) > 0" class="standard-update" role="status">网页资料按当前题目版本保存。旧版解析与原文仍可回看，请核对它们对应的题目版本。</p>
              <p class="fine-print">每题版本最多检索一次，最多 1 次 Search 与 2 次 Fetch。已有记录直接读取；失败或结果未知不会自动重试。工具可能计费，以服务商账单为准。</p>
              <div class="ai-actions"><button class="btn primary" :disabled="aiBusy" @click="requestExplanation">{{ aiActionLabel }}</button></div>
              <p v-if="apiBusy" role="status">{{ apiTask === 'read' ? '正在读取本机检索记录，不会访问外部网页…' : '正在通过 Search／Fetch 获取网页资料…' }}</p>
              <p v-if="apiError?.questionId === question.id" class="ai-refresh-error" role="alert">{{ apiError.message }}</p>
              <section class="retrieval-history-section" aria-label="本题网页检索记录">
                <div class="ai-history-tools"><button class="text-btn history-toggle" type="button" :aria-expanded="retrievalOpen" @click="toggleRetrievalHistory">{{ retrievalOpen ? '收起网页资料 ↑' : '查看已保存网页资料（只读） ↓' }}</button><button v-if="retrievalOpen" class="text-btn" type="button" :disabled="retrievalLoading" @click="loadRetrievalHistory(false)">刷新检索记录（只读）</button></div>
                <div v-if="retrievalOpen">
                  <p v-if="retrievalLoading" role="status">正在读取本机网页资料…</p><p v-else-if="retrievalError" role="alert">{{ retrievalError }}</p><p v-else-if="!currentRetrievedEntries.length" class="muted">本题暂无已保存网页资料。</p>
                  <details v-for="entry in currentRetrievedEntries" :key="entry.id || entry.requestId" class="retrieval-history-entry">
                    <summary><b>{{ retrievalStatus(entry) }}</b> · {{ date(entry.createdAt) }}<span v-if="!entry.currentFingerprintMatch"> · 旧题目版本</span></summary>
                    <p class="fine-print">搜索词：{{ entry.query || '尚未发出' }}。网页与文档资料仅作参考，未经过模型整理或事实审定。</p>
                    <p v-if="entry.error" role="alert">{{ entry.error }}</p>
                    <p v-if="entry.usage" class="fine-print">工具调用：{{ entry.usage.searchCalls }} 次 Search、{{ entry.usage.fetchCalls }} 次 Fetch；按配置单价估算 {{ entry.usage.estimatedCostCny.toFixed(3) }} 元，实际以服务商账单为准。</p>
                    <div v-if="entry.sourceErrors?.length" class="retrieval-source-notice"><b>补充抓取未完成的来源</b><ul><li v-for="source in entry.sourceErrors" :key="source.url"><span>{{ source.title || source.url }}</span> · {{ source.error || source.code || '抓取未完成' }}<span v-if="source.upstreamStatus">（HTTP {{ source.upstreamStatus }}）</span><span v-if="entry.sources.some(saved => saved.url === source.url && saved.contentOrigin === 'search')"> · Fetch 未完成，Search 返回的网页正文已保留</span><br><a v-if="safeAiSources([{ id: '', title: '', url: source.url }]).length" :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.url }}</a><span v-else>{{ source.url }}</span></li></ul></div>
                    <div v-if="entry.skippedSources?.length" class="retrieval-source-notice"><b>未提交抓取的文件</b><ul><li v-for="source in entry.skippedSources" :key="source.url">{{ source.title || source.url }} · {{ source.notice || '非网页文件，未提交 Fetch' }}<br><a v-if="safeAiSources([{ id: '', title: '', url: source.url }]).length" :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.url }}</a><span v-else>{{ source.url }}</span></li></ul></div>
                    <article v-for="source in entry.sources" :key="source.id + source.url" class="retrieval-source">
                      <h3><a v-if="retrievalSourceUrl(source)" :href="retrievalSourceUrl(source)" target="_blank" rel="noopener noreferrer">{{ source.title }}</a><span v-else>{{ source.title }}</span></h3>
                      <p class="fine-print">{{ source.originalUrl || source.url }}</p><p class="fine-print">{{ retrievalSourceDescription(source) }}</p><p v-if="source.contentEdited" class="fine-print">正文中的敏感认证信息或控制字符已做安全清理，未由模型改写。</p><pre>{{ source.content }}</pre>
                    </article>
                    <section v-if="locallyRecoveredSources(entry).length" class="retrieval-local-recovery" aria-label="从已保存 Search 结果恢复的资料">
                      <p class="retrieval-source-notice" role="status">已从当时保存的 Search 结果恢复 {{ locallyRecoveredSources(entry).length }} 份资料，未新增网络请求。原检索失败状态保留；这些资料未经模型整理或事实审定。</p>
                      <article v-for="source in locallyRecoveredSources(entry)" :key="source.id + source.url" class="retrieval-source">
                        <h3><a v-if="retrievalSourceUrl(source)" :href="retrievalSourceUrl(source)" target="_blank" rel="noopener noreferrer">{{ source.title }}</a><span v-else>{{ source.title }}</span></h3>
                        <p class="fine-print">{{ source.originalUrl || source.url }}</p><p class="fine-print">{{ retrievalSourceDescription(source) }}</p><p v-if="source.contentEdited" class="fine-print">正文中的敏感认证信息或控制字符已做安全清理，未由模型改写。</p><pre>{{ source.content }}</pre>
                      </article>
                    </section>
                  </details>
                </div>
              </section>
              <details v-if="progress.aiNote" class="ai-previous"><summary>此前保存的个性化解析（只读保留）</summary><div class="ai-answer">{{ progress.aiNote }}</div></details>
              <section class="ai-history-section" aria-label="本题 AI 解析历史">
                <div class="ai-history-tools"><button class="text-btn history-toggle" type="button" :aria-expanded="aiHistoryOpen" @click="toggleAiHistory">{{ aiHistoryOpen ? '收起本题解析历史 ↑' : `查看本题解析历史${aiHistoryEntries.length ? `（${aiHistoryEntries.length} 条，不会调用模型）` : '（不会调用模型）'} ↓` }}</button><button v-if="aiHistoryOpen" class="text-btn" type="button" :disabled="aiHistoryLoading" @click="loadAiHistory(question.id, false)">刷新历史（不会调用模型）</button></div>
                <div v-if="aiHistoryOpen" class="ai-history-list">
                  <p v-if="aiHistoryLoading" role="status">正在读取本题解析历史…</p>
                  <p v-else-if="aiHistoryError" role="alert">{{ aiHistoryError }}</p>
                  <p v-else-if="!aiHistoryEntries.length" class="muted">这道题暂时没有可回看的解析记录。每次完整解析都会按题目保存。</p>
                  <details v-for="entry in aiHistoryEntries" :key="entry.id" class="ai-history-entry">
                    <summary><span class="version-heading"><b>{{ aiProviderLabel(entry) }}</b><span>{{ aiHistoryStatus(entry) }}</span></span><span class="ai-history-time">{{ entry.createdAt ? `保存于 ${date(entry.createdAt)}` : '生成时间未记录' }}<template v-if="entry.archivedAt"> · 归档时间 {{ date(entry.archivedAt) }}</template></span></summary>
                    <small>当时选择：{{ entry.userAnswer ? entry.userAnswer.length ? entry.userAnswer.join('、') : '未作答' : '未记录' }} · {{ entry.questionRevision === undefined ? '标准版本未记录' : `标准版本 ${entry.questionRevision}` }}</small>
                    <p v-if="entry.followup" class="ai-history-followup">追问：{{ entry.followup }}</p>
                    <pre>{{ entry.text }}</pre>
                    <p v-if="entry.retrieval" class="fine-print">本次检索：{{ entry.retrieval.searchCalls }} 次 Search、{{ entry.retrieval.fetchCalls }} 次 Fetch，估算 {{ entry.retrieval.estimatedCostCny.toFixed(3) }} 元（不含模型 Token）。</p>
                    <details v-if="safeAiSources(entry.sources).length" class="ai-history-sources"><summary>查看本次参考来源（{{ safeAiSources(entry.sources).length }}）</summary><ol><li v-for="source in safeAiSources(entry.sources)" :key="source.id + source.url"><a :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title }}</a><span class="fine-print"> · {{ source.id }}</span></li></ol></details>
                  </details>
                </div>
              </section>
            </section>
          </div><aside class="answer-aside"><section v-if="!reviewId && session" class="panel answer-card"><h3>答题卡</h3><p>{{ selectedCount }} / {{ session.questionIds.length }} 已作答</p><div class="answer-grid"><button v-for="(id, i) in session.questionIds" :key="id" :class="{ current: i === session.cursor, answered: session.answers[id]?.length, checked: session.submittedQuestionIds.includes(id), wrong: session.submittedQuestionIds.includes(id) && wasIncorrect(id) }" :aria-label="`第${i + 1}题`" @click="safe(() => store.navigate(i))">{{ i + 1 }}</button></div><div class="card-legend"><span>○ 未答</span><span>● 已答</span><span>◉ 当前</span></div><button v-if="session.status === 'active'" class="btn ghost full" :disabled="store.busy || store.hasAnswerConflicts" @click="finish()">结束并交卷</button></section><section class="aside-tip"><span>一点提示</span><p>{{ examActive ? '遇到不确定的题目，可以先跳过。保持节奏，比在一题上停留更重要。' : '不要只记答案字母。试着说出每个选项成立或不成立的理由。' }}</p><small>{{ question.source }}</small><div v-if="revealed && questionReferences.length" class="question-references"><b>参考依据</b><a v-for="(url, i) in questionReferences" :key="url" :href="url" target="_blank" rel="noopener noreferrer">{{ i + 1 }}. {{ referenceName(url) }} ↗</a></div></section></aside></div>
        </template>

        <template v-if="page === 'wrong' || page === 'favorites'">
          <div class="page-intro collection-heading">
            <div><p class="eyebrow">{{ page === 'wrong' ? 'TURN MISTAKES INTO MASTERY' : 'KEEP WHAT MATTERS' }}</p><h1>{{ page === 'wrong' ? '每一道错题，都值得再想一遍。' : '把值得回看的知识，留在这里。' }}</h1><p>{{ page === 'wrong' ? `错题本 ${store.wrongQuestions.length} 道，${pendingWrong.length} 道待巩固，${masteredWrong.length} 道已掌握。` : `已收藏 ${store.favoriteQuestions.length} 道题。` }}</p></div>
            <button class="btn primary" :disabled="!practiceCollection.length || wrongActionBusy" @click="start(page === 'wrong' ? 'wrong' : 'favorites', practiceCollection.map(q => q.id))">{{ page === 'wrong' ? '重练待巩固错题' : '练习这些收藏' }} →</button>
          </div>
          <section class="panel collection-panel">
            <div class="collection-tools">
              <div v-if="page === 'wrong'" class="segmented"><button v-for="item in [{id:'pending',label:'待巩固'},{id:'mastered',label:'已掌握'},{id:'all',label:'全部'},{id:'removed',label:'已删除'}]" :key="item.id" :class="{ selected: wrongFilter === item.id }" :disabled="wrongActionBusy" @click="wrongFilter = item.id">{{ item.label }}</button></div>
              <span v-else class="muted">值得重复阅读的题目</span><input v-model="search" aria-label="搜索题目" placeholder="搜索题干、知识点…" :disabled="wrongActionBusy">
            </div>
            <div v-if="page === 'wrong'" class="collection-selection" role="group" aria-label="错题批量操作">
              <label class="collection-select-all"><input type="checkbox" aria-label="全选当前列表" :checked="allWrongSelected" :indeterminate="wrongSelectedCount > 0 && !allWrongSelected" :disabled="!collection.length || wrongActionBusy" @change="selectAllWrong"><span>全选当前列表</span></label>
              <span class="muted selection-count" aria-live="polite">已选 {{ wrongSelectedCount }} 条</span>
              <template v-if="wrongFilter !== 'removed'"><button class="btn light" :disabled="!selectedPendingWrongIds.length || wrongActionBusy" @click="markSelectedWrong(true)">标记选中为已掌握</button><button class="btn light" :disabled="!selectedMasteredWrongIds.length || wrongActionBusy" @click="markSelectedWrong(false)">标记选中为待巩固</button></template>
              <button class="btn ghost batch-action" :disabled="!wrongSelectedCount || wrongActionBusy" @click="changeSelectedWrong">{{ wrongBatchBusy ? '正在处理…' : wrongFilter === 'removed' ? '恢复选中记录' : '删除选中记录' }}</button>
            </div>
            <p v-if="wrongActionError" class="mastery-error" role="alert">{{ wrongActionError }}</p>
            <p v-if="page === 'wrong' && wrongFilter !== 'removed'" class="mastery-help">勾选右侧“已掌握”，该题会移入已掌握列表，不再参与待巩固重练。取消勾选可重新巩固，再次答错也会自动回到待巩固。</p>
            <p v-if="page === 'wrong' && wrongFilter === 'removed'" class="removed-help">这里只移出了错题本，原作答记录、笔记和 AI 解析仍保留。可勾选恢复；再次答错会自动重新加入。</p>
            <div v-if="!collection.length" class="empty-state"><span class="empty-symbol">{{ page === 'wrong' ? '✓' : '☆' }}</span><h2>{{ page === 'wrong' ? search ? '没有符合搜索条件的错题' : wrongFilter === 'removed' ? '还没有已删除的错题记录' : wrongFilter === 'mastered' ? '还没有标记为已掌握的错题' : wrongFilter === 'pending' ? '待巩固错题已清空' : '错题本暂时为空' : '还没有收藏的题目' }}</h2><p>{{ page === 'wrong' && wrongFilter === 'removed' ? '删除的错题记录会保留在这里，随时可以恢复。' : page === 'wrong' && wrongFilter === 'mastered' ? '理解并掌握后，在错题右侧勾选“已掌握”，就能在这里回看。' : page === 'wrong' && wrongFilter === 'pending' && !search ? '已掌握的题目仍可回看；之后再次答错，会自动回到这里。' : '可以调整搜索条件，或开始新一轮练习。' }}</p><button class="btn ghost" @click="configure()">去练习 →</button></div>
            <div v-for="q in collection" :key="q.id" :class="['collection-item', { selected: page === 'wrong' && selectedWrongIds.includes(q.id) }]">
              <label v-if="page === 'wrong'" class="collection-select" @click.stop><input type="checkbox" :aria-label="`选择错题 ${q.id}`" :checked="selectedWrongIds.includes(q.id)" :disabled="wrongActionBusy" @click.stop @change="selectWrong(q.id, $event)"></label>
              <button class="collection-row" @click="review(q)"><div class="collection-row-meta"><span class="pill">{{ q.type === 'single' ? '单选' : '多选' }}</span><span>{{ q.category }}</span><span v-if="store.progress[q.id]?.mastered" class="good">✓ 已掌握</span></div><h3>{{ q.stem }}</h3><p>{{ q.knowledgePoint }}</p><footer><span v-if="page === 'wrong'">错 {{ store.progress[q.id]?.wrongCount }} 次 <i>·</i> {{ store.progress[q.id]?.reason || '尚未记录错因' }}</span><span v-else>{{ q.chapter }}</span><b>进入研究 →</b></footer></button>
              <label v-if="page === 'wrong' && wrongFilter !== 'removed'" class="mastery-toggle" :class="{ mastered: store.progress[q.id]?.mastered, disabled: wrongActionBusy }" @click.stop><input type="checkbox" :aria-label="`已掌握错题 ${q.id}`" :checked="!!store.progress[q.id]?.mastered" :disabled="wrongActionBusy" @click.stop @change="toggleWrongMastery(q.id, $event)"><span>{{ store.progress[q.id]?.mastered ? '已掌握' : '标记已掌握' }}</span></label>
            </div>
          </section>
        </template>



        <template v-if="page === 'settings'">
          <div class="page-intro"><p class="eyebrow">YOUR STUDY SPACE</p><h1>把工具，调成顺手的样子。</h1><p>连接 AI 解析，管理只属于你的学习记录。</p></div><div class="settings-grid">
            <section class="panel" aria-label="网页检索设置">
              <span class="eyebrow">SEARCH / FETCH ONLY</span><h2>配置网页资料检索。</h2>
              <p class="muted">仅使用 DeepSeek 官方 Search／Fetch。Search 查找公开网页，Fetch 读取正文并保存到对应题目，不调用生成模型。</p>
              <form aria-label="API 配置" @submit.prevent="saveApi()">
                <p class="fine-print">服务地址固定为 https://api.deepseek.com/v1/tools/search 与 /fetch，无法切换为生成模型。</p>
                <label>DeepSeek API Key<input v-model="aiDraft.apiKey" type="password" autocomplete="off" spellcheck="false" aria-label="API Key" :placeholder="store.ai.configured ? '留空保留本机已保存密钥' : '仅保存在本机'" :disabled="aiBusy"></label>
                <p class="fine-print">每题版本最多 1 次 Search 与 2 次 Fetch，工具可能计费，实际以服务商账单为准。保存配置、浏览题目和读取已存资料不会发起检索。</p>
                <button type="submit" class="btn ghost" :disabled="aiBusy">{{ apiSaving ? '正在保存…' : '保存检索配置' }}</button>
                <button v-if="store.ai.configured" type="button" class="btn ghost" :disabled="aiBusy" @click="saveApi(true)">清除本机 API 密钥</button>
                <p class="fine-print">密钥不返回到页面，也不包含在学习记录导出中。检索词只取题干、科目与知识点，不发送个人作答、笔记或学习历史。</p>
              </form>
            </section><section class="panel"><span class="eyebrow">YOURS TO KEEP</span><h2>让学习记录，有一份备份。</h2><p class="muted">错题、收藏、笔记、AI 解析和答题记录都保存在本机。导出后可在本平台重新导入。</p><div class="backup-actions"><button class="btn primary" @click="exportData">导出学习记录 ↓</button><button class="btn ghost" @click="importInput?.click()">导入备份 ↑</button><input ref="importInput" type="file" accept=".json,application/json" hidden @change="importData"></div><p class="fine-print">导入只补充缺失的题目进度与答题记录，现有内容保留。不同的旧笔记与解析会存入题目历史，导入前另存快照。API Key 不包含在备份中。网页原文另存在本机资料目录，当前学习记录导出不包含网页资料。</p><div class="about-bank"><h3>当前题库</h3><p>{{ availableBank.length }} 道可用题目<br>{{ bankSingleCount }} 单选 · {{ availableBank.length - bankSingleCount }} 多选 · {{ availableCategories.length }} 个方向</p><small>题目由你自行提供；请确认有权使用，并核对答案与解析。</small><button class="btn ghost" @click="go('bank')">浏览与管理题库 →</button></div></section></div>
        </template>
        <footer class="page-footer"><span>备考 · 个人刷题平台</span><span>日日积累，久久为功。</span></footer>
      </div>
    </main>
  </div>
</template>

<style scoped>
.retrieval-history-section{margin-top:24px;border-top:1px solid #ddd;padding-top:20px}.retrieval-history-entry{border:1px solid #c8c8c8;border-radius:8px;padding:18px;margin-top:14px}.retrieval-history-entry>summary{cursor:pointer;line-height:1.8}.retrieval-source{margin-top:20px;border-top:1px solid #ddd;padding-top:12px}.retrieval-source h3{line-height:1.7}.retrieval-source a{text-decoration:underline;overflow-wrap:anywhere}.retrieval-source pre{font:15px/1.9 "Microsoft YaHei","微软雅黑",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;max-height:520px;overflow:auto;background:#f6f6f6;padding:14px}.retrieval-source .fine-print{overflow-wrap:anywhere}.retrieval-source-notice{font-size:14px;line-height:1.8;margin-top:14px;overflow-wrap:anywhere}.retrieval-source-notice a{text-decoration:underline}.retrieval-source-notice ul{padding-left:20px}
.question-references{display:grid;gap:10px;margin-top:20px;overflow-wrap:anywhere;font-size:15px}.question-references b{color:var(--study-text)}.question-references a{border-bottom:1px solid #aaa;padding-bottom:4px;text-decoration:underline;text-underline-offset:4px}.question-references a:hover{background:#ddd;color:#111}
.standard-update{border:2px solid #555;border-radius:8px;background:#eee;color:var(--study-text);padding:14px 16px;margin:0 0 20px;font-size:16px;line-height:1.9}.standard-update summary{cursor:pointer;text-decoration:underline;text-underline-offset:4px;font-weight:600;min-height:40px;padding:6px 0}.standard-update summary:hover{background:#ddd}.standard-update p{margin-bottom:0}.draft-status{font-size:15px;color:var(--study-text-secondary);margin:0 0 12px}.integrity-warning{border:2px solid #555;border-radius:8px;padding:16px 18px;background:#eee;color:var(--study-text);overflow-wrap:anywhere}.answer-conflict{margin-bottom:20px}.answer-conflict p{margin:8px 0 14px}.saved-comparison{padding:18px;background:#f2f2f2;border-left:4px solid #555;margin:18px 0}.saved-comparison h3{font-size:18px;margin-bottom:8px}.saved-comparison p{margin-bottom:12px}.saved-comparison dl{margin:0}.saved-comparison dt{font-weight:bold;margin-top:8px}.saved-comparison dd{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}.note-actions{display:flex;gap:14px;flex-wrap:wrap;justify-content:flex-end;align-items:center}.text-history{margin-top:24px;border-top:1px solid #ddd;padding-top:20px}.history-toggle{margin-bottom:16px}.text-version{border:1px solid #ddd;border-radius:8px;padding:18px;margin-top:14px}.version-heading{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:16px}.text-version small{color:var(--study-text-secondary)}.text-version pre{font:16px/1.9 "Microsoft YaHei","微软雅黑",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;background:#f6f6f6;padding:12px}.text-version .btn{min-height:42px}
.ai-history-section{margin-top:24px;border-top:1px solid #ddd;padding-top:20px}.ai-history-tools{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px}.ai-history-list{margin-top:8px}.ai-history-entry{border:1px solid #c8c8c8;border-radius:8px;padding:18px;margin-top:14px;background:#fff}.ai-history-entry>summary{cursor:pointer;list-style-position:inside}.ai-history-entry>summary .version-heading{display:inline-flex;vertical-align:top;width:calc(100% - 24px);flex-wrap:wrap;gap:8px}.ai-history-time{display:block;color:var(--study-text-secondary);font-size:13px;line-height:1.7;margin-top:7px}.ai-history-entry small{display:block;color:var(--study-text-secondary);margin-top:7px}.ai-history-entry pre{font:16px/1.9 "Microsoft YaHei","微软雅黑",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto;background:#f6f6f6;padding:12px;margin:14px 0}.ai-history-followup{border-left:3px solid #777;padding-left:10px;margin:13px 0;color:var(--study-text-secondary);white-space:pre-wrap;overflow-wrap:anywhere}.ai-history-sources{border-top:1px solid #ddd;padding-top:12px;margin-top:14px}.ai-history-sources summary{cursor:pointer}.ai-history-sources ol{margin:10px 0 0 20px}.ai-history-sources a{text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}
.analysis-recovery{display:flex;align-items:center;justify-content:space-between;gap:18px;border:1px solid #c8c8c8;background:#f5f5f5;border-radius:10px;padding:18px 22px;margin-bottom:22px}
.analysis-recovery strong{font-size:16px}.analysis-recovery p,.analysis-safeguards p{font-size:15px;line-height:1.85;margin:8px 0;color:var(--study-text)}
.recovery-actions{display:flex;flex-wrap:wrap;gap:10px;flex-shrink:0}.analysis-safeguards{border:1px solid #d7d7d7;border-radius:8px;padding:18px;margin-bottom:22px;background:#f7f7f7}
.analysis-safeguards h3{font-size:16px;margin:0 0 10px}.analysis-safeguards small{display:block;margin-top:14px;font-size:13px;color:var(--study-text-secondary);line-height:1.8}
@container study-main (max-width:760px){.analysis-recovery{align-items:flex-start;flex-direction:column}}
:global(#yankao-study-bridge){display:none!important}
:global(body){--study-text:#171717;--study-text-secondary:#333333;--study-text-muted:#444444;--study-control-border:#858585;--el-text-color-primary:#171717;--el-text-color-regular:#262626;--el-text-color-secondary:#333333;--el-text-color-placeholder:#555555;--el-text-color-disabled:#555555;--el-disabled-text-color:#555555;--el-disabled-bg-color:#e8e8e8;--el-disabled-border-color:#a5a5a5;margin:0;color:var(--study-text);background:#f1f1f1;font-family:"Microsoft YaHei","微软雅黑",sans-serif;font-size:16px;-webkit-font-smoothing:antialiased;--el-font-family:"Microsoft YaHei","微软雅黑",sans-serif;--el-color-primary:#171717;--el-color-primary-light-3:#4d4d4d;--el-color-primary-light-5:#888888;--el-color-primary-light-7:#b8b8b8;--el-color-primary-light-8:#d9d9d9;--el-color-primary-light-9:#f2f2f2;--el-color-primary-dark-2:#000000;--el-color-success:#404040;--el-color-danger:#404040;--el-color-warning:#555555;--el-color-info:#666666;line-height:1.85;--el-font-size-base:15px;--el-font-size-small:13px;--el-font-size-extra-small:13px}*{box-sizing:border-box}button,input,select,textarea{font:inherit}button,a,select{touch-action:manipulation}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:1;color:#555555}a{color:inherit;text-decoration:none}button{color:inherit}button:focus-visible,a:focus-visible{outline:3px solid #adadad;outline-offset:4px}input,select,textarea{width:100%;border:1px solid var(--study-control-border);border-radius:9px;background:#ffffff;color:var(--study-text);padding:12px 13px;outline:none;line-height:1.8;font-size:15px}input:focus,select:focus,textarea:focus{border-color:#171717;box-shadow:0 0 0 3px #1717171a}input::placeholder,textarea::placeholder{color:#555555;opacity:1}input:disabled,select:disabled,textarea:disabled{opacity:1;color:#555555;-webkit-text-fill-color:#555555;background:#e8e8e8;border-color:#a5a5a5}label{display:flex;flex-direction:column;gap:8px;font-size:15px;color:var(--study-text);line-height:1.8}h1,h2,h3,p{margin-top:0}h1{font-size:32px;letter-spacing:-1px;line-height:1.5;font-family:"SimSun","宋体",serif}h2{font-size:20px;letter-spacing:-.4px;line-height:1.5;font-family:"SimSun","宋体",serif}h3{font-size:15px;line-height:1.6;font-family:"SimSun","宋体",serif}p{line-height:1.9}.workspace{display:flex;min-height:100vh;width:100%;min-width:0}.sidebar{width:var(--sidebar-width,224px);flex-shrink:0;position:fixed;inset:0 auto 0 0;background:#ffffff;border-right:1px solid #e7e7e7;padding:34px 20px 20px;display:flex;flex-direction:column;z-index:10;overflow-y:auto;padding-left:14px;padding-right:14px;overflow-x:hidden}.brand{display:flex;align-items:center;gap:11px;font-family:"SimSun","宋体",serif;font-size:25px;font-weight:700;padding:0;gap:10px}.brand-mark{flex-shrink:0;display:grid;place-items:center;width:41px;height:44px;background:#171717;color:#ffffff;border-radius:12px 4px 12px 4px;font-size:25px}.brand small{display:block;font:13px/1.7 "Microsoft YaHei",sans-serif;letter-spacing:0;text-wrap:balance;color:var(--study-text-secondary);margin-top:4px}.nav-caption{font-size:13px;color:var(--study-text-secondary);letter-spacing:2px;margin:45px 17px 16px}.nav-item{display:flex;align-items:center;width:100%;border:0;background:transparent;text-align:left;padding:13px 10px;margin-bottom:7px;border-radius:9px;gap:9px;color:var(--study-text);font-size:15px}.nav-item:hover{background:#f4f4f4}.nav-item.active{color:#171717;background:#eeeeee;font-weight:700;box-shadow:inset 3px 0 0 #171717}.nav-icon{font-family:"Microsoft YaHei","微软雅黑",sans-serif;font-size:21px;line-height:22px;width:23px;text-align:center;font-weight:400;flex-shrink:0}.nav-item b{font:13px/1 "Microsoft YaHei","微软雅黑",sans-serif;margin-left:auto;background:#ffffff;padding:4px 6px;border-radius:4px;color:var(--study-text)}.sidebar-note{margin:auto 9px 23px;padding:20px 0 0;color:var(--study-text);font-size:15px}.sidebar-note p{font-size:15px;line-height:1.9;color:var(--study-text-secondary);margin:12px 0}.sidebar-note button{border:0;background:transparent;padding:0;font-size:15px;color:var(--study-text)}.status-dot,.tiny-dot,.online-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:#929292;margin-right:5px}.profile{border-top:1px solid #e7e7e7;padding:20px 8px 0;display:flex;align-items:center;gap:11px;font-size:13px}.profile>span:first-child{width:32px;height:34px;background:#eeeeee;color:var(--study-text);display:grid;place-items:center;border-radius:50%;font:16px "SimSun"}.profile small{display:block;color:var(--study-text-secondary);font-size:13px;margin-top:3px}.profile .online-dot{margin-left:auto}.main{margin-left:var(--sidebar-width,224px);width:calc(100% - var(--sidebar-width,224px));min-width:0;container-type:inline-size;container-name:study-main}.topbar{height:auto;padding:18px 42px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e8e8e8;background:#ffffff;font-size:13px;color:var(--study-text);min-height:76px;gap:16px;flex-wrap:wrap}.breadcrumb{color:var(--study-text-secondary)}.breadcrumb i{font-style:normal;margin:0 13px;color:var(--study-text-muted)}.top-meta{display:flex;align-items:center;font-size:13px;color:var(--study-text-secondary)}.today{margin-left:23px;padding-left:23px;border-left:1px solid #e4e4e4}.content{max-width:1500px;margin:0 auto;padding:32px 42px 0}.welcome{position:relative;display:grid;grid-template-columns:1.3fr 1fr;align-items:center;min-height:315px;border-radius:15px;background:#eeeeee;padding:35px 38px;overflow:hidden}.eyebrow{font:12px/1.6 "Microsoft YaHei","微软雅黑",sans-serif;letter-spacing:2.2px;font-weight:650;color:var(--study-text-secondary);margin:0 0 14px}.welcome h1{font-family:"SimSun","宋体",serif;font-size:35px;line-height:1.6;letter-spacing:2px;color:var(--study-text);margin:0 0 13px}.welcome h1 span{color:var(--study-text-secondary)}.welcome-copy{font-size:15px;color:var(--study-text-secondary);margin-bottom:23px}.hero-actions{display:flex;gap:17px;align-items:center;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;justify-content:center;gap:25px;font-size:15px;border:1px solid transparent;border-radius:8px;min-height:40px;padding:10px 18px;line-height:1.5;white-space:nowrap;transition:background .15s}.btn.primary{background:#171717;color:#ffffff;border-color:#171717}.btn.primary:hover{background:#000000}.btn.ghost{background:#ffffff;border-color:var(--study-control-border);color:var(--study-text)}.hero-actions .btn.ghost{background:transparent;border:0;font-size:15px;padding:10px 0;color:var(--study-text)}.btn.light{background:#e9e9e9;color:var(--study-text)}.btn.full{width:100%}.hero-art{position:relative;display:grid;place-items:center;height:270px}.orbit{position:absolute;border:1px solid #d3d3d3;border-radius:50%;transform:rotate(-20deg);width:280px;height:205px}.orbit-two{transform:rotate(58deg);width:240px;height:230px}.art-card{width:200px;height:270px;position:relative;padding:22px 20px;background:#ffffff;box-shadow:6px 9px 0 #00000012;transform:rotate(9deg);border:1px solid #d4d4d4;display:flex;flex-direction:column}.art-card>span{font:12px/1.3 "Microsoft YaHei","微软雅黑",sans-serif;letter-spacing:.5px;color:var(--study-text-secondary)}.art-card b{font:29px/1.6 "SimSun","宋体",serif;letter-spacing:3px;margin-top:12px;color:var(--study-text);line-height:1.4}.art-card small{font-size:12px;color:var(--study-text-secondary);margin:6px 0 13px;line-height:1.6}.art-rule{height:1px;background:#e4e4e4;width:31px}.art-card em{font:12px "Microsoft YaHei","微软雅黑",sans-serif;letter-spacing:2px;color:var(--study-text-muted);margin-top:auto}.art-star{position:absolute;left:calc(50% - 125px);top:27px;color:var(--study-text-secondary);font-size:37px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);margin:23px 0 34px;border:1px solid #e3e3e3;border-radius:12px;background:#ffffff;padding:21px 0}.metrics>div{padding:0 26px;border-right:1px solid #eaeaea}.metrics>div:last-child{border:0}.metrics>div>span{font-size:13px;color:var(--study-text-secondary)}.metrics strong{display:block;font:32px/1.35 "Microsoft YaHei","微软雅黑",sans-serif;font-weight:550;margin:8px 0;color:var(--study-text)}.metrics strong.small{font-size:25px}.metrics strong small{font-size:13px;color:var(--study-text-secondary);margin-left:7px;font-weight:400}.metrics p,.metrics button{font-size:15px;color:var(--study-text-secondary);margin:0}.metrics button{border:0;background:none;padding:0;color:var(--study-text-secondary)}.metrics .warm{color:var(--study-text)}.section-heading{display:flex;justify-content:space-between;align-items:flex-end;margin:0 0 20px;gap:20px}.section-heading .eyebrow{font-size:12px;margin-bottom:6px}.section-heading h2{font-size:20px;margin:0;color:var(--study-text)}.section-heading>span{font-size:13px;color:var(--study-text-secondary);margin-bottom:2px}.category-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.category-card{text-align:left;padding:24px;background:#ffffff;border:1px solid #e5e5e5;border-radius:12px;transition:transform .15s,border-color .15s;min-width:0}.category-card:hover{transform:translateY(-2px);border-color:#b3b3b3}.category-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:17px}.category-index{font:15px/1 "Microsoft YaHei","微软雅黑",sans-serif;color:var(--study-text-secondary);background:#f4f4f4;padding:9px 8px;border-radius:7px}.category-count{font-size:13px;color:var(--study-text-secondary)}.category-card h3{font-size:15px;margin:0 0 7px;font-weight:650;color:var(--study-text)}.category-card p{font-size:15px;color:var(--study-text-secondary);margin:0 0 22px;line-height:1.85}.progress-track{height:3px;background:#f4f4f4;border-radius:4px;overflow:hidden}.progress-track>span{display:block;background:#555555;height:100%;border-radius:4px}.category-card footer{display:flex;justify-content:space-between;font-size:13px;color:var(--study-text-muted);margin-top:12px}.category-card footer b{font-weight:400;color:var(--study-text-secondary)}.home-bottom{display:grid;grid-template-columns:1.4fr 1fr;gap:20px;margin-top:27px}.panel{background:#ffffff;border:1px solid #e5e5e5;border-radius:13px;padding:27px}.small-heading{margin-bottom:18px;align-items:center}.small-heading h2{font-size:17px}.text-btn{border:0;padding:0;background:transparent;color:var(--study-text);font-size:15px;line-height:1.6;text-align:left}.inline-empty{font-size:13px;color:var(--study-text-muted);padding:22px 0 12px}.ai-promo{border:1px solid #dedede;background:#eeeeee;border-radius:13px;padding:29px;border-color:#d9d9d9}.ai-promo .eyebrow{font-size:12px;letter-spacing:1.5px}.ai-promo h2{font:21px/1.7 "SimSun","宋体",serif;color:var(--study-text);margin-bottom:12px}.ai-promo p{font-size:15px;color:var(--study-text-secondary);max-width:230px}.ai-promo a{font-size:15px;color:var(--study-text)}.page-footer{display:flex;justify-content:space-between;color:var(--study-text-muted);font-size:12px;letter-spacing:.5px;padding:26px 0;margin-top:24px;border-top:1px solid #e8e8e8}.page-intro{padding:7px 0 24px}.page-intro .eyebrow{margin-bottom:10px}.page-intro h1{font-family:"SimSun","宋体",serif;font-size:29px;color:var(--study-text);letter-spacing:1px;margin-bottom:9px}.page-intro>p,.page-intro>div>p:last-child{font-size:15px;color:var(--study-text-secondary);margin-bottom:0}.practice-layout{display:grid;grid-template-columns:1fr 300px;gap:22px;align-items:start}.config-panel h2{font-size:16px;margin-bottom:18px}.mode-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.mode-card{border:1px solid #e4e4e4;border-radius:9px;padding:20px 12px;background:#ffffff;text-align:left;min-width:0}.mode-card b{font-size:15px;display:block;margin-bottom:8px;font-weight:600}.mode-card small{font-size:15px;color:var(--study-text-secondary);line-height:1.8}.mode-card.selected{border-color:#333333;background:#f1f1f1;box-shadow:inset 0 0 0 1px #333333}.spaced{margin-top:33px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}.plan-summary{background:#eeeeee;padding:28px 25px}.plan-summary h2{font:23px/1.8 "SimSun","宋体",serif;margin:12px 0 27px}.plan-summary dl{margin:0 0 25px}.plan-summary dl>div{display:flex;justify-content:space-between;padding:13px 0;border-bottom:1px solid #e0e0e0;font-size:13px}.plan-summary dt{color:var(--study-text-secondary)}.plan-summary dd{margin:0;color:var(--study-text)}.plan-summary p{color:var(--study-text-secondary);font-size:15px;line-height:2;margin-bottom:24px}.plan-summary>small{display:block;text-align:center;font-size:13px;color:var(--study-text-muted);margin-top:15px}.answer-heading{display:flex;justify-content:space-between;align-items:center;margin:0 0 21px;min-height:20px}.muted{color:var(--study-text-secondary);font-size:15px}.exam-clock{padding:8px 16px;background:#eeeeee;border-radius:6px;color:var(--study-text);font:13px "Microsoft YaHei","微软雅黑",sans-serif}.answer-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:22px;align-items:start}.answer-main,.answer-aside{min-width:0}.question-panel{padding:29px}.question-meta{display:flex;justify-content:space-between;gap:12px;align-items:center;color:var(--study-text-secondary);font-size:13px}.question-meta>div{display:flex;align-items:center;gap:9px}.pill{background:#f4f4f4;color:var(--study-text-secondary);padding:4px 9px;border-radius:5px;font-size:13px;white-space:nowrap}.favorite{white-space:nowrap;color:var(--study-text-secondary)}.question-number{font:13px "Microsoft YaHei","微软雅黑",sans-serif;color:var(--study-text-secondary);display:flex;gap:14px;margin:29px 0 12px}.question-number span{font:13px "Microsoft YaHei";color:var(--study-text-muted)}.question-stem{font-size:21px;font-weight:600;line-height:1.9;letter-spacing:0;color:var(--study-text);margin-bottom:22px}.selection-hint{color:var(--study-text-secondary);font-size:15px;margin:-7px 0 20px}.option-list{display:flex;flex-direction:column;gap:12px}.option{width:100%;display:flex;align-items:center;gap:15px;border:1px solid var(--study-control-border);background:#ffffff;text-align:left;border-radius:9px;padding:14px 16px;font-size:16px;color:var(--study-text);line-height:1.8;min-height:57px}.option:disabled{opacity:1;color:var(--study-text);cursor:default}.option:hover:not(:disabled){background:#f8f8f8}.option-letter{display:grid;place-items:center;flex-shrink:0;border:1px solid var(--study-control-border);border-radius:6px;width:32px;height:32px;font:15px "Microsoft YaHei","微软雅黑",sans-serif;color:var(--study-text-secondary)}.option.chosen{background:#f1f1f1;border-color:#333333}.option.chosen .option-letter{background:#222222;color:#ffffff;border-color:#222222}.option.correct{border-color:#555555;background:#f4f4f4;border-style:solid}.option.incorrect{border-color:#777777;background:repeating-linear-gradient(135deg,#ffffff 0,#ffffff 7px,#f3f3f3 7px,#f3f3f3 9px);border-style:dashed}.option.incorrect .option-letter{background:#666666;border-color:#666666;color:#ffffff}.option>b{margin-left:auto;color:var(--study-text);font-size:17px}.option.incorrect>b{color:var(--study-text)}.question-actions{display:flex;justify-content:space-between;align-items:center;margin-top:23px;min-height:40px}.explanation{border-top:1px solid #e8e8e8;margin-top:23px;padding-top:22px}.result-line{display:flex;align-items:center;gap:20px;margin-bottom:20px;font-size:15px;flex-wrap:wrap}.good{color:var(--study-text)}.bad{color:var(--study-text)}.result-line>span{color:var(--study-text-secondary)}.result-line strong{color:var(--study-text);margin-left:7px}.result-line i{font-style:normal;color:var(--study-text-secondary);margin-left:16px}.explanation h3{font-size:13px;margin-bottom:8px;color:var(--study-text)}.explanation p{font-size:16px;color:var(--study-text-secondary);line-height:1.95;margin-bottom:15px}.knowledge{font-size:15px;color:var(--study-text-secondary);background:#f4f4f4;padding:12px 15px;border-radius:6px}.question-footer{display:flex;justify-content:space-between;border-top:1px solid #e8e8e8;margin-top:25px;padding-top:23px}.answer-card{padding:23px 19px}.answer-card h3{font-size:14px;margin-bottom:6px}.answer-card>p{font-size:15px;color:var(--study-text-secondary);margin-bottom:18px}.answer-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));min-width:0;gap:7px;max-height:390px;overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable;padding:4px}.answer-grid button{border:1px solid var(--study-control-border);min-width:0;min-height:42px;border-radius:5px;background:#ffffff;color:var(--study-text-secondary);font:15px/1.2 "Microsoft YaHei","微软雅黑",sans-serif;position:relative;padding:7px 2px 13px}.answer-grid button.answered{background:#e6e6e6;border-color:#b8b8b8;color:var(--study-text)}.answer-grid button.checked{background:#333333;color:#ffffff;border-color:#333333}.answer-grid button.wrong{background:repeating-linear-gradient(135deg,#ffffff 0,#ffffff 5px,#e9e9e9 5px,#e9e9e9 7px);color:var(--study-text);border-color:#666666;border-style:dashed}.answer-grid button.current{outline:2px solid #222222;outline-offset:1px}.card-legend{display:flex;gap:11px;color:var(--study-text-secondary);font-size:13px;margin:19px 0 21px}.aside-tip{padding:24px 9px}.aside-tip>span{font-size:13px;color:var(--study-text-secondary);letter-spacing:1px}.aside-tip p{font-size:15px;color:var(--study-text-muted);line-height:1.95;margin:11px 0 20px}.aside-tip small{font-size:13px;line-height:1.8;color:var(--study-text-muted)}.research-panel,.ai-panel{margin-top:21px}.research-panel>label,.ai-panel>label{margin:19px 0}.align-right{display:flex;justify-content:flex-end}.ai-panel{border-color:#d9d9d9;background:#fafafa}.ai-panel h2{font:22px "SimSun","宋体",serif;margin:6px 0 0}.connection{font-size:15px;color:var(--study-text-secondary);white-space:nowrap}.connection.connected{color:var(--study-text-secondary)}.ai-actions{display:flex;align-items:center;flex-wrap:wrap;gap:20px;margin-top:23px}.bridge-message{background:#f4f4f4;color:var(--study-text-secondary);border-radius:6px;font-size:15px;padding:12px 14px;margin-top:21px;line-height:1.8}.ai-answer{font-size:16px;line-height:1.95;color:var(--study-text);white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid #e5e5e5;margin-top:22px;padding-top:22px}.result-banner{padding:23px 29px;background:#f4f4f4;border:1px solid #e1e1e1;border-radius:11px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center}.result-banner small{font-size:13px;color:var(--study-text-secondary)}.result-banner h2{margin:4px 0;color:var(--study-text);font-size:23px}.result-banner p{font-size:15px;color:var(--study-text-secondary);margin:0}.collection-heading{display:flex;justify-content:space-between;align-items:center;gap:22px}.collection-heading h1{font-size:26px}.collection-panel{padding:0 26px}.collection-tools{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e9e9e9;padding:22px 0;gap:20px}.collection-tools>input{max-width:245px;font-size:15px;padding:8px 12px}.segmented{background:#f4f4f4;border-radius:7px;padding:4px;display:flex;gap:3px}.segmented button{padding:7px 13px;border:0;background:none;color:var(--study-text-secondary);font-size:15px;border-radius:5px}.segmented button.selected{background:#ffffff;color:var(--study-text);box-shadow:0 1px 3px #7e7e7e12}.collection-row{display:block;width:100%;border:0;border-bottom:1px solid #eaeaea;background:transparent;text-align:left;padding:23px 0}.collection-row:last-child{border:0}.collection-row:hover h3{color:var(--study-text)}.collection-row-meta{display:flex;gap:11px;align-items:center;font-size:13px;color:var(--study-text-muted);margin-bottom:13px}.collection-row h3{font-size:15px;color:var(--study-text);margin-bottom:9px}.collection-row p{font-size:15px;color:var(--study-text-secondary);margin-bottom:15px}.collection-row footer{display:flex;justify-content:space-between;font-size:13px;color:var(--study-text-muted)}.collection-row footer b{font-weight:400;color:var(--study-text-secondary)}.collection-row footer i{font-style:normal;padding:0 8px}.empty-state{text-align:center;padding:62px 20px;color:var(--study-text-muted)}.empty-state h2{font-size:16px;color:var(--study-text-secondary);margin:15px 0}.empty-state p{font-size:15px;margin:0 0 25px}.empty-symbol{font:42px/1.8 "Microsoft YaHei","微软雅黑",sans-serif;color:var(--study-text-muted)}.history-panel{padding:0 27px}.history-line{border:0;border-bottom:1px solid #e8e8e8;width:100%;background:transparent;display:flex;align-items:center;text-align:left;padding:21px 0;gap:16px}.history-line:last-child{border:0}.record-icon{width:37px;height:39px;display:grid;place-items:center;border-radius:8px;background:#f4f4f4;color:var(--study-text-secondary);font:22px "Microsoft YaHei","微软雅黑",sans-serif}.history-line b{font-size:15px;color:var(--study-text-secondary);font-weight:550}.history-line small{display:block;font-size:13px;color:var(--study-text-muted);margin-top:6px}.history-line strong{margin-left:auto;font:17px "Microsoft YaHei","微软雅黑",sans-serif;color:var(--study-text-secondary);white-space:nowrap}.compact .history-line strong{font-size:13px}.record-state{font-size:13px;background:#f4f4f4;color:var(--study-text-secondary);padding:4px 8px;border-radius:4px;margin-left:auto;white-space:nowrap}.record-state.done{background:#f4f4f4;color:var(--study-text-muted)}.history-line .record-state+strong{margin-left:20px;min-width:60px;text-align:right}.history-arrow{font-size:14px;color:var(--study-text-muted);margin-left:12px}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start}.settings-grid h2{font:23px/1.8 "SimSun","宋体",serif;color:var(--study-text);margin-bottom:17px}.settings-grid .muted{line-height:1.95}.settings-status{padding:18px 0 25px}.fine-print{font-size:15px;line-height:1.95;color:var(--study-text-muted);margin:21px 0 0}.backup-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:25px}.about-bank{border-top:1px solid #e8e8e8;margin-top:28px;padding-top:23px}.about-bank h3{color:var(--study-text-secondary);font-size:13px}.about-bank p{font-size:15px;color:var(--study-text-secondary);line-height:2}.about-bank small{font-size:13px;color:var(--study-text-muted);line-height:2}.advanced{border-top:1px solid #e4e4e4;padding-top:20px;margin-top:25px}.advanced summary{font-size:15px;color:var(--study-text-secondary);cursor:pointer;line-height:2}.advanced p{margin-top:16px}.advanced label{margin:18px 0}.advanced button{margin-top:16px}.loading-state{text-align:center;padding:120px;color:var(--study-text-secondary);font-size:15px}
@media(min-width:1550px){.content{padding-left:60px;padding-right:60px}.welcome{padding-left:48px}.category-card{padding:27px}.category-card h3{font-size:17px}.category-card p{font-size:15px}.welcome h1{font-size:39px}.welcome-copy{font-size:15px}.welcome{min-height:338px}}
@media(max-width:1150px){.sidebar{padding-left:12px;padding-right:12px}.main{}.topbar{padding:16px 27px}.content{padding:27px 27px 0}.welcome{padding:30px;grid-template-columns:1.45fr 1fr}.welcome h1{font-size:28px}.hero-art{transform:scale(.85)}.metrics>div{padding:0 18px}.category-card{padding:20px}.category-card h3{font-size:15px}.category-card p{font-size:15px}.practice-layout{grid-template-columns:1fr 250px}.answer-layout{grid-template-columns:minmax(0,1fr) 280px;gap:17px}.answer-card{padding:20px 14px}.answer-grid{gap:5px}.question-panel{padding:23px}.question-stem{font-size:21px}.collection-heading h1{font-size:23px}}
@media(max-width:900px){.hero-art{display:none}.welcome{grid-template-columns:1fr;min-height:280px}.category-grid{grid-template-columns:repeat(2,1fr)}.home-bottom,.practice-layout,.settings-grid{grid-template-columns:1fr}.plan-summary{display:block}.answer-layout{grid-template-columns:1fr}.answer-aside{grid-row:1}.answer-card{padding:16px 20px}.answer-grid{grid-template-columns:repeat(10,minmax(0,1fr));max-height:120px}.answer-card>p{margin-bottom:12px}.card-legend,.answer-card>.full{display:none}.answer-aside .aside-tip{display:none}.top-meta{display:none}.mode-grid{gap:8px}.metrics{grid-template-columns:repeat(2,1fr);gap:24px 0}.metrics>div:nth-child(2){border-right:0}.collection-heading{align-items:flex-start;flex-direction:column}.settings-grid{gap:18px}}
@media(max-width:640px){.sidebar{position:sticky;inset:auto;top:0;width:100%;height:auto;padding:13px 16px 0;border-right:0;border-bottom:1px solid #e7e7e7;display:block}.workspace{display:block}.brand{font-size:21px;padding:0}.brand-mark{width:32px;height:35px;font-size:20px;border-radius:8px 3px 8px 3px}.brand small{font-size:13px}.nav-caption,.sidebar-note,.profile{display:none}.sidebar nav{display:flex;overflow:auto;gap:4px;margin-top:14px}.nav-item{width:auto;flex-shrink:0;gap:4px;padding:10px 9px;margin:0;border-radius:7px 7px 0 0;font-size:15px}.nav-icon{display:none}.nav-item b{font-size:13px;padding:2px 4px}.main{margin:0;width:100%}.topbar{height:auto;padding:12px 19px;font-size:13px;min-height:0;gap:10px}.content{padding:19px 17px 0}.welcome{padding:26px 22px;min-height:285px;border-radius:10px}.welcome h1{font-size:27px}.welcome-copy{font-size:15px}.hero-actions{gap:15px}.hero-actions .btn.ghost{font-size:15px}.btn{font-size:14px;padding:10px 14px;gap:10px}.metrics{margin:17px 0 25px;padding:20px 0}.metrics strong{font-size:29px}.metrics>div{padding:0 18px}.metrics p{font-size:15px}.section-heading{gap:8px}.section-heading h2{font-size:17px}.section-heading>span{font-size:13px;max-width:105px;line-height:1.8}.category-grid{gap:11px}.category-card{padding:17px 14px}.category-card h3{font-size:15px}.category-card p{font-size:15px;min-height:28px;margin-bottom:16px}.category-index{font-size:13px;padding:7px}.category-top{margin-bottom:14px}.category-card footer{font-size:13px}.category-count{font-size:13px}.home-bottom{gap:16px;margin-top:20px}.panel{padding:23px 20px}.page-intro{padding-top:4px;padding-bottom:19px}.page-intro h1{font-size:24px}.form-grid{gap:18px 13px}.mode-grid{grid-template-columns:1fr}.mode-card{padding:15px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}.mode-card b{margin:0;font-size:15px}.mode-card small{font-size:15px}.plan-summary{padding:25px}.question-meta{align-items:flex-start}.question-meta>div{flex-wrap:wrap;gap:5px;font-size:13px}.favorite{font-size:15px}.question-panel{padding:22px 17px}.question-stem{font-size:20px}.question-number{margin-top:23px;font-size:13px}.option{padding:14px 16px;font-size:16px;gap:10px}.option-letter{width:30px;height:30px}.answer-grid{grid-template-columns:repeat(8,minmax(0,1fr))}.answer-heading .muted{font-size:15px}.ai-panel .small-heading{align-items:flex-start;flex-direction:column;gap:13px}.ai-panel h2{font-size:21px}.ai-actions{gap:14px}.ai-actions .text-btn{font-size:15px}.research-panel .small-heading{gap:12px}.research-panel .small-heading h2{font-size:15px}.research-panel .small-heading button{font-size:15px}.result-line{gap:11px}.result-line>span{font-size:15px}.explanation p{font-size:16px}.result-banner{padding:19px}.result-banner h2{font-size:20px}.result-banner p{font-size:15px}.collection-heading h1{font-size:22px}.collection-panel{padding:0 18px}.collection-tools{align-items:stretch;flex-direction:column;gap:14px}.collection-tools>input{max-width:none}.segmented{align-self:flex-start}.collection-row h3{font-size:15px}.collection-row p{font-size:15px}.history-panel{padding:0 18px}.history-line{gap:10px}.history-line b{font-size:15px}.history-line small{font-size:13px}.history-line .record-state+strong{font-size:13px;margin-left:7px;min-width:45px}.history-arrow{display:none}.record-icon{width:29px;height:32px;font-size:18px}.record-state{font-size:13px;padding:3px 5px}.page-footer{font-size:12px;margin-top:21px;padding:21px 0}.page-intro .eyebrow{font-size:12px;letter-spacing:1.8px}.topbar-status{width:100%;justify-content:flex-start}.sidebar-resizer{display:none}}
.muted,.fine-print,.aside-tip p,.page-intro>p,.page-intro>div>p:last-child{color:var(--study-text)}.option{color:var(--study-text);background:#ffffff;font-size:16px;line-height:1.9;padding:16px 18px;min-height:64px}.explanation p,.ai-answer{font-size:16px;color:var(--study-text);line-height:1.95}.connection{color:var(--study-text)}.connection.connected{color:var(--study-text)}.question-meta{color:var(--study-text-secondary)}.question-number span{color:var(--study-text-secondary)}.result-line i,.selection-hint{color:var(--study-text)}.category-card p,.category-count,.category-card footer{color:var(--study-text-secondary)}.metrics>div>span{color:var(--study-text-secondary)}.top-meta,.welcome-copy{color:var(--study-text)}.page-footer{color:var(--study-text-secondary)}.sidebar-note p{color:var(--study-text-secondary)}
@media(min-width:641px){.category-card p,.category-card footer,.category-count{font-size:15px}.metrics p,.metrics button,.metrics>div>span{font-size:15px}.muted,.fine-print,.aside-tip p{font-size:15px}.section-heading>span{font-size:13px}.ai-answer,.explanation p{font-size:16px}.option{font-size:16px}.welcome-copy{font-size:15px}.question-meta{font-size:13px}.plan-summary p,.plan-summary dt,.history-line small{font-size:15px}}
.answer-grid button.checked::after{content:"✓";position:absolute;top:auto;right:2px;font-size:13px;line-height:1;bottom:0}
.answer-grid button.wrong::after{content:"×"}
:global(.el-message){--el-message-text-color:#333333;--el-message-bg-color:#f7f7f7;--el-message-border-color:#d9d9d9;font-size:15px}
:global(.el-message .el-message__icon),:global(.el-message-box__status){color:var(--study-text-secondary)}
:global(.el-message-box__title){font-family:"SimSun","宋体",serif}
:global(.el-message-box){--el-messagebox-font-size:16px;--el-messagebox-content-font-size:15px;line-height:1.85}
.topbar-status{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:12px;min-width:0;max-width:100%}
.ai-status{display:inline-flex;align-items:center;gap:8px;max-width:100%;min-width:0;border:1px solid #d9d9d9;border-radius:6px;background:#f8f8f8;color:var(--study-text);padding:7px 10px;font-size:13px;line-height:1.5;text-align:left;overflow-wrap:anywhere}
.ai-status[data-state="busy"]{border-color:#777777;background:#eeeeee}
.ai-status[data-state="waiting"],.ai-status[data-state="error"]{border-style:dashed}
.ai-status[data-state="offline"]{color:var(--study-text-secondary)}
.sidebar-resizer{position:fixed;left:calc(var(--sidebar-width,224px) - 5px);top:0;width:10px;height:100vh;z-index:20;cursor:col-resize;touch-action:none;user-select:none;outline:none}
.sidebar-resizer::before{content:"";position:absolute;left:4px;top:0;bottom:0;width:1px;background:#d9d9d9}
.sidebar-resizer>span{position:absolute;left:1px;top:calc(50% - 18px);width:8px;height:36px;border:1px solid #b8b8b8;border-radius:4px;background:#eeeeee}
.sidebar-resizer:hover::before,.sidebar-resizer:focus-visible::before,.resizing-sidebar .sidebar-resizer::before{left:3px;width:3px;background:#555555}
.resizing-sidebar{user-select:none;cursor:col-resize}
.content,.panel,.practice-layout>*,.settings-grid>*,.home-bottom>*,.form-grid>label,.welcome>div{min-width:0}
@container study-main (max-width:760px){.home-bottom,.practice-layout,.settings-grid,.answer-layout{grid-template-columns:1fr}.category-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.hero-art,.top-meta{display:none}.welcome{grid-template-columns:1fr}.answer-aside{grid-row:1}.answer-grid{grid-template-columns:repeat(8,minmax(0,1fr));max-height:120px}.card-legend,.answer-card>.full,.answer-aside .aside-tip{display:none}}
@container study-main (max-width:500px){.answer-card{padding-inline:14px}.answer-grid{grid-template-columns:repeat(5,minmax(0,1fr))}.form-grid,.category-grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 0}.metrics>div:nth-child(2){border-right:0}.section-heading,.question-meta,.question-meta>div,.question-actions,.result-banner{flex-wrap:wrap}.question-actions,.result-banner{gap:14px}.connection{white-space:normal}.collection-tools{align-items:stretch;flex-direction:column}.segmented{flex-wrap:wrap}}
.ai-waiting,.ai-incomplete{font-size:16px;line-height:1.95;color:var(--study-text-secondary);margin:22px 0 0}
.ai-waiting{padding:18px;border:1px dashed #b8b8b8;border-radius:7px;background:#f6f6f6}
.ai-answer[data-partial="true"]{border-left:2px dashed #999999;padding-left:16px}
.ai-refresh-error{font-size:13px;line-height:1.8;color:var(--study-text-secondary);margin:12px 0 0}
.ai-previous{border-top:1px solid #d9d9d9;margin-top:22px;padding-top:16px}
.ai-previous summary{font-size:15px;line-height:1.85;cursor:pointer;color:var(--study-text)}

/* Make interactive surfaces recognizable without moving the surrounding layout. */
button,a[href],summary,.btn,.category-card{touch-action:manipulation;transition:transform 160ms ease,background-color 160ms ease,border-color 160ms ease,box-shadow 160ms ease,color 160ms ease;text-underline-offset:5px}
button:not(:disabled),a[href],summary,select:not(:disabled){cursor:pointer}
input,select,textarea{transition:border-color 160ms ease,box-shadow 160ms ease,background-color 160ms ease}
summary{border-radius:5px}
button:not(:disabled):focus-visible,a[href]:focus-visible,summary:focus-visible{outline:2px solid #333333;outline-offset:4px}
.answer-grid button:focus-visible{outline-offset:-3px}
.ai-promo a{display:inline-block}
.btn>span,.category-card footer b,.history-arrow,.nav-icon,.brand-mark{transition:transform 160ms ease}
.sidebar-resizer::before,.sidebar-resizer>span{transition:background-color 160ms ease,border-color 160ms ease,box-shadow 160ms ease}
.sidebar-resizer:hover>span,.sidebar-resizer:focus-visible>span,.resizing-sidebar .sidebar-resizer>span{background:#d9d9d9;border-color:#333333;box-shadow:0 0 0 3px #0000000d}
@media(hover:hover) and (pointer:fine){
  button:not(:disabled):hover{transform:translateY(-2px);box-shadow:0 4px 10px #00000010}
  .btn.primary:not(:disabled):hover{background:#000000;border-color:#000000;box-shadow:0 5px 12px #00000024}
  .btn.ghost:not(:disabled):hover,.btn.light:not(:disabled):hover,.ai-status:not(:disabled):hover{background:#eeeeee;border-color:#777777}
  .nav-item:not(:disabled):hover{transform:translateX(3px);background:#e9e9e9;box-shadow:inset 3px 0 0 #666666}
  .nav-item.active:not(:disabled):hover{background:#e2e2e2;box-shadow:inset 3px 0 0 #171717}
  .nav-item:hover .nav-icon{transform:scale(1.08)}
  .category-card:not(:disabled):hover{transform:translateY(-3px);border-color:#777777;background:#fafafa;box-shadow:0 7px 18px #00000012}
  .mode-card:not(:disabled):hover{border-color:#777777;background:#f7f7f7}
  .mode-card.selected:not(:disabled):hover{border-color:#333333;background:#eaeaea;box-shadow:inset 0 0 0 1px #333333,0 4px 10px #00000010}
  .option:not(:disabled):hover{transform:translateX(3px);border-color:#777777;background:#f5f5f5;box-shadow:0 3px 9px #0000000d}
  .option.chosen:not(:disabled):hover{border-color:#333333;background:#eaeaea}
  .history-line:not(:disabled):hover,.collection-row:not(:disabled):hover{transform:translateX(3px);background:#f2f2f2;box-shadow:inset 3px 0 0 #777777}
  .answer-grid button:not(:disabled):hover{border-color:#333333;box-shadow:0 3px 6px #00000020}
  .segmented button:not(:disabled):hover{background:#e4e4e4;color:#171717;box-shadow:0 2px 5px #00000012}
  .text-btn:not(:disabled):hover,.metrics button:not(:disabled):hover,.sidebar-note button:not(:disabled):hover{transform:translateX(2px);color:#111111;text-decoration:underline;box-shadow:none}
  a[href]:hover{color:#111111;text-decoration:underline}
  .brand:hover{text-decoration:none}
  .brand:hover .brand-mark{transform:translateY(-2px) rotate(-4deg)}
  .btn:hover>span,.category-card:hover footer b,.history-line:hover .history-arrow{transform:translateX(3px)}
  summary:hover{transform:translateX(2px);background:#ededed;color:#171717;text-decoration:underline}
  input:not(:disabled):hover,select:not(:disabled):hover,textarea:not(:disabled):hover{border-color:#888888}
  select:not(:disabled):hover{background-color:#fafafa}
}
button:not(:disabled):active,.category-card:not(:disabled):active,.mode-card:not(:disabled):active,.btn.primary:not(:disabled):active,.btn.ghost:not(:disabled):active,.btn.light:not(:disabled):active,.ai-status:not(:disabled):active,.answer-grid button:not(:disabled):active,.segmented button:not(:disabled):active{transform:translateY(1px) scale(.99);box-shadow:inset 0 1px 3px #00000018}
.mode-card.selected:not(:disabled):active{box-shadow:inset 0 0 0 1px #333333,inset 0 1px 3px #00000018}
a[href]:active,summary:active{transform:translateY(1px);opacity:.8}
.nav-item:not(:disabled):active,.nav-item.active:not(:disabled):active,.option:not(:disabled):active,.history-line:not(:disabled):active,.collection-row:not(:disabled):active,.text-btn:not(:disabled):active,.metrics button:not(:disabled):active,.sidebar-note button:not(:disabled):active{transform:translateX(1px);box-shadow:inset 0 1px 3px #00000018}
button:disabled{transform:none;box-shadow:none}
.btn:disabled,.btn.primary:disabled:hover{color:#555555;background:#e8e8e8;border-color:#a5a5a5}.btn.primary:disabled{color:#555555;background:#e8e8e8;border-color:#a5a5a5}
:global(.el-message-box .el-button),:global(.el-message-box__headerbtn){transition:transform 160ms ease,background-color 160ms ease,border-color 160ms ease,box-shadow 160ms ease}
:global(.el-message-box .el-button:focus-visible),:global(.el-message-box__headerbtn:focus-visible){outline:2px solid #333333;outline-offset:3px}
@media(hover:hover) and (pointer:fine){
  :global(.el-message-box .el-button:not(.is-disabled):hover),:global(.el-message-box__headerbtn:hover){transform:translateY(-2px);box-shadow:0 4px 10px #00000018}
}
:global(.el-message-box .el-button:not(.is-disabled):active),:global(.el-message-box__headerbtn:active){transform:translateY(1px) scale(.99);box-shadow:inset 0 1px 3px #00000018}
@media(prefers-reduced-motion:reduce){
  button,a[href],summary,input,select,textarea,.btn>span,.category-card footer b,.history-arrow,.nav-icon,.brand-mark,.sidebar-resizer::before,.sidebar-resizer>span{transition:none!important}
  button:not(:disabled):hover,button:not(:disabled):active,a[href]:active,summary:hover,summary:active,.btn:hover>span,.category-card:hover footer b,.history-line:hover .history-arrow,.nav-item:hover .nav-icon,.brand:hover .brand-mark{transform:none!important}
  :global(.el-message-box .el-button),:global(.el-message-box__headerbtn){transition:none!important;transform:none!important}
}

/* The home page's secondary action should read as a real button at a glance. */
.hero-actions .btn.ghost{min-height:43px;padding:10px 18px;gap:18px;border:1px solid #8f8f8f;background:#ffffff;color:var(--study-text);font-size:15px;font-weight:650;box-shadow:0 2px 0 #0000000d}
@media(hover:hover) and (pointer:fine){
  .hero-actions .btn.ghost:not(:disabled):hover{transform:translateY(-3px);background:#303030;border-color:#303030;color:#ffffff;box-shadow:0 8px 18px #00000029}
  .hero-actions .btn.ghost:not(:disabled):hover>span{transform:translateX(4px)}
}
.hero-actions .btn.ghost:not(:disabled):active{transform:translateY(1px) scale(.99);background:#171717;border-color:#171717;color:#ffffff;box-shadow:inset 0 1px 3px #00000040}
@media(prefers-reduced-motion:reduce){
  .hero-actions .btn.ghost:not(:disabled):hover,.hero-actions .btn.ghost:not(:disabled):active,.hero-actions .btn.ghost:not(:disabled):hover>span{transform:none!important}
}
.collection-selection{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:16px 0;border-bottom:1px solid #e9e9e9}
.collection-select-all{flex-direction:row;align-items:center;gap:10px;cursor:pointer;color:var(--study-text)}
.collection-select-all input,.collection-select input{width:20px;height:20px;min-width:20px;padding:0;margin:0;accent-color:#171717;cursor:pointer;box-shadow:none}
.collection-select-all input:focus-visible,.collection-select input:focus-visible{outline:3px solid #aaa;outline-offset:4px}
.collection-select-all input:disabled,.collection-select input:disabled{cursor:default}
.selection-count{font-size:14px}
.batch-action{margin-left:auto}
.collection-item{display:flex;align-items:stretch;gap:12px;border-bottom:1px solid #eaeaea;transition:background .15s,box-shadow .15s}
.collection-item:last-child{border-bottom:0}
.collection-item.selected{background:#f1f1f1;box-shadow:inset 3px 0 0 #171717}
.collection-select{width:38px;flex-shrink:0;align-items:center;justify-content:center;cursor:pointer}
.collection-select:hover{background:#eaeaea}
.collection-item .collection-row{flex:1;min-width:0;border-bottom:0}
.removed-help{font-size:14px;color:var(--study-text-secondary);margin:18px 0;line-height:1.9}
@media(max-width:640px){.collection-selection{gap:12px}.batch-action{margin-left:0;width:100%}.collection-item{gap:8px}.collection-select{width:30px}}
.mastery-toggle{align-self:center;display:flex;flex-direction:row;align-items:center;gap:10px;flex-shrink:0;padding:12px 14px;margin:16px 0 16px 8px;border:1px solid #858585;border-radius:7px;color:#171717;background:#fff;font-size:16px;font-weight:500;cursor:pointer;transition:background .15s,box-shadow .15s,transform .15s}.mastery-toggle:hover:not(.disabled){background:#e9e9e9;box-shadow:0 3px 9px #0002;transform:translateY(-1px)}.mastery-toggle.mastered{background:#171717;border-color:#171717;color:#fff}.mastery-toggle.mastered:hover:not(.disabled){background:#333}.mastery-toggle input{width:20px;height:20px;min-width:20px;padding:0;margin:0;accent-color:#171717;cursor:pointer;box-shadow:none}.mastery-toggle input:focus-visible{outline:2px solid #333;outline-offset:4px}.mastery-toggle.mastered input{accent-color:#fff}.mastery-toggle.mastered input:focus-visible{outline-color:#fff}.mastery-toggle.disabled{background:#e8e8e8;color:#555;border-color:#aaa;cursor:not-allowed}.mastery-toggle.disabled input{cursor:not-allowed}.mastery-help{font-size:16px;line-height:1.9;color:#333;margin:18px 0}.mastery-error{color:#171717;line-height:1.9;background:#f3f3f3;border:1px dashed #666;border-radius:7px;padding:12px 16px;overflow-wrap:anywhere;font-size:16px}.research-panel button:disabled{cursor:not-allowed;color:#555}.collection-selection .btn{font-size:15px;padding:10px 12px}@media(max-width:800px){.collection-item{flex-wrap:wrap;column-gap:8px}.collection-item .collection-row{flex-basis:calc(100% - 50px)}.mastery-toggle{margin:0 0 18px 46px}.collection-selection{gap:12px}.collection-selection .batch-action{margin-left:0}}@media(prefers-reduced-motion:reduce){.mastery-toggle{transition:none}.mastery-toggle:hover:not(.disabled){transform:none}}
.result-ai-entry{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:20px 0;padding:18px 20px;border:1px solid #999;border-radius:10px;background:#fff;color:#171717}.result-ai-entry b{font-size:17px}.result-ai-entry p{margin:4px 0 0;font-size:15px;line-height:1.8;color:#333}.result-ai-entry .btn{flex-shrink:0;min-height:46px}.ai-panel{scroll-margin-top:24px}.ai-panel:focus-visible{outline:3px solid #555;outline-offset:4px}
@media(max-width:640px){.result-ai-entry{align-items:stretch;flex-direction:column;gap:14px;padding:16px}.result-ai-entry .btn{align-self:flex-start}}
.bank-setup{margin-bottom:28px}.bank-setup p{line-height:1.8}.bank-setup pre{padding:12px;background:#f4f4f4;white-space:pre-wrap;overflow-wrap:anywhere}
.retrieval-toggle{flex-direction:row;align-items:center;gap:8px}.retrieval-toggle input{width:auto;flex-shrink:0}.ai-sources a{text-decoration:underline;overflow-wrap:anywhere}
</style>
