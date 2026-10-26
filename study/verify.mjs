import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertNodeVersion } from './runtime-config.mjs';

assertNodeVersion();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverTests = fs.readdirSync(path.join(root, 'study/server'))
  // These historical checks require a private bank or captured chat pages.
  .filter(file => file.endsWith('.test.mjs') && !['bank-expansion.test.mjs', 'userscript-resilience.test.mjs'].includes(file))
  .map(file => `study/server/${file}`);
const checks = [
  ['无题库发布范围检查', ['scripts/release-source.mjs', '--check']],
  ['后端回归（合成临时数据）', ['--test', ...serverTests]],
  ['源码发布隔离回归', ['--test', 'scripts/release-source.test.mjs']],
  ['前端任务恢复回归', ['node_modules/vitest/vitest.mjs', 'run', '--config', 'study/client-tests/vitest.config.ts']],
  ['Vue / TypeScript 检查', ['node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit', '-p', 'study/tsconfig.json']],
  ['生产构建', ['study/build.mjs']],
];
for (const [label, args] of checks) {
  console.log(`\n${label}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\n刷题平台验证通过。测试使用独立临时数据，不修改正式学习记录。');
