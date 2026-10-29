import { createHash } from 'node:crypto';
import { isPdfSourceUrl, publicSourceUrl, PDF_EXTRACT_CONTENT_POLICY } from './deepseek-retrieval.mjs';

/** A read-only view of already saved Search document extracts, never a request. */
export function deriveSavedSearchTextRecovery(parentBytes) {
  if (!(parentBytes instanceof Uint8Array)) throw new TypeError('恢复视图需要原档案文件字节。');
  const parent = JSON.parse(Buffer.from(parentBytes).toString('utf8'));
  if (parent?.version !== 1 || parent.status !== 'failed' || parent.modelRequested !== false ||
      typeof parent.id !== 'string' || !parent.id || typeof parent.requestId !== 'string' || !parent.requestId ||
      typeof parent.questionId !== 'string' || !parent.questionId || !/^[a-f0-9]{64}$/.test(parent.questionFingerprint) ||
      !Number.isSafeInteger(parent.questionRevision) || !Array.isArray(parent.searchResults) || !Array.isArray(parent.sources)) return undefined;
  const slots = Math.max(0, 2 - parent.sources.length);
  if (!slots) return undefined;
  const seen = new Set(parent.sources.map(source => publicSourceUrl(source?.url)).filter(Boolean));
  const sources = [];
  for (const [resultIndex, result] of parent.searchResults.slice(0, 3).entries()) {
    if (!result || typeof result !== 'object') continue;
    const url = publicSourceUrl(result.url);
    if (!url || !isPdfSourceUrl(url) || seen.has(url) || typeof result.content !== 'string' || !result.content.trim()) continue;
    // The parent already stored the official Search content, not a snippet or
    // summary. Retain it and its exact fragment provenance without joining it
    // to another result for the same PDF.
    seen.add(url);
    sources.push({ id: `R${sources.length + 1}`, title: typeof result.title === 'string' && result.title.trim() ? result.title : url,
      url, content: result.content, contentOrigin: 'search', sourceKind: 'document-extract', documentType: 'pdf',
      fetchSkipped: true, contentTruncated: false, contentEdited: parent.searchResultsEdited === true,
      resultIndex, originalUrl: result.url,
      originalFragment: result.url.includes('#') ? result.url.slice(result.url.indexOf('#') + 1) : '',
      contentPolicy: PDF_EXTRACT_CONTENT_POLICY });
    if (sources.length >= slots) break;
  }
  if (!sources.length) return undefined;
  const parentArchiveSha256 = createHash('sha256').update(parentBytes).digest('hex');
  return { id: `saved-search-text:${parentArchiveSha256}`, kind: 'saved-search-text', parentArchiveId: parent.id,
    parentArchiveSha256, networkRequested: false, modelRequested: false, sourceCount: sources.length, sources };
}
