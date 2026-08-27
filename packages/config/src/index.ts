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
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  OUTBOX_LEASE_MS: z.coerce.number().int().positive().default(30_000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  OUTBOX_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1_000),
  OUTBOX_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
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
