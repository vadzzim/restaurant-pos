import { sql } from 'drizzle-orm';

import { loadConfig } from '@pos/config';

import { createDb } from '../src/client.js';

/**
 * Proves the schema is really there: every table is selectable, the outbox partial index exists,
 * and the `orders` shape can be inspected without opening a psql session.
 */
const TABLES = [
  'restaurants',
  'terminals',
  'products',
  'orders',
  'order_items',
  'payments',
  'processed_mutations',
  'outbox_events',
  'processed_events',
  'kitchen_tickets',
  'conflict_log',
  'feature_flags',
  'print_jobs',
  'outbox_controls',
  'printer_controls',
] as const;

const OUTBOX_PENDING_INDEX = 'outbox_events_pending_idx';

type CountRow = { count: string } & Record<string, unknown>;

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: string;
} & Record<string, unknown>;

type IndexRow = { indexdef: string } & Record<string, unknown>;

let failed = false;

const { db, close } = createDb(loadConfig().DATABASE_URL);

try {
  const counts: Record<string, number> = {};

  for (const table of TABLES) {
    try {
      const result = await db.execute<CountRow>(
        sql`select count(*)::text as count from ${sql.identifier(table)}`,
      );
      counts[table] = Number(result.rows[0]?.count ?? '0');
    } catch (error) {
      failed = true;
      console.error(`Table ${table} is not selectable:`, error);
    }
  }

  console.log(`Tables (${Object.keys(counts).length}/${TABLES.length} selectable):`);
  console.table(counts);

  const columns = await db.execute<ColumnRow>(sql`
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
    order by ordinal_position
  `);
  console.log('orders columns:');
  console.table(columns.rows);

  const indexes = await db.execute<IndexRow>(sql`
    select indexdef from pg_indexes
    where schemaname = 'public' and indexname = ${OUTBOX_PENDING_INDEX}
  `);
  const outboxIndex = indexes.rows[0]?.indexdef;

  if (outboxIndex === undefined) {
    failed = true;
    console.error(`Missing partial index ${OUTBOX_PENDING_INDEX} on outbox_events.`);
  } else {
    console.log(`Outbox publisher index: ${outboxIndex}`);
    if (!outboxIndex.toLowerCase().includes('where')) {
      failed = true;
      console.error(`${OUTBOX_PENDING_INDEX} exists but is not partial.`);
    }
  }
} catch (error) {
  failed = true;
  console.error('Schema check failed:', error);
} finally {
  await close();
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('Schema check passed.');
}
