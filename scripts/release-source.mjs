import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Reviewed files only. Never walk a working directory or copy Git history, banks,
// screenshots, model transcripts, local settings or a user's storage directory.
export const SOURCE_FILES = [
  '.gitignore', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md',
  'package.json', 'package-lock.json', 'tsconfig.json',
  'Start-Study.ps1', 'Stop-Study.ps1', '启动备考.cmd', '停止备考.cmd',
  '.github/workflows/verify.yml',
  'scripts/release-source.mjs', 'scripts/release-source.test.mjs',
  'study/README.md', 'study/data/README.md',
  'study/build.mjs', 'study/serve.mjs', 'study/runtime-config.mjs',
  'study/service-process.ps1', 'study/desktop-launcher.ps1', 'study/verify.mjs',
  'study/import-bank.mjs', 'study/index.html', 'study/main.ts', 'study/tsconfig.json',
  ...[
    'api.mjs', 'preanalysis.mjs', 'official-api.mjs', 'deepseek-retrieval.mjs', 'retrieval-archive.mjs', 'retrieval-recovery.mjs',
    'bridge-script.mjs', 'storage-lock.mjs', 'question-bank-import.mjs',
    'api.test.mjs', 'ai-correct-answer.test.mjs', 'ai-history.test.mjs', 'ai-retrieval.test.mjs',
    'answer-corrections.test.mjs', 'browser-ui-protocol.test.mjs',
    'bridge-provider.test.mjs', 'bridge.test.mjs', 'data-integrity.test.mjs',
    'deepseek-retrieval.test.mjs', 'retrieval-archive.test.mjs', 'retrieval-recovery.test.mjs', 'deployment.test.mjs', 'management-records.test.mjs',
    'official-api.test.mjs', 'official-preanalysis.test.mjs', 'preanalysis.test.mjs',
    'storage-lock.test.mjs', 'wrong-mastery.test.mjs', 'wrong-records.test.mjs',
    'question-bank-import.test.mjs',
  ].map(file => `study/server/${file}`),
  ...[
    'vitest.config.ts', 'vue-memory-host.ts', 'answer-correction-dialog.test.ts',
    'answer-corrections-store.test.ts', 'answer-grading-review.test.ts',
    'bridge-controller.test.ts', 'bridge-recovery.test.ts', 'correct-ai-explanation.test.ts',
    'management-records-backend-store.test.ts', 'management-records-store.test.ts',
    'management-selection.test.ts', 'preanalysis-components.test.ts', 'study-store-races.test.ts',
    'workspace-management.test.ts', 'wrong-mastery-selection.test.ts', 'wrong-mastery-store.test.ts',
    'wrong-record-selection.test.ts', 'wrong-records-store.test.ts',
  ].map(file => `study/client-tests/${file}`),
  'src/api/study/index.ts', 'src/api/study/types.ts',
  'src/store/modules/study.ts', 'src/store/modules/studyBridge.ts',
  'src/utils/studyGrading.ts',
  'src/views/study/StudyWorkspace.vue', 'src/views/study/StudyManagement.vue',
  'src/views/study/AnswerCorrectionDialog.vue',
  'src/views/study/components/PreparedExplanation.vue',
  'src/views/study/components/PreanalysisManager.vue',
].sort();

const sha256 = data => createHash('sha256').update(data).digest('hex');
const contains = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function readSource(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`发布源文件不能经过符号链接：${relative}`);
  }
  if (!fs.statSync(current).isFile()) throw new Error(`发布源文件不是普通文件：${relative}`);
  const data = fs.readFileSync(current);
  const text = data.toString('utf8');
  // Report only a path. Never print a matched credential or source line.
  if (/(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text)) {
    throw new Error(`疑似真实密钥，发布已阻止：${relative}`);
  }
  if (/[A-Z]:[\\/]+Users[\\/]+[^\\/\s]+[\\/]/i.test(text)) throw new Error(`发现本机用户绝对路径，发布已阻止：${relative}`);
  return data;
}

