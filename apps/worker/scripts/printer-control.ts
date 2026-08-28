import { loadConfig } from '@pos/config';
import { closeDb, getDb, readPrinterControls, setPrinterControls } from '@pos/db';
import pino from 'pino';

import { createPrintQueue } from '../src/modules/printing/print-queue.js';
import { retryDeadLetteredTicket } from '../src/modules/printing/reconcile.js';
import { connectRedis, producerConnection, waitUntilReady } from '../src/shared/redis.js';
import { settleWithin } from '../src/shared/timeout.js';

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
      // The producer's bounded options, so `retry` against an unreachable Redis prints an error
      // rather than hanging a terminal.
      const redis = connectRedis(
        config.REDIS_URL,
        producerConnection(config.PRINT_ENQUEUE_TIMEOUT_MS),
        'printer-cli',
        pino({ level: config.LOG_LEVEL }),
      );
      const queue = createPrintQueue(redis, {
        queueName: config.PRINT_QUEUE_NAME,
        maxAttempts: config.PRINT_MAX_ATTEMPTS,
        backoffBaseMs: config.PRINT_BACKOFF_BASE_MS,
        enqueueTimeoutMs: config.PRINT_ENQUEUE_TIMEOUT_MS,
      });
      try {
        // Before anything is written. The enqueue refuses a client that is not ready yet, and this
        // one was opened microseconds ago — without this wait the command would reset the row to
        // PENDING against a healthy Redis and then report that it could not queue the job, leaving
        // the ticket to the sweep. The worker needs no such wait: it connects at boot.
        await waitUntilReady(redis, config.PRINT_ENQUEUE_TIMEOUT_MS);

        const result = await retryDeadLetteredTicket(db, queue, argument);
        process.stdout.write(`${RETRY_MESSAGES[result] ?? result}\n`);
      } finally {
        // Bounded, then dropped. `close()` and `quit()` against an unreachable Redis wait for a
        // reply rather than failing, and a command-line tool that never returns is worse than one
        // that reports it could not reach the queue.
        await settleWithin(queue.close(), config.PRINT_SHUTDOWN_TIMEOUT_MS);
        redis.disconnect();
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
