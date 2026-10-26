import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { closeSync, openSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { projectRoot, resolveRuntimeConfig, assertNodeVersion } from '../runtime-config.mjs';
import { localRequestOrigin, renderBridgeScript } from './bridge-script.mjs';

const template = `// ==UserScript==
// @namespace    https://yankao.local/study
// @updateURL    http://127.0.0.1:18103/bridge/Study-Bridge.user.js
// @downloadURL  http://127.0.0.1:18103/bridge/Study-Bridge.user.js
// @match        http://127.0.0.1:18103/*
// @match        http://localhost:18103/*
// @match        https://chatglm.cn/*
// ==/UserScript==
const LOCAL_ORIGIN = 'http://127.0.0.1:18103'; // yankao-service-origin
`;

test('runtime configuration is local-only and relative to its checkout', () => {
  const config = resolveRuntimeConfig({}, projectRoot);
  assert.equal(config.port, 18103);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.dataDir, path.join(projectRoot, 'study/storage'));
  assert.deepEqual(resolveRuntimeConfig({ STUDY_HOST: 'localhost', STUDY_PORT: '18104', STUDY_DATA_DIR: 'my data' }, projectRoot), {
    host: 'localhost', port: 18104, dataDir: path.join(projectRoot, 'my data'), origin: 'http://localhost:18104', url: 'http://localhost:18104/study/',
  });
  assert.equal(resolveRuntimeConfig({ STUDY_PORT: '80' }, projectRoot).origin, 'http://127.0.0.1');
  for (const port of ['', '0', '-1', '65536', '18103.5', '1e3', '18103x']) assert.throws(() => resolveRuntimeConfig({ STUDY_PORT: port }, projectRoot));
  for (const host of ['', '0.0.0.0', '::', '192.168.1.1', '127.0.0.1.evil.test']) assert.throws(() => resolveRuntimeConfig({ STUDY_HOST: host }, projectRoot));
  assert.throws(() => resolveRuntimeConfig({ STUDY_DATA_DIR: ' ' }, projectRoot));
  assert.throws(() => resolveRuntimeConfig({ STUDY_DATA_DIR: 'study-dist' }, projectRoot));
  assert.throws(() => resolveRuntimeConfig({ STUDY_DATA_DIR: 'study-dist/study/private' }, projectRoot));
  assert.throws(() => resolveRuntimeConfig({ STUDY_DATA_DIR: 'study/data' }, projectRoot));
  assert.throws(() => resolveRuntimeConfig({ STUDY_DATA_DIR: 'study/bridge/private' }, projectRoot));
  assert.equal(resolveRuntimeConfig({ STUDY_DATA_DIR: 'study-dist-backup' }, projectRoot).dataDir, path.join(projectRoot, 'study-dist-backup'));
  for (const version of ['18.20.0', '20.18.3', '21.7.3', '22.11.0']) assert.throws(() => assertNodeVersion(version));
  for (const version of ['20.19.0', '22.12.0', '24.0.0']) assert.doesNotThrow(() => assertNodeVersion(version));
});

