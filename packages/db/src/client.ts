import { loadConfig } from '@pos/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

/** The transaction handle Drizzle hands to `db.transaction(...)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  pool: pg.Pool;
  db: Db;
  close: () => Promise<void>;
}

/**
 * `pg` waits forever for a connection by default. That turns an unreachable database into requests
 * that never answer — including the health probe that exists to report it, whose own timeout gives
 * up on the promise but cannot cancel the waiter behind it, so waiters would pile up for the length
 * of the outage. A bound here is what makes that impossible; the probe's timeout is a backstop.
 *
 * It bounds *acquiring* a connection, not running a query, so the deliberate `select … for update`
 * blocking in the write path and its tests are unaffected.
 */
const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * A connection is always created against an explicit URL. Tests point at their own database, and
 * the two application processes point at the configured one.
 */
export function createDb(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  const db = drizzle(pool, { schema });

  return {
    pool,
    db,
    close: async () => {
      await pool.end();
    },
  };
}

let handle: DbHandle | undefined;

/** The process-wide handle for the api and the worker, opened on first use. */
export function getDb(): DbHandle {
  handle ??= createDb(loadConfig().DATABASE_URL);
  return handle;
}

export async function closeDb(): Promise<void> {
  await handle?.close();
  handle = undefined;
}
