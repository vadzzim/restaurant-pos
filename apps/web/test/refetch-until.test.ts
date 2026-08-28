import { describe, expect, it } from 'vitest';

import { refetchUntil } from '../src/realtime/refetch-until';

/** A sleep that records what it was asked to wait and returns immediately. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

describe('refetchUntil (the lagging-projection wait)', () => {
  it('reads once and does not sleep when the first read already accounts for the event', async () => {
    const { sleep, waits } = fakeSleep();
    let reads = 0;

    const outcome = await refetchUntil(
      async () => {
        reads += 1;
        return 5;
      },
      (value) => value >= 5,
      { sleep },
    );

    expect(outcome).toEqual({ value: 5, converged: true, attempts: 1 });
    expect(reads).toBe(1);
    expect(waits).toEqual([]);
  });

  it('keeps reading until the projection catches up', async () => {
    const { sleep } = fakeSleep();
    const versions = [0, 0, 4];
    let reads = 0;

    const outcome = await refetchUntil(
      async () => versions[reads++] ?? 4,
      (value) => value >= 4,
      { sleep },
    );

    expect(outcome.value).toBe(4);
    expect(outcome.converged).toBe(true);
    expect(reads).toBe(3);
  });

  it('gives up on a bounded budget and says so rather than spinning forever', async () => {
    const { sleep, waits } = fakeSleep();
    let reads = 0;

    const outcome = await refetchUntil(
      async () => {
        reads += 1;
        return 0;
      },
      (value) => value >= 4,
      { attempts: 3, delayMs: 100, sleep },
    );

    expect(outcome).toEqual({ value: 0, converged: false, attempts: 3 });
    expect(reads).toBe(3);
    // Backoff grows, so a consumer that is merely slow is not hammered.
    expect(waits).toEqual([100, 200]);
  });
});
