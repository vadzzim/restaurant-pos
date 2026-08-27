import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_PORT: z.coerce.number().int().positive().default(5173),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().positive().default(10_000),
  DATABASE_URL: z.url().default('postgresql://pos:pos@localhost:5432/pos'),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .default('localhost:9092')
    .transform((value) => value.split(',').map((broker) => broker.trim())),
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
