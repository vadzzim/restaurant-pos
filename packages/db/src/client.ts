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
 * A connection is always created against an explicit URL. Tests point at their own database, and
 * the two application processes point at the configured one.
 */
export function createDb(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString });
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
