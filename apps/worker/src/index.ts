import pino from 'pino';

import { loadConfig } from '@pos/config';

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

logger.info('Worker started');

const heartbeat = setInterval(() => {
  logger.info('Worker heartbeat');
}, config.WORKER_HEARTBEAT_MS);

function shutdown(signal: NodeJS.Signals): void {
  clearInterval(heartbeat);
  logger.info({ signal }, 'Worker stopped');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdown(signal);
  });
}
