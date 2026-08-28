import { loadConfig } from '@pos/config';
import { closeDb, getDb } from '@pos/db';
import { Kafka } from 'kafkajs';

import { buildApp } from './app.js';
import { postgresProbe } from './modules/health/application/dependency-probes.js';
import { redisProbe, redpandaProbe } from './modules/health/application/infrastructure-probes.js';
import { superviseRealtimeConsumer } from './modules/realtime/consumer.js';
import { createRealtimeServer } from './modules/realtime/socket-server.js';

const config = loadConfig();
const { db } = getDb();

/**
 * The soft dependencies are injected here, not built inside `buildApp()`, so the routes stay free
 * of infrastructure (ADR 006). The Redis probe closes over `realtime`, which is created from the
 * app's own HTTP server below; it is only ever called from a request handler, long after that
 * assignment.
 */
const app = buildApp({
  db,
  logLevel: config.LOG_LEVEL,
  healthTimeoutMs: config.HEALTH_CHECK_TIMEOUT_MS,
  probes: [postgresProbe(db), redisProbe(async () => realtime.ping()), redpandaProbe(config)],
});

const realtime = createRealtimeServer(app.server, config, app.log);

const kafka = new Kafka({
  clientId: `${config.KAFKA_CLIENT_ID}-api`,
  brokers: config.KAFKA_BROKERS,
  // The default would print a reconnection storm while the broker is down; the supervisor below
  // reports it once per attempt instead.
  retry: { retries: 3 },
});

/**
 * Redpanda is a soft dependency of the API (§17). Readiness checks PostgreSQL only, because the
 * outbox exists precisely so that a broker outage does not stop a POS taking orders — so the
 * consumer is supervised in the background and never blocks `listen()`. The worker supervises its
 * own broker connection for a different reason; both are argued in ADR 011.
 */
const consumer = superviseRealtimeConsumer(kafka, db, realtime.emitter, config, app.log);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'Shutting down API');
  try {
    await consumer.stop();
    await realtime.close();
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
