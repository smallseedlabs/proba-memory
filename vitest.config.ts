import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against source so no build is needed first.
    alias: {
      '@smallseedlabs/proba-memory-scoring': src('./packages/scoring/src/index.ts'),
      '@smallseedlabs/proba-memory-core/testing': src('./packages/core/src/testing/index.ts'),
      '@smallseedlabs/proba-memory-core': src('./packages/core/src/index.ts'),
      '@smallseedlabs/proba-memory-adapters/testing': src('./packages/adapters/src/testing.ts'),
      '@smallseedlabs/proba-memory-adapters': src('./packages/adapters/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],

  },
});
