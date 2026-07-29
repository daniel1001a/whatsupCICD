import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/types/**'],
      thresholds: {
        // CLAUDE.md 工程慣例：sanitizer 100% 分支覆蓋（不可妥協）；管線層 > 85%
        'src/sanitizer/**': { branches: 100, functions: 100, lines: 100, statements: 100 },
        'src/extractor/**': { branches: 85, functions: 85, lines: 85, statements: 85 },
        'src/pipeline/**': { branches: 85, functions: 85, lines: 85, statements: 85 },
      },
    },
  },
});
