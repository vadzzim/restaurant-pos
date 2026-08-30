import {
  DEFAULT_OUTBOX_CONTROLS,
  readOutboxControls,
  setOutboxControls,
  type OutboxControls,
} from '@pos/db';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { watchOutboxControls } from '../src/modules/events/outbox-controls.js';
import { db, useTestDatabase } from './helpers.js';

useTestDatabase();

const logger = pino({ level: 'silent' });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('the outbox control row', () => {
  it('reads as the defaults when nobody has written it', async () => {
    expect(await readOutboxControls(db())).toEqual(DEFAULT_OUTBOX_CONTROLS);
  });

  it('patches one switch without clobbering the other', async () => {
    await setOutboxControls(db(), { publishDelayMs: 250 });
    await setOutboxControls(db(), { paused: true });

    expect(await readOutboxControls(db())).toEqual({ paused: true, publishDelayMs: 250 });

    await setOutboxControls(db(), { paused: false });
    expect(await readOutboxControls(db())).toEqual({ paused: false, publishDelayMs: 250 });
  });
});

/**
 * Review round 1's P2: `setInterval` is a metronome, not a gap between reads. Under the database
 * degradation this watcher exists to survive, overlapping reads pile onto the pool and can settle
 * out of order — an older snapshot overwriting a newer pause.
 */
describe('the outbox control watcher', () => {
  it('never has two reads outstanding at once', async () => {
    let inFlight = 0;
    let concurrentPeak = 0;
    let reads = 0;

    const watcher = await watchOutboxControls(
      async () => {
        inFlight += 1;
        reads += 1;
        concurrentPeak = Math.max(concurrentPeak, inFlight);
        // Far longer than the interval below: with `setInterval` this would overlap immediately.
        await sleep(25);
        inFlight -= 1;
        return DEFAULT_OUTBOX_CONTROLS;
      },
      1,
      logger,
    );

    await sleep(120);
    watcher.stop();

    expect(concurrentPeak).toBe(1);
    // And it did keep polling: a serialized poller that stalls is not an improvement.
    expect(reads).toBeGreaterThan(2);
  });

  it('keeps the last known value when a read fails', async () => {
    const paused: OutboxControls = { paused: true, publishDelayMs: 0 };
    let reads = 0;

    const watcher = await watchOutboxControls(
      async () => {
        reads += 1;
        if (reads === 1) {
          return paused;
        }
        throw new Error('database unreachable');
      },
      1,
      logger,
    );

    await sleep(50);
    watcher.stop();

    // A blip must not un-pause a publisher a human paused — least of all while the database is ill.
    expect(reads).toBeGreaterThan(1);
    expect(watcher.current()).toEqual(paused);
  });

  it('stops polling when stopped', async () => {
    let reads = 0;

    const watcher = await watchOutboxControls(
      async () => {
        reads += 1;
        return DEFAULT_OUTBOX_CONTROLS;
      },
      1,
      logger,
    );

    await sleep(30);
    watcher.stop();
    const afterStop = reads;

    await sleep(30);
    // One read may already have been in flight when `stop` landed; nothing may follow it.
    expect(reads).toBeLessThanOrEqual(afterStop + 1);
  });
});
