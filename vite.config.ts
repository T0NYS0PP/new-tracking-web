import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base: the same build works at the domain root, under /new-tracking-web/ (GitHub Pages)
  // and inside the claude.ai artifact viewer.
  base: './',
  server: {
    headers: {
      // Camera access and WASM threads behave best under a secure, isolated context.
      'Permissions-Policy': 'camera=(self)',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        painting: resolve(__dirname, 'painting.html'),
        photos: resolve(__dirname, 'photos.html'),
      },
    },
  },
  optimizeDeps: {
    // Spark ships pre-bundled ESM with inline workers; keep it out of the dep optimizer.
    exclude: ['@sparkjsdev/spark'],
  },
});
