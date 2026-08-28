import { fileURLToPath } from 'node:url';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Tests run against package sources, so a stale dist can never hide a broken change. */
export const packageAliases = {
  '@pos/db/testing': resolve('../../packages/db/src/testing.ts'),
  '@pos/db': resolve('../../packages/db/src/index.ts'),
  '@pos/contracts': resolve('../../packages/contracts/src/index.ts'),
  '@pos/domain': resolve('../../packages/domain/src/index.ts'),
  '@pos/config': resolve('../../packages/config/src/index.ts'),
};
