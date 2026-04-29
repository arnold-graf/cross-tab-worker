import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      // Keep e2e source imports type-safe, but execute against built dist output.
      '../src/CrossTabWorker': new URL('../dist/index.js', import.meta.url).pathname,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});

