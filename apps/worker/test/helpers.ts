import type { DbHandle } from '@pos/db';
import { setupTestDatabase, truncateTransactionalTables } from '@pos/db/testing';
import { afterAll, beforeAll, beforeEach } from 'vitest';

let handle: DbHandle | undefined;

export function db(): DbHandle['db'] {
  if (handle === undefined) {
    throw new Error('useTestDatabase() must run before db()');
  }
  return handle.db;
}

export function useTestDatabase(): void {
  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  beforeEach(async () => {
    if (handle !== undefined) {
      await truncateTransactionalTables(handle);
    }
  });

  afterAll(async () => {
    await handle?.close();
    handle = undefined;
  });
}
