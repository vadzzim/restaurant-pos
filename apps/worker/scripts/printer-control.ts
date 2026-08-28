import { loadConfig } from '@pos/config';
import { closeDb, getDb, readPrinterControls, setPrinterControls } from '@pos/db';
import { Redis } from 'ioredis';

import { createPrintQueue } from '../src/modules/printing/print-queue.js';
import { retryDeadLetteredTicket } from '../src/modules/printing/reconcile.js';

/**
 * §18's `Fail Printer` and §19.9's manual retry, until M12 gives them buttons in `/debug`.
 *
 * The switch is the same singleton row the API's fake printer reads on every print, so failing the
 * printer takes effect on the next attempt with nothing to restart. `retry` is the one command that
 * needs Redis: it resets a dead-lettered row and puts the ticket back on the queue.
 *
 *   pnpm -F @pos/worker printer status
 *   pnpm -F @pos/worker printer fail
 *   pnpm -F @pos/worker printer fix
 *   pnpm -F @pos/worker printer retry <orderId>
 */
const USAGE = 'usage: printer status | fail | fix | retry <orderId>';

const RETRY_MESSAGES: Record<string, string> = {
  requeued: 'the ticket is back on the print queue',
  'not-dead-lettered': 'no dead-lettered print job for that order; nothing was changed',
  'no-ticket': 'the print job was reset, but the kitchen has no ticket for that order',
};

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  const { db } = getDb();

  switch (command) {
    case 'status':
      break;
    case 'fail':
      await setPrinterControls(db, { failing: true });
      break;
    case 'fix':
      await setPrinterControls(db, { failing: false });
      break;
    case 'retry': {
      if (argument === undefined || argument.length === 0) {
        throw new Error('retry takes an order id');
      }
      const config = loadConfig();
      const redis = new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: null });
      const queue = createPrintQueue(redis, {
        queueName: config.PRINT_QUEUE_NAME,
        maxAttempts: config.PRINT_MAX_ATTEMPTS,
        backoffBaseMs: config.PRINT_BACKOFF_BASE_MS,
      });
      try {
        const result = await retryDeadLetteredTicket(db, queue, argument);
        process.stdout.write(`${RETRY_MESSAGES[result] ?? result}\n`);
      } finally {
        await queue.close();
        await redis.quit();
      }
      break;
    }
    default:
      throw new Error(USAGE);
  }

  const controls = await readPrinterControls(db);
  process.stdout.write(`printer: ${controls.failing ? 'FAILING' : 'ready'}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
