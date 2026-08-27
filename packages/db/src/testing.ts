import { fileURLToPath } from 'node:url';

import { loadConfig } from '@pos/config';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { createDb, type DbHandle } from './client.js';
import { seedReferenceData } from './reference-data.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * Tables holding per-test state. Reference data (restaurants, terminals, products, flags) is
 * seeded once and left alone, so every test starts from the same menu without re-seeding.
 */
const TRANSACTIONAL_TABLES = [
  'order_items',
  'payments',
  'processed_mutations',
  'outbox_events',
  'processed_events',
  'kitchen_tickets',
  'conflict_log',
  'print_jobs',
  'orders',
] as const;

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function adminUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

/**
 * The tests own their database. The demo database the user keeps on screen is never truncated,
 * which is why this creates `pos_test` rather than reusing `DATABASE_URL`.
 */
export async function setupTestDatabase(): Promise<DbHandle> {
  const url = loadConfig().TEST_DATABASE_URL;
  const name = databaseName(url);

  const admin = new pg.Client({ connectionString: adminUrl(url) });
  await admin.connect();
  try {
    const existing = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (existing.rowCount === 0) {
      // Identifier interpolation: CREATE DATABASE takes no parameters. The name comes from
      // configuration, not from a request.
      await admin.query(`create database "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }

  const handle = createDb(url);
  await migrate(handle.db, { migrationsFolder });
  await seedReferenceData(handle.db);
  return handle;
}

export async function truncateTransactionalTables(handle: DbHandle): Promise<void> {
  const tables = TRANSACTIONAL_TABLES.map((table) => `"${table}"`).join(', ');
  await handle.db.execute(sql.raw(`truncate table ${tables} restart identity cascade`));
}
