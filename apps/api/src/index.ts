import { loadConfig } from '@pos/config';
import { closeDb, getDb } from '@pos/db';
import { Redis } from 'ioredis';
import { Kafka } from 'kafkajs';

import { buildApp } from './app.js';
import { createRedisFlagCache } from './modules/config/infrastructure/redis-flag-cache.js';
import { createConsumerLagProbe } from './modules/debug/application/consumer-lag.js';
import {
  createRedisPresenceStore,
  createRedisSharedCounters,
  incrementSharedCounter,
} from './modules/debug/infrastructure/redis-debug-store.js';
import { postgresProbe } from './modules/health/application/dependency-probes.js';
import { redisProbe, redpandaProbe } from './modules/health/application/infrastructure-probes.js';
import { superviseRealtimeConsumer } from './modules/realtime/consumer.js';
import { createRealtimeServer } from './modules/realtime/socket-server.js';

const config = loadConfig();
const { db } = getDb();

const kafka = new Kafka({
  clientId: `${config.KAFKA_CLIENT_ID}-api`,
  brokers: config.KAFKA_BROKERS,
  // The default would print a reconnection storm while the broker is down; the supervisor below
  // reports it once per attempt instead.
  retry: { retries: 3 },
});

/**
 * A fourth Redis connection, for `/debug` alone, and bounded like the health probe's rather than
 * like the adapter's. Presence and the shared counters are display: a command that queues behind
 * an outage would make the page that is supposed to *show* the outage hang on it.
 */
const debugRedis = new Redis(config.REDIS_URL, {
  lazyConnect: false,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: config.HEALTH_CHECK_TIMEOUT_MS,
});
// Without a listener ioredis throws connection errors at the process, and this one is soft by
// definition. The outage is reported by the dependency panel, not by killing the API.
debugRedis.on('error', () => undefined);

const presence = createRedisPresenceStore(debugRedis, config.PRESENCE_TTL_MS);
const sharedCounters = createRedisSharedCounters(debugRedis);
/**
 * §15's flag cache shares the bounded `/debug` connection rather than opening a fifth. It wants
 * exactly the same properties — short timeout, no offline queue — because both are reads that must
 * fail fast and fall back rather than wait out an outage.
 */
const flagCache = createRedisFlagCache(debugRedis, config.FLAG_CACHE_TTL_MS);

/**
 * Consumer lag for both groups (§17, and ADR 012 for why the kitchen group's lag is a write
 * concern rather than a display one). Its own admin client, connected lazily.
 */
const consumerLag = createConsumerLagProbe(kafka, {
  topic: config.KAFKA_ORDER_EVENTS_TOPIC,
  groupIds: [config.REALTIME_CONSUMER_GROUP, config.KITCHEN_CONSUMER_GROUP],
  timeoutMs: config.HEALTH_CHECK_TIMEOUT_MS,
});

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
  // `socketGauge` closes over `realtime`, which is built from the app's own HTTP server below; it
  // is only ever called from a request handler, long after that assignment.
  socketGauge: () => realtime.socketCount(),
  presence,
  sharedCounters,
  consumerLag: consumerLag.probe,
  debugRowLimit: config.DEBUG_ROW_LIMIT,
  outboxLeaseMs: config.OUTBOX_LEASE_MS,
  flagCache,
});

const realtime = createRealtimeServer(app.server, config, app.log, presence);

/**
 * Redpanda is a soft dependency of the API (§17). Readiness checks PostgreSQL only, because the
 * outbox exists precisely so that a broker outage does not stop a POS taking orders — so the
 * consumer is supervised in the background and never blocks `listen()`. The worker supervises its
 * own broker connection for a different reason; both are argued in ADR 011.
 */
const consumer = superviseRealtimeConsumer(kafka, db, realtime.emitter, config, app.log, () => {
  incrementSharedCounter(debugRedis, 'duplicateKafkaEventsPrevented');
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'Shutting down API');
  try {
    await consumer.stop();
    await realtime.close();
    await consumerLag.close();
    // `disconnect()` rather than `quit()`: this client has `enableOfflineQueue: false`, so against
    // an unreachable Redis a `quit()` waits for a reply that is not coming and the process never
    // exits. The same reasoning as the worker's `stopPrinting`.
    debugRedis.disconnect();
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