function publicPackage(original) {
  const result = { ...original };
  delete result.repository;
  delete result.author;
  result.private = true; // This is an application repository, not an npm upload.
  result.scripts = {
    build: 'node study/build.mjs',
    'build:study': 'node study/build.mjs',
    start: 'node study/serve.mjs',
    study: 'node study/serve.mjs',
    test: 'node study/verify.mjs',
    'test:study': 'node study/verify.mjs',
    'test:study:client': 'node node_modules/vitest/vitest.mjs run --config study/client-tests/vitest.config.ts',
    'verify:study': 'node study/verify.mjs',
    'release:source': 'node scripts/release-source.mjs',
    'release:check': 'node scripts/release-source.mjs --check',
  };
  return result;
}

export function collectReleaseFiles(root = projectRoot) {
  const files = new Map(SOURCE_FILES.map(relative => [relative, readSource(root, relative)]));
  const pkg = JSON.parse(files.get('package.json'));
  const lock = JSON.parse(files.get('package-lock.json'));
  const lockRoot = lock.packages?.[''];
  for (const field of ['name', 'version', 'dependencies', 'devDependencies', 'engines']) {
    if (JSON.stringify(pkg[field]) !== JSON.stringify(lockRoot?.[field])) throw new Error(`package-lock 与 package 不一致：${field}`);
  }
  files.set('package.json', Buffer.from(`${JSON.stringify(publicPackage(pkg), null, 2)}\n`));
  // Keep the tested dependencies and their exact integrity-pinned lock unchanged.
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name || !entry.resolved) continue;
    if (!entry.resolved.startsWith('https://registry.npmjs.org/') || !entry.integrity) throw new Error(`锁文件包含未核验的依赖来源：${name}`);
  }
  const manifest = {
    format: 1, project: '备考', includesQuestionBank: false, includesPrivateData: false,
    files: [...files].map(([name, data]) => ({ path: name, bytes: data.length, sha256: sha256(data) })),
  };
  files.set('RELEASE-MANIFEST.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return files;
}

// Small dependency-free ZIP writer. UTF-8 paths, fixed timestamp, compression and
// CRC make the reviewed file set portable and reproducible on every platform.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
export function sourceZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const encoded = Buffer.from(`beikao/${name}`), compressed = deflateRawSync(data);
    const crc = crc32(data), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x5021, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(encoded.length, 26);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(0x5021, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(encoded.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, encoded, compressed); central.push(directory, encoded);
    offset += header.length + encoded.length + compressed.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

export function writeRelease(root, destination) {
  root = fs.realpathSync(root);
  destination = path.resolve(destination);
  const outputRoot = path.join(root, 'artifacts');
  // Output is intentionally confined to an ignored directory. No overwrite,
  // recursive cleanup or outside-workspace path can affect a working checkout.
  if (!contains(outputRoot, destination) || destination === outputRoot) throw new Error('发布目录必须位于本项目 artifacts 的新子目录内。');
  for (let current = path.dirname(destination); contains(root, current); current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('发布目录不能经过符号链接。');
    if (current === root) break;
  }
  const zipPath = `${destination}.zip`;
  if (fs.existsSync(destination) || fs.existsSync(zipPath)) throw new Error('发布目录或 ZIP 已存在，请使用新的目录名。');
  const files = collectReleaseFiles(root);
  const zip = sourceZip(files);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(destination);
  for (const [relative, data] of files) {
    const file = path.join(destination, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, { flag: 'wx' });
  }
  fs.writeFileSync(zipPath, zip, { flag: 'wx' });
  return { directory: destination, zip: zipPath, files: files.size, sha256: sha256(zip) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1) throw new Error('用法：node scripts/release-source.mjs [--check | artifacts/新目录名]');
    if (args[0] === '--check') {
      const files = collectReleaseFiles();
      console.log(`无题库源码检查通过：${files.size} 个文件；未读取私人数据或题库。`);
    } else {
      if (args[0]?.startsWith('-')) throw new Error('未知发布参数。');
      const destination = path.resolve(projectRoot, args[0] || `artifacts/beikao-source-${new Date().toISOString().replace(/[-:.]/g, '')}`);
      console.log(JSON.stringify(writeRelease(projectRoot, destination), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
