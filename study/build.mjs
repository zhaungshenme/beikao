import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';
import { assertNodeVersion, resolveRuntimeConfig } from './runtime-config.mjs';

assertNodeVersion();
// Refuse a data directory in the build output before Vite empties that output.
resolveRuntimeConfig();
const studyDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(studyDir);
await build({
  configFile: false,
  root,
  publicDir: false,
  base: '/',
  plugins: [vue()],
  resolve: { alias: { '@': path.join(root, 'src') } },
  build: { outDir: path.join(root, 'study-dist'), emptyOutDir: true, rollupOptions: { input: path.join(studyDir, 'index.html') } },
});