test('published bridge script is scoped to the exact validated local instance', () => {
  for (const origin of ['http://127.0.0.1:18104', 'http://localhost:18104']) {
    const output = renderBridgeScript(template.replaceAll('\n', '\r\n'), origin);
    assert.ok(output.includes(`const LOCAL_ORIGIN = '${origin}';`));
    assert.ok(output.includes(`@namespace    ${origin}/study/bridge`));
    assert.equal((output.match(/@match\s+http:\/\//g) ?? []).length, 1);
    assert.ok(output.includes(`@match        ${origin}/*`));
    assert.ok(output.includes('@match        https://chatglm.cn/*'));
    assert.equal((output.match(new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bridge/Study-Bridge\\.user\\.js`, 'g')) ?? []).length, 2);
    assert.ok(!output.includes('18103'));
    assert.doesNotThrow(() => new Function(output));
  }
  assert.throws(() => renderBridgeScript(template, 'https://evil.test'));
  assert.throws(() => renderBridgeScript(template + template, 'http://127.0.0.1:18104'));
  assert.throws(() => renderBridgeScript(template.replace('@downloadURL', '@unused'), 'http://127.0.0.1:18104'));
  assert.throws(() => renderBridgeScript(template.replace('@namespace', '@unused'), 'http://127.0.0.1:18104'));
  assert.equal(localRequestOrigin('localhost:18104', 18104), 'http://localhost:18104');
  assert.equal(localRequestOrigin('127.0.0.1', 80), 'http://127.0.0.1');
  for (const host of ['evil.test:18104', 'localhost:18103', 'localhost:18104@evil.test', '127.0.0.1:18104\r\nx:x']) assert.equal(localRequestOrigin(host, 18104), null);
});

test('the historical userscript satisfies the dynamic publication contract', { skip: !existsSync(path.join(projectRoot, 'study/bridge/Study-Bridge.user.js')) }, async () => {
  const source = await fs.readFile(path.join(projectRoot, 'study/bridge/Study-Bridge.user.js'), 'utf8');
  const rendered = renderBridgeScript(source, 'http://localhost:18104');
  assert.ok(rendered.includes('@namespace    http://localhost:18104/study/bridge'));
  assert.ok(rendered.includes('@match        https://chatglm.cn/*'));
  assert.ok(rendered.includes('@match        https://chat.deepseek.com/*'));
  assert.ok(!rendered.includes('http://127.0.0.1:18103'));
  assert.doesNotThrow(() => new Function(rendered));
});

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yankao 中文 clean checkout '));
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.mkdir(path.join(directory, 'study/server'), { recursive: true });
  await fs.mkdir(path.join(directory, 'study/bridge'), { recursive: true });
  await fs.mkdir(path.join(directory, 'study-dist/study'), { recursive: true });
  for (const file of ['study/serve.mjs', 'study/runtime-config.mjs', 'study/server/storage-lock.mjs', 'study/server/bridge-script.mjs', 'study/service-process.ps1', 'Start-Study.ps1', 'Stop-Study.ps1']) {
    await fs.copyFile(path.join(projectRoot, file), path.join(directory, file));
  }
  await fs.writeFile(path.join(directory, 'study-dist/study/index.html'), '<!doctype html><title>clean fixture</title>');
  await fs.writeFile(path.join(directory, 'study/bridge/index.html'), '<a href="./Study-Bridge.user.js">install</a>');
  await fs.writeFile(path.join(directory, 'study/bridge/Study-Bridge.user.js'), template);
  // A local mock deliberately replaces the whole API module: no production data,
  // keys, settings, provider adapters or model requests are reachable in this test.
  await fs.writeFile(path.join(directory, 'study/server/api.mjs'), `export function createStudyApi({dataDir}) { return { handle(req,res){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({mock:true,status:'idle',dataDir}));}, close(){} }; }`);
  await fs.writeFile(path.join(directory, 'study/build.mjs'), `import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');fs.mkdirSync(path.join(root,'study-dist/study'),{recursive:true});fs.writeFileSync(path.join(root,'study-dist/study/index.html'),'<!doctype html><title>built fixture</title>');`);
  return directory;
}

function request(port, pathname, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname, agent: false, headers: { Host: host } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('fixture timeout'))); req.on('error', reject);
  });
}

async function waitForService(port) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await request(port, '/study-api/bridge/status')).status === 200) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('mock service did not start');
}

