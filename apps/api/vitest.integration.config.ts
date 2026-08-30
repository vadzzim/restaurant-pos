import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The suite that needs the whole production-image stack — two API replicas, the worker, and the
 * infrastructure behind them — rather than a database. `pnpm verify:multi` runs it; `pnpm test`
 * never does, which is why `vitest.config.ts` excludes the same pattern.
 *
 * It does not extend `vitest.config.ts`: merging would concatenate that file's `exclude`, which is
 * exactly the pattern this config exists to include. Same reasoning as `@pos/worker`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@pos/contracts': resolve('../../packages/contracts/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.integration.test.ts'],
    fileParallelism: false,
    // A full round trip is an outbox poll, a Kafka publish, a consumer group join and a rebalance.
    hookTimeout: 180_000,
    testTimeout: 120_000,
  },
});
