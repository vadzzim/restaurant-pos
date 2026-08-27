import { loadConfig } from '@pos/config';
import { closeDb, getDb } from '@pos/db';

import { buildApp } from './app.js';

const config = loadConfig();
const app = buildApp({ db: getDb().db, logLevel: config.LOG_LEVEL });

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'Shutting down API');
  try {
    await app.close();
    await closeDb();
  } catch (error) {
    app.log.error({ error, signal }, 'Failed to shut down API cleanly');
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error, 'Failed to start API');
  process.exitCode = 1;
  await shutdown('SIGTERM');
}
