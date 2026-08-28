import { defineConfig } from 'vitest/config';

import { packageAliases } from './vitest.alias.js';

export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    // One database, one file at a time: the suites truncate shared tables.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // `pnpm test` must stay runnable with PostgreSQL alone. The round trip needs a live broker, so
    // it runs from `vitest.integration.config.ts` under `pnpm verify:integration` instead.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
