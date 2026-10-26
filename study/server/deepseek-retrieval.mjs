import { isIP } from 'node:net';

const TOOL_ORIGIN = 'https://api.deepseek.com/v1/tools';
const REQUEST_TIMEOUT_MS = 10000;
const TOTAL_TIMEOUT_MS = 25000;
const MAX_RESPONSE_BYTES = 262144;
const MAX_SOURCE_CHARS = 6000;
const TOOL_PRICE_CNY = 0.005;

class RetrievalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeepSeekRetrievalError';
    this.code = code;
  }
}
const failure = (code, message) => new RetrievalError(code, message);
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

function publicSourceUrl(value, apiKey) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value) || value.includes(apiKey)) return null;
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
export async function retrieveQuestionSources({ question, apiKey, fetchImpl = globalThis.fetch, signal } = {}) {
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
      return await Promise.race([aborted, (async () => {
        const response = await fetchImpl(`${TOOL_ORIGIN}/${tool}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response?.ok) {
          if ([401, 403].includes(response?.status)) throw failure('AUTH_FAILED', 'DeepSeek 检索认证失败，请检查官方 API Key。');
          if (response?.status === 402) throw failure('INSUFFICIENT_BALANCE', 'DeepSeek 检索余额不足，本轮已停止。');
          if (response?.status === 429) throw failure('RATE_LIMITED', 'DeepSeek 检索额度或速率受限，本轮已停止且未自动重试。');
          throw failure('UPSTREAM_FAILED', 'DeepSeek 检索请求未成功，请检查服务状态。');
        }
        const data = await boundedJson(response, controller.signal);
        if (!isRecord(data) || data.error) throw failure('INVALID_RESPONSE', 'DeepSeek 检索返回了无法识别的内容。');
        return data;
      })()]);
    } catch (error) {
      if (error instanceof RetrievalError) throw error;
      if (totalController.signal.aborted) throw totalController.signal.reason;
      throw failure('CONNECTION_FAILED', 'DeepSeek 检索连接失败，本轮已停止且未自动重试。');
    } finally {
      clearTimeout(timer);
      totalController.signal.removeEventListener('abort', onTotalAbort);
      controller.abort();
    }
  }

  try {
    const search = await request('search', { query, count: 3, need_content: false });
    if (!Array.isArray(search.results)) throw failure('INVALID_RESPONSE', 'DeepSeek 搜索返回了无法识别的结果。');
    if (!search.results.length) throw failure('NO_RESULTS', 'DeepSeek 搜索未找到资料，本轮未生成解析。');
    const candidates = [];
    const seen = new Set();
    for (const result of search.results.slice(0, 3)) {
      if (!isRecord(result)) continue;
      const url = publicSourceUrl(result.url, key);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      candidates.push({ url, title: sourceText(result.title, key, 300, true) });
      if (candidates.length === 2) break;
    }
    if (!candidates.length) throw failure('NO_PUBLIC_SOURCES', 'DeepSeek 搜索未返回可用的公开网页，本轮未生成解析。');
    const sources = [];
    for (const candidate of candidates) {
      const fetched = await request('fetch', { url: candidate.url });
      const content = sourceText(fetched.content, key, MAX_SOURCE_CHARS);
      if (!content) throw failure('EMPTY_SOURCE', 'DeepSeek 未取得网页正文，本轮未生成解析。');
      sources.push({ id: `S${sources.length + 1}`, title: sourceText(fetched.title, key, 300, true) || candidate.title || candidate.url,
        url: candidate.url, content });
    }
    usage.estimatedCostCny = Number(((usage.searchCalls + usage.fetchCalls) * TOOL_PRICE_CNY).toFixed(3));
    return { sources, usage };
  } finally {
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', onCancel);
  }
}
