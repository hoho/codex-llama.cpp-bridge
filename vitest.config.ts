import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts'],
      thresholds: {
        perFile: true,
        branches: 80,
        functions: 100,
        lines: 95,
        statements: 94,
      },
    },
  },
});
