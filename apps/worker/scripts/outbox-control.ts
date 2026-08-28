import { closeDb, getDb } from '@pos/db';

import { readOutboxControls, setOutboxControls } from '../src/modules/events/outbox-controls.js';

/**
 * The §18 switches `Pause Outbox Publisher` and `Delay Outbox Publishing`, until M12 gives them
 * buttons in `/debug`. It writes the same singleton row a running worker polls, so a pause takes
 * effect within one `OUTBOX_POLL_MS` and no process is restarted.
 *
 *   pnpm -F @pos/worker outbox status
 *   pnpm -F @pos/worker outbox pause
 *   pnpm -F @pos/worker outbox resume
 *   pnpm -F @pos/worker outbox delay 3000
 */
const USAGE = 'usage: outbox status | pause | resume | delay <ms>';

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  const { db } = getDb();

  switch (command) {
    case 'status':
      break;
    case 'pause':
      await setOutboxControls(db, { paused: true });
      break;
    case 'resume':
      await setOutboxControls(db, { paused: false });
      break;
    case 'delay': {
      const ms = Number(argument);
      if (!Number.isInteger(ms) || ms < 0) {
        throw new Error(`delay takes a whole number of milliseconds; got ${String(argument)}`);
      }
      await setOutboxControls(db, { publishDelayMs: ms });
      break;
    }
    default:
      throw new Error(USAGE);
  }

  const controls = await readOutboxControls(db);
  process.stdout.write(
    `outbox publisher: ${controls.paused ? 'PAUSED' : 'running'}, ` +
      `publish delay ${controls.publishDelayMs}ms\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
