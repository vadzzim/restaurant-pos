import { loadConfig } from '@pos/config';
import { closeDb, getDb } from '@pos/db';
import { Kafka } from 'kafkajs';

import { buildApp } from './app.js';
import { startRealtimeConsumer, type RealtimeConsumerHandle } from './modules/realtime/consumer.js';
import { createRealtimeServer } from './modules/realtime/socket-server.js';

const config = loadConfig();
const { db } = getDb();
const app = buildApp({ db, logLevel: config.LOG_LEVEL });

const realtime = createRealtimeServer(app.server, config, app.log);

const kafka = new Kafka({
  clientId: `${config.KAFKA_CLIENT_ID}-api`,
  brokers: config.KAFKA_BROKERS,
  // The default logger would print a reconnection storm while the broker is down; the retry loop
  // below already reports it once per attempt.
  retry: { retries: 3 },
});

let consumer: RealtimeConsumerHandle | undefined;
let consumerWanted = true;

/**
 * Redpanda is a soft dependency of the API (§17). Readiness checks PostgreSQL only, because the
 * outbox exists precisely so that a broker outage does not stop a POS taking orders — so the
 * consumer is started in the background and retried, and never blocks `listen()`. This is
 * deliberately the opposite of the worker, which cannot do useful work without the broker.
 */
const consumerLoop = (async () => {
  while (consumerWanted) {
    try {
      consumer = await startRealtimeConsumer(kafka, db, realtime.emitter, config, app.log);
      app.log.info({ groupId: config.REALTIME_CONSUMER_GROUP }, 'realtime consumer running');
      return;
    } catch (error) {
      app.log.warn(
        { err: error, retryInMs: config.REALTIME_CONSUMER_RETRY_MS },
        'realtime consumer could not start; live updates are degraded, writes are unaffected',
      );
      await sleep(config.REALTIME_CONSUMER_RETRY_MS);
    }
  }
})();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'Shutting down API');
  consumerWanted = false;
  try {
    await consumerLoop;
    await consumer?.stop();
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
