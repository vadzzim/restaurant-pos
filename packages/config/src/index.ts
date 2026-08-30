import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_PORT: z.coerce.number().int().positive().default(5173),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().positive().default(10_000),
  DATABASE_URL: z.url().default('postgresql://pos:pos@localhost:5432/pos'),
  /** Tests own their own database so a test run never truncates the demo the user has on screen. */
  TEST_DATABASE_URL: z.url().default('postgresql://pos:pos@localhost:5432/pos_test'),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .default('localhost:9092')
    .transform((value) => value.split(',').map((broker) => broker.trim())),
  KAFKA_CLIENT_ID: z.string().min(1).default('pos'),
  KAFKA_ORDER_EVENTS_TOPIC: z.string().min(1).default('restaurant.order.events'),
  KAFKA_ORDER_EVENTS_PARTITIONS: z.coerce.number().int().positive().default(3),
  KITCHEN_CONSUMER_GROUP: z.string().min(1).default('kitchen'),
  /** Shared across every api instance on purpose: see ADR 006. */
  REALTIME_CONSUMER_GROUP: z.string().min(1).default('realtime'),
  REALTIME_CONSUMER_RETRY_MS: z.coerce.number().int().positive().default(5_000),
  /**
   * The worker retries its broker connection on this interval instead of exiting. It deliberately
   * does not run the publisher while disconnected: a failed publish increments `attempt_count`,
   * and an outage long enough to exhaust it would dead-letter events that were never bad (ADR 011).
   */
  WORKER_BROKER_RETRY_MS: z.coerce.number().int().positive().default(5_000),
  /** One dependency being unreachable must not make the report that explains it hang (§17). */
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  OUTBOX_LEASE_MS: z.coerce.number().int().positive().default(30_000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  OUTBOX_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1_000),
  OUTBOX_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * The fake local printer (§12.3). It is an endpoint on the API rather than a device on the LAN,
   * and the worker is the only thing that calls it.
   */
  PRINTER_URL: z.url().default('http://localhost:3000/api/printer/print'),
  /** A device that has not answered in this long is a device that is not going to. */
  PRINTER_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  /**
   * The bound on a single Redis command from the queue's producer connection. The kitchen consumer
   * awaits `queue.add()` after committing its projection, so an enqueue that never settles is a
   * consumer that never commits its offset — Redis is soft only if this is finite (ADR 014).
   */
  PRINT_ENQUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  PRINT_QUEUE_NAME: z.string().min(1).default('print'),
  /** Attempts, not retries: the first try counts. Reaching it dead-letters the row. */
  PRINT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** BullMQ's exponential backoff base, so attempt n waits `base * 2^(n-1)`. */
  PRINT_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1_000),
  /**
   * How long each step of the print pipeline's shutdown may take before the Redis sockets are
   * dropped instead. A `quit()` against an unreachable Redis waits for a reply rather than
   * failing, and nothing after it — closing the database, exiting — would ever run.
   */
  PRINT_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  /** How often the reconciliation sweep looks for tickets nothing has printed. */
  PRINT_RECONCILE_MS: z.coerce.number().int().positive().default(15_000),
  /** A bound on one sweep, so a backlog of unprintable tickets cannot monopolise the loop. */
  PRINT_RECONCILE_LIMIT: z.coerce.number().int().positive().default(50),
  /**
   * How long a `PENDING` or `FAILED` row may sit untouched before the sweep assumes its job is
   * gone — a Redis flush, or a worker that died between the insert and the send. It must exceed
   * the longest backoff a live job can be waiting out, or the sweep re-enqueues healthy retries.
   */
  PRINT_STALE_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * How long a presence entry outlives its last heartbeat (§16: active terminals with their
   * pending counts). The heartbeat interval itself is `PRESENCE_HEARTBEAT_MS` in `@pos/contracts`,
   * because the browser is what sends it; this is the server's side of the same agreement and the
   * default is three missed beats.
   *
   * A disconnect deletes the key eagerly; this TTL is what covers a browser that was killed, a
   * closed laptop, or an API instance that died holding the socket. A presence list that only
   * grows is a bug that looks like a feature for the first ten minutes.
   */
  PRESENCE_TTL_MS: z.coerce.number().int().positive().default(15_000),
  /** How many rows each /debug listing returns. A page, not a table dump. */
  DEBUG_ROW_LIMIT: z.coerce.number().int().positive().max(500).default(50),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`, { cause: result.error });
  }

  return result.data;
}
