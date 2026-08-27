import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against package sources, so a stale dist can never hide a broken change.
    alias: {
      '@pos/db/testing': resolve('../../packages/db/src/testing.ts'),
      '@pos/db': resolve('../../packages/db/src/index.ts'),
      '@pos/contracts': resolve('../../packages/contracts/src/index.ts'),
      '@pos/domain': resolve('../../packages/domain/src/index.ts'),
      '@pos/config': resolve('../../packages/config/src/index.ts'),
    },
  },
  test: {
    // One database, one file at a time: the suites truncate shared tables.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
