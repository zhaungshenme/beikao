import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createStudyApi } from './server/api.mjs';
import { acquireStorageLock } from './server/storage-lock.mjs';
import { assertNodeVersion, resolveRuntimeConfig } from './runtime-config.mjs';
import { localRequestOrigin } from './server/bridge-script.mjs';
import { randomUUID } from 'node:crypto';

const studyDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(studyDir);
const dist = path.join(root, 'study-dist');
assertNodeVersion();
const { host, port, dataDir, url } = resolveRuntimeConfig();
const serviceFile = path.join(dataDir, 'service.json');
const instanceId = randomUUID();
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
const indexFile = path.join(dist, 'study/index.html');
if (!fs.existsSync(indexFile)) throw new Error('页面尚未构建，请先运行 npm run build:study。');
const releaseStorage = acquireStorageLock(dataDir);
let api;
try { api = createStudyApi({ dataDir, questionsPath: path.join(studyDir, 'data/questions.json'), preparedExplanationsPath: path.join(studyDir, 'data/prepared-explanations.json'), activeProvider: 'zhipu' }); }
catch (error) { releaseStorage(); throw error; }
process.on('exit', releaseStorage);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  const origin = localRequestOrigin(req.headers.host, port);
  if (!origin) { res.writeHead(403); res.end('Local access only'); return; }
  if (req.url?.startsWith('/study-api/')) { api.handle(req, res); return; }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch { res.writeHead(400); res.end(); return; }
  if (pathname === '/') { res.writeHead(302, { Location: '/study/' }); res.end(); return; }
  let file;
  if (pathname === '/bridge/Study-Bridge.user.js' || pathname === '/bridge/' || pathname === '/bridge') {
    res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : '网页版解析链路已停用。请打开 /study/ 阅读已保存讲解；需要网页资料时可在学习设置中配置 DeepSeek Search／Fetch。');
    return;
  }
  else {
    file = path.resolve(dist, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
    if (!file.startsWith(`${dist}${path.sep}`)) { res.writeHead(403); res.end(); return; }
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('页面尚未构建，请先运行 node study/build.mjs'); return; }
  res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', path.extname(file) === '.html' || pathname.startsWith('/bridge') ? 'no-store' : 'public,max-age=3600');
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});
server.listen(port, host, () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(serviceFile, JSON.stringify({ pid: process.pid, host, port, url, instanceId, processStartedAt, script: fileURLToPath(import.meta.url), startedAt: new Date().toISOString(), running: true }, null, 2));
  console.log(`备考学习服务已启动：${url}`);
  console.log(`学习记录目录：${dataDir}；服务只监听本机。`);
});
function markStopped() {
  try {
    const service = JSON.parse(fs.readFileSync(serviceFile, 'utf8'));
    if (service.instanceId === instanceId) fs.writeFileSync(serviceFile, JSON.stringify({ ...service, running: false, stoppedAt: new Date().toISOString() }, null, 2));
  } catch (error) { if (error.code !== 'ENOENT') console.error('未能更新服务停止记录。'); }
}
server.on('error', error => { api.close(); releaseStorage(); console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请先检查已有服务。` : error.message); process.exitCode = 1; });
server.on('close', () => api.close());
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { api.close(); server.close(() => { markStopped(); releaseStorage(); process.exit(0); }); });
