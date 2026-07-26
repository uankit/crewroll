import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/core/core.test.ts', '**/node_modules/**'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