test('relocated clean checkout creates only configured data and retires web-helper installation', async t => {
  const directory = await fixture(t);
  const port = await freePort();
  const env = { ...process.env, STUDY_HOST: '127.0.0.1', STUDY_PORT: String(port), STUDY_DATA_DIR: 'runtime data' };
  const child = spawn(process.execPath, [path.join(directory, 'study/serve.mjs')], { cwd: os.tmpdir(), env, stdio: 'ignore', windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await waitForService(port);
  const status = await request(port, '/study-api/bridge/status');
  assert.equal(JSON.parse(status.body).dataDir, path.join(directory, 'runtime data'));
  assert.equal(JSON.parse(status.body).status, 'idle');
  assert.equal(await fs.stat(path.join(directory, 'study/storage')).catch(() => null), null);
  assert.equal((await request(port, '/study/')).status, 200);
  assert.equal((await request(port, '/study-api/bridge/status', 'evil.test:' + port)).status, 403);
  assert.equal((await request(port, '/study-api/bridge/status', '127.0.0.1:18103')).status, 403);
  const script = await request(port, '/bridge/Study-Bridge.user.js', 'localhost:' + port);
  assert.equal(script.status, 410);
  assert.equal(script.headers['cache-control'], 'no-store');
  assert.ok(script.body.includes('网页版解析链路已停用'));
  assert.equal((await request(port, '/bridge/')).status, 410);
  assert.ok(!script.body.includes('const LOCAL_ORIGIN'));
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'runtime data/service.json'), 'utf8'));
  assert.equal(metadata.pid, child.pid);
  assert.equal(metadata.port, port);
  assert.equal(metadata.running, true);
  assert.ok(metadata.instanceId && metadata.processStartedAt);
  assert.equal((await request(port, '/study/storage/service.json')).status, 404);
});

