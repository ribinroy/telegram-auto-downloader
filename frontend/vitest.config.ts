import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so the build never loads the test setup
// (and the service-worker plugin never runs during a test run).
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
