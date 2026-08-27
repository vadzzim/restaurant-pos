import Fastify from 'fastify';

import { loadConfig } from '@pos/config';

const config = loadConfig();
const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
  },
});

app.get('/api/health/live', async () => ({ status: 'ok' }));
app.get('/api/health/ready', async () => ({ status: 'ok' }));

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'Shutting down API');
  try {
    await app.close();
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