test('Windows launcher uses configured directory and refuses stale process identity', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const directory = await fixture(t);
  const port = await freePort();
  const env = { ...process.env, STUDY_HOST: '127.0.0.1', STUDY_PORT: String(port), STUDY_DATA_DIR: 'runtime data' };
  const shell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe';
  const run = script => spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, script), '-NodePath', process.execPath], { cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  // ExecutionPolicy Bypass is limited to this synthetic test child, never persisted.
  t.after(async () => {
    run('Stop-Study.ps1');
    await fs.rm(directory, { recursive: true, force: true });
  });
  const started = run('Start-Study.ps1');
  assert.equal(started.status, 0, started.stderr + started.stdout);
  await waitForService(port);
  assert.equal(run('Start-Study.ps1').status, 0);
  const serviceFile = path.join(directory, 'runtime data/service.json');
  const metadata = JSON.parse((await fs.readFile(serviceFile, 'utf8')).replace(/^\uFEFF/, ''));
  await fs.writeFile(serviceFile, JSON.stringify({ ...metadata, processStartedAt: '1970-01-01T00:00:00.000Z' }));
  assert.equal(run('Stop-Study.ps1').status, 0);
  assert.equal((await request(port, '/study/')).status, 200, 'stale metadata must not stop even a matching script');
  await fs.writeFile(serviceFile, JSON.stringify(metadata));
  const stopped = run('Stop-Study.ps1');
  assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
  const end = JSON.parse((await fs.readFile(serviceFile, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(end.running, false);
});

test('double-click commands work from another directory, reuse the service, and fail without installing dependencies', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const directory = await fixture(t);
  for (const file of ['study/desktop-launcher.ps1', '启动备考.cmd', '停止备考.cmd']) {
    await fs.copyFile(path.join(projectRoot, file), path.join(directory, file));
  }
  const port = await freePort();
  const env = { ...process.env, STUDY_HOST: '127.0.0.1', STUDY_PORT: String(port), STUDY_DATA_DIR: 'runtime 中文 data' };
  const shell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32/cmd.exe') : 'cmd.exe';
  const stdinPath = path.join(directory, 'command-input.txt');
  await fs.writeFile(stdinPath, '\r\n');
  let invocation = 0;
  const run = (script, nodePath = process.execPath) => {
    const stdoutPath = path.join(directory, `command-${++invocation}.stdout`);
    const stderrPath = path.join(directory, `command-${invocation}.stderr`);
    const stdin = openSync(stdinPath, 'r');
    const stdout = openSync(stdoutPath, 'w');
    const stderr = openSync(stderrPath, 'w');
    let result;
    try {
      // A background Windows service may inherit handles from cmd.exe. Files
      // let this check wait for cmd's exit without waiting for a pipe EOF.
      result = spawnSync(shell, ['/d', '/s', '/c', `""${path.join(directory, script)}" -NodePath "${nodePath}" -NoBrowser"`], {
        cwd: os.tmpdir(), env, stdio: [stdin, stdout, stderr], timeout: 30000, windowsHide: true, windowsVerbatimArguments: true,
      });
    } finally {
      closeSync(stdin);
      closeSync(stdout);
      closeSync(stderr);
    }
    return { ...result, stdout: readFileSync(stdoutPath, 'utf8'), stderr: readFileSync(stderrPath, 'utf8') };
  };
  // Both commands run only against the synthetic checkout and mock API. An
  // Enter satisfies the visible error pause; no dependency installer is run.
  t.after(async () => {
    run('停止备考.cmd');
    await fs.rm(directory, { recursive: true, force: true });
  });
  const serviceFile = path.join(directory, 'runtime 中文 data/service.json');
  const missingDependencies = run('启动备考.cmd');
  assert.equal(missingDependencies.status, 1, missingDependencies.stderr + missingDependencies.stdout);
  assert.match(missingDependencies.stdout + missingDependencies.stderr, /npm\s+ci/);
  assert.equal(await fs.stat(path.join(directory, 'node_modules')).catch(() => null), null);
  assert.equal(await fs.stat(serviceFile).catch(() => null), null);
  assert.match(await fs.readFile(path.join(directory, 'study-dist/study/index.html'), 'utf8'), /clean fixture/);
  for (const dependency of ['vite', 'vue']) {
    await fs.mkdir(path.join(directory, 'node_modules', dependency), { recursive: true });
    await fs.writeFile(path.join(directory, 'node_modules', dependency, 'package.json'), '{}');
  }
  const missingNode = run('启动备考.cmd', path.join(directory, 'missing node.exe'));
  assert.equal(missingNode.status, 1, missingNode.stderr + missingNode.stdout);
  assert.equal(await fs.stat(serviceFile).catch(() => null), null);
  const started = run('启动备考.cmd');
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.equal((await request(port, '/study/')).status, 200);
  const metadata = JSON.parse((await fs.readFile(serviceFile, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(metadata.port, port);
  assert.equal(metadata.url, `http://127.0.0.1:${port}/study/`);
  assert.equal(metadata.running, true);
  assert.ok(metadata.pid > 0);
  assert.equal(await fs.stat(path.join(directory, 'study/storage')).catch(() => null), null);
  const reused = run('启动备考.cmd');
  assert.equal(reused.status, 0, reused.stderr + reused.stdout);
  const repeated = JSON.parse((await fs.readFile(serviceFile, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(repeated.pid, metadata.pid, 'double-clicking again must reuse the same service');
  const stopped = run('停止备考.cmd');
  assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
  const ended = JSON.parse((await fs.readFile(serviceFile, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(ended.running, false);
  await assert.rejects(request(port, '/study/'));
});

const windowsPowerShell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe';
for (const [name, shell] of [['Windows PowerShell', windowsPowerShell], ['PowerShell 7', process.env.STUDY_TEST_PWSH || 'pwsh.exe']]) {
  test(`${name} preserves typed process timestamps and rejects reused identities`, { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const probe = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (name === 'PowerShell 7' && (probe.error?.code === 'ENOENT' || Number(probe.stdout?.trim()) < 7)) {
      t.skip('PowerShell 7 is not installed on PATH; STUDY_TEST_PWSH can select it');
      return;
    }
    assert.equal(probe.status, 0, probe.stderr || String(probe.error || 'shell probe failed'));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yankao typed time '));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const helper = path.join(projectRoot, 'study/service-process.ps1').replaceAll("'", "''");
    const source = `. '${helper}'\n` + String.raw`
$ErrorActionPreference = 'Stop'
$expectedScript = 'C:\synthetic checkout\study\serve.mjs'
$instant = [DateTime]::Parse('2026-10-23T06:19:25.000Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
$script:mockProcess = [pscustomobject]@{ ProcessId = 99123; CommandLine = '"node.exe" "' + $expectedScript + '"'; CreationDate = $instant }
# No CIM lookup or process termination is possible in this synthetic test.
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) return $script:mockProcess }
function Assert-Owned($Info, [bool]$Expected, [string]$Label) {
    $actual = Get-StudyOwnedProcess $Info $expectedScript
    if (($null -ne $actual) -ne $Expected) { throw "Unexpected process ownership: $Label" }
}
$offset = [DateTimeOffset]::Parse('2026-10-23T14:19:25.000+08:00', [Globalization.CultureInfo]::InvariantCulture)
foreach ($stamp in @($instant, $instant.ToLocalTime(), $offset, '2026-10-23T06:19:25.000Z', '2026-10-23T14:19:25.000+08:00')) {
    Assert-Owned ([pscustomobject]@{ pid = 99123; processStartedAt = $stamp }) $true ('typed timestamp ' + $stamp.GetType().Name)
}
$fromJson = '{"pid":99123,"startedAt":"2026-10-23T06:19:25.000Z"}' | ConvertFrom-Json
Assert-Owned $fromJson $true 'ConvertFrom-Json timestamp'
Assert-Owned ([pscustomobject]@{ pid = 99123; processStartedAt = $instant.AddSeconds(2) }) $true 'exact two-second process tolerance'
Assert-Owned ([pscustomobject]@{ pid = 99123; processStartedAt = $instant.AddSeconds(2.1) }) $false 'outside process tolerance'
Assert-Owned ([pscustomobject]@{ pid = 99123; startedAt = $instant.AddSeconds(3) }) $true 'legacy startup delay'
Assert-Owned ([pscustomobject]@{ pid = 99123; startedAt = $instant.AddSeconds(15) }) $true 'exact legacy tolerance'
Assert-Owned ([pscustomobject]@{ pid = 99123; startedAt = $instant.AddSeconds(15.1) }) $false 'outside legacy tolerance'
Assert-Owned ([pscustomobject]@{ pid = 99123; processStartedAt = '1970-01-01T00:00:00.000Z' }) $false 'reused PID'
Assert-Owned ([pscustomobject]@{ pid = 99123; processStartedAt = 'not-a-date'; startedAt = $instant }) $false 'invalid precise timestamp must not fall back'
Assert-Owned ([pscustomobject]@{ pid = 99123; processStartedAt = [pscustomobject]@{ value = $instant } }) $false 'invalid timestamp type'
$script:mockProcess.CreationDate = $offset
Assert-Owned ([pscustomobject]@{ pid = 99123; processStartedAt = $instant }) $true 'typed CIM offset timestamp'
$script:mockProcess.CreationDate = '2026-10-23T06:19:25.000Z'
Assert-Owned ([pscustomobject]@{ pid = 99123; processStartedAt = $instant }) $true 'CIM ISO timestamp'
$script:mockProcess.CreationDate = 'not-a-date'
Assert-Owned ([pscustomobject]@{ pid = 99123; processStartedAt = $instant }) $false 'invalid CIM timestamp'
$script:mockProcess.CreationDate = $instant
$script:mockProcess.CommandLine = '"node.exe" "' + $expectedScript + '.backup"'
Assert-Owned ([pscustomobject]@{ pid = 99123; processStartedAt = $instant }) $false 'similar script argument'
@{ jsonDateType = $fromJson.startedAt.GetType().Name; major = $PSVersionTable.PSVersion.Major } | ConvertTo-Json -Compress
`;
    const script = path.join(directory, 'typed-time.ps1');
    await fs.writeFile(script, '\uFEFF' + source);
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const output = JSON.parse(result.stdout.trim());
    if (name === 'PowerShell 7') assert.equal(output.jsonDateType, 'DateTime', 'exercise the real PS7 JSON date conversion');
  });
}
