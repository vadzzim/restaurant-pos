import { loadConfig } from '@pos/config';
import { defineConfig } from 'drizzle-kit';

const config = loadConfig();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: config.DATABASE_URL },
  strict: true,
  verbose: true,
});
