import path from 'node:path';
import { importQuestionBank } from './server/question-bank-import.mjs';
import { assertNodeVersion, projectRoot, resolveRuntimeConfig } from './runtime-config.mjs';

const help = '用法：node study/import-bank.mjs <题库.json> [--check] [--replace]\n--check 仅校验；默认拒绝覆盖。导入前须停止学习服务。替换时请保留题号含义，并先备份学习数据。';
try {
  assertNodeVersion();
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(help); }
  else {
    const flags = args.filter(value => value.startsWith('--'));
    const inputs = args.filter(value => !value.startsWith('--'));
    if (inputs.length !== 1 || flags.some(flag => !['--check', '--replace'].includes(flag)) || new Set(flags).size !== flags.length) throw new Error(help);
    const { dataDir } = resolveRuntimeConfig();
    const result = importQuestionBank({ sourcePath: inputs[0], targetPath: path.join(projectRoot, 'study/data/questions.json'), dataDir,
      replace: flags.includes('--replace'), checkOnly: flags.includes('--check') });
    console.log(result.checked ? `题库格式校验通过，共 ${result.count} 题；未写入文件。` : `已导入 ${result.count} 题。重新启动学习服务后生效。`);
    if (result.backupPath) console.log(`原题库备份：${result.backupPath}`);
  }
} catch (error) { console.error(`题库未导入：${error.message}`); process.exitCode = 1; }
