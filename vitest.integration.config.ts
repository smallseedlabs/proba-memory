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
      '@smallseedlabs/proba-memory-adapters': src('./packages/adapters/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.integration.test.ts', 'apps/*/src/**/*.integration.test.ts'],
    
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false, // test files share one Postgres and one Redis
  },
});
