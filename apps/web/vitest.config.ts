import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Dexie needs an IndexedDB. This installs a real implementation of the spec rather than a
    // stub, so the storage tests exercise cloning, indexes and transactions for real.
    setupFiles: ['./test/setup-indexeddb.ts'],
  },
  resolve: {
    // Package sources, so a stale dist cannot hide a broken change.
    alias: {
      '@pos/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
});
