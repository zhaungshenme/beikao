import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!(major === 20 && minor >= 19 || major === 22 && minor >= 12 || major > 22)) {
    throw new Error('请使用 Node.js 20.19+ 或 22.12+（推荐当前 LTS）；当前版本不满足 Vite 7 要求。');
  }
}

// Relative data paths always refer to this checkout, never the caller's working directory.
export function resolveRuntimeConfig(env = process.env, root = projectRoot) {
  const host = env.STUDY_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('STUDY_HOST 仅支持 127.0.0.1 或 localhost；当前为本机单人版。');
  const portText = env.STUDY_PORT ?? '18103';
  if (!/^\d+$/.test(portText) || !Number.isSafeInteger(Number(portText)) || Number(portText) < 1 || Number(portText) > 65535) {
    throw new Error('STUDY_PORT 必须是 1 至 65535 的整数。');
  }
  if (env.STUDY_DATA_DIR !== undefined && !env.STUDY_DATA_DIR.trim()) throw new Error('STUDY_DATA_DIR 不能为空。');
  const port = Number(portText);
  const dataDir = path.resolve(root, env.STUDY_DATA_DIR ?? 'study/storage');
  for (const publicPath of ['study-dist', 'study/data', 'study/bridge']) {
    const relativeToPublic = path.relative(path.resolve(root, publicPath), dataDir);
    if (!relativeToPublic || !relativeToPublic.startsWith(`..${path.sep}`) && relativeToPublic !== '..' && !path.isAbsolute(relativeToPublic)) {
      throw new Error(`STUDY_DATA_DIR 不能放在 ${publicPath} 内；数据需与公开题库、网页资源和构建输出分开。`);
    }
  }
  return { host, port, dataDir, origin: `http://${host}${port === 80 ? '' : `:${port}`}`, url: `http://${host}${port === 80 ? '' : `:${port}`}/study/` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertNodeVersion();
    process.stdout.write(`${JSON.stringify(resolveRuntimeConfig())}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
