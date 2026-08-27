import { fileURLToPath } from 'node:url';

import { loadConfig } from '@pos/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDb } from '../src/client.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

const { db, close } = createDb(loadConfig().DATABASE_URL);

try {
  await migrate(db, { migrationsFolder });
  console.log(`Migrations applied from ${migrationsFolder}`);
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await close();
}
