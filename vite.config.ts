import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    headers: {
      // Camera access and WASM threads behave best under a secure, isolated context.
      'Permissions-Policy': 'camera=(self)',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  optimizeDeps: {
    // Spark ships pre-bundled ESM with inline workers; keep it out of the dep optimizer.
    exclude: ['@sparkjsdev/spark'],
  },
});
