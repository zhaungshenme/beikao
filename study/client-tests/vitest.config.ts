import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const clientVue = vue();

export default defineConfig({
  // Vitest loads modules through its SSR runner; this suite mounts the client render
  // function on a small in-memory Vue host, so compile the SFC as a client component.
  plugins: [{
    ...clientVue,
    transform: {
      ...(clientVue.transform as any),
      handler(code: string, id: string, options: any) {
        return (clientVue.transform as any).handler.call(this, code, id, { ...options, ssr: false });
      },
    },
  }],
  resolve: { alias: { '@': path.join(projectRoot, 'src') } },
  test: {
    environment: 'node',
    include: ['study/client-tests/*.test.ts'],
    clearMocks: true,
  },
});
