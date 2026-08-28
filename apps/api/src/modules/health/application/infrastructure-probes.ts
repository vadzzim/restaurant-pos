import type { AppConfig } from '@pos/config';
import { Kafka } from 'kafkajs';

import type { DependencyProbe } from './dependency-probes.js';

/**
 * The soft dependencies. They live apart from `dependency-probes.ts` so that `buildApp()` — and
 * therefore every `fastify.inject` test — never pulls in a Redis or a Kafka client (ADR 006).
 */

/**
 * Redis is probed through the adapter's own publisher client rather than a new connection, so the
 * report describes the connection the broadcasts actually travel on.
 */
export function redisProbe(ping: () => Promise<void>): DependencyProbe {
  return {
    name: 'redis',
    kind: 'soft',
    impact:
      'Cross-instance broadcast fan-out degrades. Each instance still reaches its own sockets, ' +
      'and writes are unaffected.',
    check: ping,
  };
}

/**
 * A dedicated client with retries disabled: the probe has its own timeout and its job is to report
 * the broker's state quickly, not to wait for it the way the consumer supervisor does. A retrying
 * client would keep the admin connection alive past the timeout that already gave up on it.
 */
export function redpandaProbe(config: AppConfig): DependencyProbe {
  const kafka = new Kafka({
    clientId: `${config.KAFKA_CLIENT_ID}-api-probe`,
    brokers: config.KAFKA_BROKERS,
    retry: { retries: 0 },
    connectionTimeout: config.HEALTH_CHECK_TIMEOUT_MS,
    requestTimeout: config.HEALTH_CHECK_TIMEOUT_MS,
  });

  return {
    name: 'redpanda',
    kind: 'soft',
    impact:
      'Events accumulate in the outbox and screens stop updating live. Orders are still accepted ' +
      'and publish when the broker returns.',
    check: async () => {
      const admin = kafka.admin();
      try {
        await admin.connect();
        await admin.describeCluster();
      } finally {
        await admin.disconnect().catch(() => undefined);
      }
    },
  };
}
