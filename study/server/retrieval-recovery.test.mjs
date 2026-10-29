import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveSavedSearchTextRecovery } from './retrieval-recovery.mjs';
import { publicSourceUrl, PDF_EXTRACT_CONTENT_POLICY } from './deepseek-retrieval.mjs';

const PDF_A = 'https://www.python.org/reference.pdf';
const PDF_B = 'https://www.sqlite.org/notes%2EPDF';
const PDF_C = 'https://developer.mozilla.org/extra.pdf';
const parent = overrides => ({ version: 1, id: 'failed-parent-id', requestId: 'saved-request-id', questionId: 'fixture-question',
  questionFingerprint: 'a'.repeat(64), questionRevision: 0, status: 'failed', modelRequested: false,
  createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
  errorCode: 'NO_PUBLIC_SOURCES', error: '原失败状态保留', sources: [],
  searchResults: [{ url: `${PDF_A}#page=2`, title: '原PDF标题', content: '  原始Search PDF文字\n  ' }],
  ...overrides });
const bytes = value => Buffer.from(JSON.stringify(value));

test('恢复只派生已存Search PDF摘录，保留完整原文与片段来源且不改父对象', () => {
  const entry = parent();
  const original = structuredClone(entry);
  const buffer = bytes(entry);
  const originalBytes = Buffer.from(buffer);
  const recovery = deriveSavedSearchTextRecovery(buffer);
  assert.equal(recovery.kind, 'saved-search-text');
  assert.equal(recovery.parentArchiveId, entry.id);
  assert.equal(recovery.networkRequested, false); assert.equal(recovery.modelRequested, false);
  assert.equal(recovery.sourceCount, 1);
  assert.deepEqual(recovery.sources, [{ id: 'R1', title: '原PDF标题', url: PDF_A, content: entry.searchResults[0].content,
    contentOrigin: 'search', sourceKind: 'document-extract', documentType: 'pdf', fetchSkipped: true,
    contentTruncated: false, contentEdited: false, resultIndex: 0, originalUrl: `${PDF_A}#page=2`, originalFragment: 'page=2',
    contentPolicy: PDF_EXTRACT_CONTENT_POLICY }]);
  assert.ok(!JSON.stringify(recovery).includes('createdAt')); assert.ok(!JSON.stringify(recovery).includes('updatedAt'));
  assert.deepEqual(entry, original); assert.deepEqual(buffer, originalBytes);
});

test('父SHA来自实际文件字节，同一JSON不同空白不共享恢复身份', () => {
  const a = bytes(parent());
  const b = Buffer.from(`\n${JSON.stringify(parent(), null, 2)}\n`);
  const aRecovery = deriveSavedSearchTextRecovery(a);
  const bRecovery = deriveSavedSearchTextRecovery(b);
  assert.equal(aRecovery.parentArchiveSha256, createHash('sha256').update(a).digest('hex'));
  assert.equal(bRecovery.parentArchiveSha256, createHash('sha256').update(b).digest('hex'));
  assert.notEqual(aRecovery.id, bRecovery.id);
  assert.equal(aRecovery.id, `saved-search-text:${aRecovery.parentArchiveSha256}`);
});

test('只有有效无模型failed父档案可派生，不把其他状态或损坏身份变成来源', () => {
  for (const overrides of [{ status: 'completed' }, { status: 'running' }, { status: 'unknown' },
    { version: 2 }, { id: '' }, { requestId: null }, { questionId: '' }, { questionFingerprint: 'bad' },
    { questionRevision: 0.5 }, { modelRequested: true }, { modelRequested: undefined }, { sources: null }, { searchResults: null }]) {
    assert.equal(deriveSavedSearchTextRecovery(bytes(parent(overrides))), undefined, JSON.stringify(overrides));
  }
  for (const value of [undefined, null, {}, '', new ArrayBuffer(5)]) {
    assert.throws(() => deriveSavedSearchTextRecovery(value), TypeError);
  }
});

test('无key校验仍接受公开URL并拒绝本机私网危险协议及带凭据地址', () => {
  assert.equal(publicSourceUrl(`${PDF_A}#page=1`), PDF_A);
  for (const url of ['http://localhost/a.pdf', 'http://127.0.0.1/a.pdf', 'http://10.2.3.4/a.pdf',
    'http://192.168.1.1/a.pdf', 'http://169.254.169.254/a.pdf', 'http://[::1]/a.pdf',
    'file:///tmp/a.pdf', 'ftp://www.python.org/a.pdf', 'https://user:pass@www.python.org/a.pdf',
    'https://intranet/a.pdf', 'https://host.local/a.pdf']) {
    assert.equal(publicSourceUrl(url), null, url);
    assert.equal(deriveSavedSearchTextRecovery(bytes(parent({ searchResults: [{ url, content: 'text' }] }))), undefined, url);
  }
});

test('仅content可作正文，摘要、HTML及其他二进制即便有文字也不恢复', () => {
  for (const result of [{ url: PDF_A, snippet: '摘要' }, { url: PDF_A, summary: '摘要' }, { url: PDF_A, content: ' \n ' },
    { url: PDF_A, content: { text: '对象不是正文' } }, { url: 'https://www.python.org/a.html', content: 'HTML不属PDF恢复' },
    { url: 'https://www.python.org/a.png', content: '图片' }, { url: 'https://www.python.org/a.zip', content: '压缩包' },
    { url: 'https://www.python.org/a.exe', content: '可执行文件' }]) {
    assert.equal(deriveSavedSearchTextRecovery(bytes(parent({ searchResults: [result] }))), undefined);
  }
});

test('最多两份唯一来源并计入原sources，只用首个有效片段而不拼接', () => {
  const recovery = deriveSavedSearchTextRecovery(bytes(parent({ searchResults: [
    { url: `${PDF_A}#page=1`, content: '第一片段' }, { url: `${PDF_A}#page=2`, content: '不得拼接的第二片段' },
    { url: `${PDF_B}#page=3`, content: '第二份PDF' }, { url: PDF_C, content: '不得检查第四条' },
  ] })));
  assert.equal(recovery.sourceCount, 2); assert.deepEqual(recovery.sources.map(source => source.content), ['第一片段', '第二份PDF']);
  assert.deepEqual(recovery.sources.map(source => source.resultIndex), [0, 2]);
  const limited = deriveSavedSearchTextRecovery(bytes(parent({ sources: [{ url: `${PDF_A}#old`, content: '原来源' }],
    searchResults: [{ url: PDF_A, content: '重复原来源' }, { url: PDF_B, content: '剩余一份' }, { url: PDF_C, content: '超出预算' }] })));
  assert.equal(limited.sourceCount, 1); assert.equal(limited.sources[0].url, PDF_B);
  assert.equal(deriveSavedSearchTextRecovery(bytes(parent({ sources: [{ url: PDF_A }, { url: PDF_B }] }))), undefined);
});

test('第一个空片段不占用PDF身份，保留后续首个有效正文的完整来源', () => {
  const recovery = deriveSavedSearchTextRecovery(bytes(parent({ searchResultsEdited: true, searchResults: [
    { url: `${PDF_A}#empty`, content: '' }, { url: `${PDF_A}#%70age=2`, content: '  首个有效正文\n' },
    { url: `${PDF_A}#later`, content: '不拼接' },
  ] })));
  assert.equal(recovery.sourceCount, 1); assert.equal(recovery.sources[0].resultIndex, 1);
  assert.equal(recovery.sources[0].originalFragment, '%70age=2');
  assert.equal(recovery.sources[0].content, '  首个有效正文\n'); assert.equal(recovery.sources[0].contentEdited, true);
});
