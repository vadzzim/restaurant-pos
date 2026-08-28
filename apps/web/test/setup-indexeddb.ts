/**
 * A real IndexedDB for the test process, and a clean one for every test.
 *
 * `fake-indexeddb` is an implementation of the spec, not a mock of Dexie: transactions, key
 * ranges, indexes and structured cloning all behave as the browser's do. That matters here — the
 * failures this milestone guards against (a clone rejecting a Vue proxy, an index read returning
 * rows in an order nobody asked for) are exactly the ones a stubbed Dexie would hide.
 *
 * The database is process-wide, so it is emptied between tests. Without that, a hydration test
 * would be able to pass on a row some earlier test happened to leave behind.
 *
 * No test in this repo opens a browser; `apps/web` tests are vitest over the store modules.
 */
import 'fake-indexeddb/auto';

import { beforeEach } from 'vitest';

import { db } from '../src/persistence/db';
import { persistenceError } from '../src/persistence/local-store';

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  persistenceError.value = undefined;
});
