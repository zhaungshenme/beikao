import { isIP } from 'node:net';

const TOOL_ORIGIN = 'https://api.deepseek.com/v1/tools';
const REQUEST_TIMEOUT_MS = 10000;
const TOTAL_TIMEOUT_MS = 25000;
const MAX_RESPONSE_BYTES = 262144;
const MAX_SOURCE_CHARS = 6000;
const TOOL_PRICE_CNY = 0.005;
const NON_WEB_EXTENSION = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|bz2|xz|exe|msi|dmg|apk|iso|mp[34]|wav|avi|mov|png|jpe?g|gif|webp|ico)$/i;
export const ARCHIVE_CONTENT_POLICY = 'search-text-with-pdf-extracts-v1';
export const PDF_EXTRACT_CONTENT_POLICY = 'search-pdf-extract-readonly-v1';

class RetrievalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DeepSeekRetrievalError';
    this.code = code;
    if (Number.isInteger(details.upstreamStatus) && details.upstreamStatus >= 100 && details.upstreamStatus <= 599) this.upstreamStatus = details.upstreamStatus;
    if (['search', 'fetch'].includes(details.tool)) this.tool = details.tool;
  }
}
const failure = (code, message, details) => new RetrievalError(code, message, details);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The same key is only valid for these official origins, never a compatible gateway.
export function isDeepSeekBaseUrl(baseUrl) {
  return typeof baseUrl === 'string' && /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(baseUrl);
}

function publicIPv4(host) {
  const [a, b, c] = host.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}

export function publicSourceUrl(value, apiKey = '') {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value) || apiKey && value.includes(apiKey)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const family = isIP(host);
  if (family === 4 && !publicIPv4(host)) return null;
  if (family === 6) {
    // Only global-unicast IPv6. Also exclude documentation and transition ranges.
    const prefix = Number.parseInt(host.split(':')[0], 16);
    if (!(prefix >= 0x2000 && prefix <= 0x3fff) || prefix === 0x2002 || /^2001:(?:0:|:|db8:)/i.test(host)) return null;
  }
  if (!family && (!host.includes('.') || /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|home|lan|test|invalid|example|onion)$/i.test(host))) return null;
  url.hash = '';
  return url.href;
}

export function isPdfSourceUrl(value) {
  try {
    let pathname = new URL(value).pathname;
    try { pathname = decodeURIComponent(pathname); } catch { /* Keep the literal pathname. */ }
    return /\.pdf$/i.test(pathname);
  } catch { return false; }
}

function publicQuery(question) {
  if (!isRecord(question)) throw failure('INVALID_QUESTION', '缺少可检索的公开题目或知识点。');
  // Deliberate field allowlist: no answer, explanation, follow-up or learning fields.
  const clean = value => typeof value === 'string' ? value.replace(/[\s\u0000-\u001f\u007f]+/gu, ' ').trim() : '';
  const take = (value, count) => Array.from(value).slice(0, count).join('');
  const stem = clean(question.stem);
  const knowledgePoint = take(clean(question.knowledgePoint), 48);
  const category = take(clean(question.category), 12);
  if (!stem && !knowledgePoint) throw failure('INVALID_QUESTION', '缺少可检索的公开题目或知识点。');
  // The official query limit is 128 Unicode characters. Short category and
  // knowledge-point budgets reserve room for the actual stem, including emoji.
  return take([category, knowledgePoint, stem].filter(Boolean).join(' '), 128);
}

function sourceText(value, apiKey, limit, singleLine = false) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replaceAll(apiKey, '[已隐藏]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return (singleLine ? cleaned.replace(/\s+/gu, ' ') : cleaned).trim().slice(0, limit);
}

