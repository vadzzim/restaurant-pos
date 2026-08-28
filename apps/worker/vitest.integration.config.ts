import { defineConfig } from 'vitest/config';

import { packageAliases } from './vitest.alias.js';

/**
 * The suites that need a live Redpanda, not just PostgreSQL. `pnpm verify:integration` runs this
 * after bringing Compose up; `pnpm test` never does, so the default suite stays runnable against a
 * database alone. It does not extend `vitest.config.ts`: merging would concatenate that file's
 * `exclude`, which is exactly the pattern this config exists to include.
 */
export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    include: ['test/**/*.integration.test.ts'],
    fileParallelism: false,
    // A round trip through a broker is slower than anything else in the suite: topic creation, a
    // consumer group joining and a rebalance all happen before the first message arrives.
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