async function boundedJson(response, signal) {
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    try { await response.body?.cancel(); } catch {}
    throw failure('RESPONSE_TOO_LARGE', 'DeepSeek 检索返回内容超过安全上限，本轮已停止。');
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw failure('INVALID_RESPONSE', 'DeepSeek 检索返回了无法识别的内容。');
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw failure('RESPONSE_TOO_LARGE', 'DeepSeek 检索返回内容超过安全上限，本轮已停止。');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof RetrievalError) throw error;
    throw failure('INVALID_RESPONSE', 'DeepSeek 检索返回了无法识别的内容。');
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** At most one search and two fetches. Never fetches a source URL directly. */
export async function retrieveQuestionSources({ question, apiKey, fetchImpl = globalThis.fetch, signal, archive = false, onProgress } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.trim().length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey.trim())) {
    throw failure('MISSING_API_KEY', '请先配置 DeepSeek 官方 API Key，检索未发起。');
  }
  const key = apiKey.trim();
  const query = publicQuery(question);
  if (query.includes(key)) throw failure('INVALID_QUESTION', '检索内容与认证信息冲突，检索未发起。');
  if (typeof fetchImpl !== 'function') throw failure('UNAVAILABLE', '当前环境无法调用 DeepSeek 检索。');
  const cancelled = () => failure('CANCELLED', 'DeepSeek 检索已取消，本轮未生成解析。');
  if (signal?.aborted) throw cancelled();
  const totalController = new AbortController();
  const onCancel = () => totalController.abort(cancelled());
  signal?.addEventListener('abort', onCancel, { once: true });
  const totalTimer = setTimeout(() => totalController.abort(failure('TIMEOUT', 'DeepSeek 检索等待超时，本轮已停止且未自动重试。')), TOTAL_TIMEOUT_MS);
  const usage = { searchCalls: 0, fetchCalls: 0, estimatedCostCny: 0 };
  const archiveState = { query, searchResults: [], sources: [], skippedSources: [], sourceErrors: [], partial: false,
    contentPolicy: ARCHIVE_CONTENT_POLICY, usage };
  const preserve = value => {
    if (typeof value === 'string') return value.replaceAll(key, '[已隐藏]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (Array.isArray(value)) return value.map(preserve);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [preserve(name), preserve(item)]));
    return value;
  };
  const publish = phase => {
    usage.estimatedCostCny = Number(((usage.searchCalls + usage.fetchCalls) * TOOL_PRICE_CNY).toFixed(3));
    if (archive && typeof onProgress === 'function') onProgress(JSON.parse(JSON.stringify({ ...archiveState, phase })));
  };

  async function request(tool, body) {
    if (totalController.signal.aborted) throw totalController.signal.reason;
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const stop = error => { controller.abort(); rejectAbort(error); };
    const onTotalAbort = () => stop(totalController.signal.reason);
    totalController.signal.addEventListener('abort', onTotalAbort, { once: true });
    const timer = setTimeout(() => stop(failure('TIMEOUT', 'DeepSeek 检索等待超时，本轮已停止且未自动重试。')), REQUEST_TIMEOUT_MS);
    usage[tool === 'search' ? 'searchCalls' : 'fetchCalls']++;
    try {
      // Archive callers synchronously persist each send intent before the request.
      publish(`${tool}-request`);
      return await Promise.race([aborted, (async () => {
        const response = await fetchImpl(`${TOOL_ORIGIN}/${tool}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response?.ok) {
          const details = { upstreamStatus: response?.status, tool };
          const statusText = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? `（HTTP ${response.status}）` : '';
          if (tool === 'fetch' && response?.status === 403) throw failure('SOURCE_BLOCKED', `DeepSeek 拒绝抓取该来源${statusText}，该网页未取得正文。`, details);
          if (tool === 'fetch' && response?.status === 404) throw failure('SOURCE_NOT_FOUND', `DeepSeek 无法提取该来源正文${statusText}。`, details);
          if ([401, 403].includes(response?.status)) throw failure('AUTH_FAILED', `DeepSeek 检索认证失败${statusText}，请检查官方 API Key。`, details);
          if (response?.status === 402) throw failure('INSUFFICIENT_BALANCE', `DeepSeek 检索余额不足${statusText}，本轮已停止。`, details);
          if (response?.status === 429) throw failure('RATE_LIMITED', `DeepSeek 检索额度或速率受限${statusText}，本轮已停止且未自动重试。`, details);
          throw failure('UPSTREAM_FAILED', `DeepSeek 检索请求未成功${statusText}，请检查服务状态。`, details);
        }
        const data = await boundedJson(response, controller.signal);
        if (!isRecord(data) || data.error) throw failure('INVALID_RESPONSE', 'DeepSeek 检索返回了无法识别的内容。');
        return data;
      })()]);
    } catch (error) {
      if (error instanceof RetrievalError) { if (!error.tool) error.tool = tool; throw error; }
      if (totalController.signal.aborted) throw totalController.signal.reason;
      throw failure('CONNECTION_FAILED', 'DeepSeek 检索连接失败，本轮已停止且未自动重试。', { tool });
    } finally {
      clearTimeout(timer);
      totalController.signal.removeEventListener('abort', onTotalAbort);
      controller.abort();
    }
  }

  try {
    const search = await request('search', { query, count: 3, need_content: archive });
    if (!Array.isArray(search.results)) throw failure('INVALID_RESPONSE', 'DeepSeek 搜索返回了无法识别的结果。');
    if (archive) {
      archiveState.searchResults = preserve(search.results);
      archiveState.searchResultsEdited = JSON.stringify(archiveState.searchResults) !== JSON.stringify(search.results);
      publish('search-completed');
    }
    if (!search.results.length) throw failure('NO_RESULTS', 'DeepSeek 搜索未找到资料，本轮未生成解析。');
    const candidates = [];
    const seen = new Set();
    for (const [resultIndex, result] of search.results.slice(0, 3).entries()) {
      if (!isRecord(result)) continue;
      const url = publicSourceUrl(result.url, key);
      if (!url || seen.has(url)) continue;
      const candidate = { url, title: sourceText(result.title, key, 300, true) };
      let pathname = new URL(url).pathname;
      try { pathname = decodeURIComponent(pathname); } catch { /* Keep the literal pathname if encoding is malformed. */ }
      if (archive && typeof result.content === 'string') {
        const content = preserve(result.content);
        if (content.trim()) {
          candidate.searchContent = content;
          candidate.searchContentEdited = content !== result.content;
        }
      }
      if (archive && NON_WEB_EXTENSION.test(pathname)) {
        if (isPdfSourceUrl(url) && candidate.searchContent) {
          Object.assign(candidate, { sourceKind: 'document-extract', documentType: 'pdf', fetchSkipped: true,
            contentPolicy: PDF_EXTRACT_CONTENT_POLICY });
          archiveState.skippedSources.push({ url, title: candidate.title, reason: 'pdf-fetch-skipped',
            notice: '仅保留 Search 已返回的 PDF 文字摘录，未提交 Fetch，不代表完整 PDF。' });
        } else {
          archiveState.skippedSources.push({ url, title: candidate.title, reason: 'non-web-file', notice: '明显为非网页文件，未提交 Fetch。' });
          continue;
        }
      } else if (archive) candidate.sourceKind = 'web-page';
      if (archive) Object.assign(candidate, { resultIndex, originalUrl: result.url,
        originalFragment: result.url.includes('#') ? result.url.slice(result.url.indexOf('#') + 1) : '' });
      seen.add(url);
      candidates.push(candidate);
      if (candidates.length === 2) break;
    }
    if (archive) publish('sources-selected');
    if (!candidates.length) throw failure('NO_PUBLIC_SOURCES', 'DeepSeek 搜索未返回可用的公开网页，本轮未生成解析。');
    const sources = [];
    if (archive) {
      for (const candidate of candidates) if (candidate.searchContent) sources.push({
        id: `S${sources.length + 1}`, title: candidate.title || candidate.url, url: candidate.url,
        content: candidate.searchContent, contentOrigin: 'search', contentEdited: candidate.searchContentEdited,
        contentTruncated: false,
        sourceKind: candidate.sourceKind, resultIndex: candidate.resultIndex, originalUrl: candidate.originalUrl,
        originalFragment: candidate.originalFragment,
        ...(candidate.documentType ? { documentType: candidate.documentType, fetchSkipped: true, contentPolicy: candidate.contentPolicy } : {}),
      });
      archiveState.sources = sources;
      // Search's content is a document body. Snippets and summaries are never
      // promoted to sources, and all returned bodies are saved before Fetch.
      publish('search-content-saved');
    }
    let lastSourceError;
    for (const candidate of candidates) {
      if (archive && candidate.fetchSkipped) continue;
      if (archive && usage.fetchCalls >= 2) break;
      let fetched;
      try { fetched = await request('fetch', { url: candidate.url }); }
      catch (error) {
        const sourceUnavailable = ['SOURCE_BLOCKED', 'SOURCE_NOT_FOUND'].includes(error.code);
        const stopWithSearch = ['TIMEOUT', 'CONNECTION_FAILED'].includes(error.code) ||
          error.code === 'UPSTREAM_FAILED' && error.upstreamStatus >= 500 && error.upstreamStatus <= 599;
        const hasSearchContent = sources.some(source => source.contentOrigin === 'search');
        if (!archive || !sourceUnavailable && !(stopWithSearch && hasSearchContent)) throw error;
        lastSourceError = error;
        archiveState.sourceErrors.push({ url: candidate.url, title: candidate.title, code: error.code, error: error.message,
          ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}), tool: 'fetch' });
        archiveState.partial = true;
        publish('fetch-source-unavailable');
        // A transient Fetch failure never triggers another network request.
        // Only already saved Search document bodies can complete this run.
        if (stopWithSearch) break;
        continue;
      }
      const content = archive ? (typeof fetched.content === 'string' ? preserve(fetched.content) : '') : sourceText(fetched.content, key, MAX_SOURCE_CHARS);
      if (!content.trim()) throw failure('EMPTY_SOURCE', 'DeepSeek 未取得网页正文，本轮未生成解析。');
      const existing = archive ? sources.findIndex(source => source.url === candidate.url) : -1;
      const source = { id: existing >= 0 ? sources[existing].id : `S${sources.length + 1}`, title: sourceText(fetched.title, key, 300, true) || candidate.title || candidate.url,
        url: candidate.url, content,
        ...(archive ? { contentOrigin: 'fetch', contentEdited: content !== fetched.content, contentTruncated: false,
          sourceKind: 'web-page', resultIndex: candidate.resultIndex, originalUrl: candidate.originalUrl,
          originalFragment: candidate.originalFragment } : {}) };
      if (existing >= 0) sources[existing] = source;
      else sources.push(source);
      if (archive) { archiveState.sources = sources; publish('fetch-completed'); }
    }
    if (archive && !sources.length) throw lastSourceError ?? failure('NO_FETCHABLE_SOURCES', '本轮未取得可用网页正文；搜索与来源失败记录已保留。');
    usage.estimatedCostCny = Number(((usage.searchCalls + usage.fetchCalls) * TOOL_PRICE_CNY).toFixed(3));
    return { sources, usage, ...(archive ? { query, searchResults: archiveState.searchResults,
      searchResultsEdited: archiveState.searchResultsEdited, skippedSources: archiveState.skippedSources,
      sourceErrors: archiveState.sourceErrors, partial: archiveState.partial, contentPolicy: ARCHIVE_CONTENT_POLICY } : {}) };
  } finally {
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', onCancel);
  }
}
