import { describe, expect, it } from 'vitest';

import { createCoalescingLoader } from '../src/realtime/coalescing-loader';

/** A promise whose resolution the test controls, so read ordering can be forced. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const noSleep = (): Promise<void> => Promise.resolve();

/** Let every already-scheduled microtask and timer callback run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('createCoalescingLoader', () => {
  it('keeps one read in flight and applies results in read order', async () => {
    const first = deferred<number[]>();
    const second = deferred<number[]>();
    const reads = [first, second];
    let started = 0;
    const applied: number[][] = [];

    const loader = createCoalescingLoader<number, number[]>({
      read: () => reads[started++]?.promise ?? Promise.resolve([]),
      satisfied: (value, expectations) => expectations.every((e) => value.includes(e)),
      apply: (value) => applied.push(value),
      attempts: 1,
      sleep: noSleep,
    });

    const settled = Promise.all([loader.run(1), loader.run(2)]);

    // The second call folds into the loader instead of racing a read of its own; without that,
    // the slower of the two responses could land last and take a visible ticket off the screen.
    expect(started).toBe(1);

    first.resolve([1]);
    await flush();
    expect(started).toBe(2);

    second.resolve([1, 2]);
    await settled;

    expect(applied).toEqual([[1], [1, 2]]);
  });

  it('checks an expectation raised mid-read against a read issued after it', async () => {
    const first = deferred<number[]>();
    const second = deferred<number[]>();
    const reads = [first, second];
    let started = 0;
    const applied: number[][] = [];

    const loader = createCoalescingLoader<number, number[]>({
      read: () => reads[started++]?.promise ?? Promise.resolve([]),
      satisfied: (value, expectations) => expectations.every((e) => value.includes(e)),
      apply: (value) => applied.push(value),
      attempts: 1,
      sleep: noSleep,
    });

    const settled = Promise.all([loader.run(1), loader.run(2)]);

    // This read already contains `2`, but it was *issued* before `2` was expected, so it proves
    // nothing about it: a read that predates the event can legitimately show the event's effect
    // by coincidence and miss it the next time. Another round is required, and happens.
    first.resolve([1, 2]);
    await flush();
    expect(started).toBe(2);

    second.resolve([1, 2]);
    await settled;

    expect(applied).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });

  it('reads once with no expectation and reports convergence', async () => {
    const applied: { value: number[]; converged: boolean }[] = [];
    let reads = 0;

    const loader = createCoalescingLoader<number, number[]>({
      read: async () => {
        reads += 1;
        return [];
      },
      satisfied: (value, expectations) => expectations.every((e) => value.includes(e)),
      apply: (value, converged) => applied.push({ value, converged }),
      sleep: noSleep,
    });

    await loader.run();

    expect(reads).toBe(1);
    expect(applied).toEqual([{ value: [], converged: true }]);
  });

  it('reports a projection that never catches up instead of hanging', async () => {
    const applied: boolean[] = [];

    const loader = createCoalescingLoader<number, number[]>({
      read: async () => [],
      satisfied: (value, expectations) => expectations.every((e) => value.includes(e)),
      apply: (_value, converged) => applied.push(converged),
      attempts: 3,
      sleep: noSleep,
    });

    await loader.run(7);

    expect(applied).toEqual([false]);
  });
});

describe('a round that fails outright', () => {
  it('still serves an expectation raised while the failing read was in flight', async () => {
    const first = deferred<number[]>();
    const second = deferred<number[]>();
    const reads = [first, second];
    let started = 0;
    const applied: number[][] = [];
    const errors: unknown[] = [];

    const loader = createCoalescingLoader<number, number[]>({
      read: () => reads[started++]?.promise ?? Promise.resolve([]),
      satisfied: (value, expectations) => expectations.every((e) => value.includes(e)),
      apply: (value) => applied.push(value),
      onError: (error) => errors.push(error),
      attempts: 1,
      sleep: noSleep,
    });

    const settled = Promise.all([loader.run(1), loader.run(2)]);

    // The read fails after `2` was already queued behind it. Ending the loop here would strand
    // `2` for good: the gate has recorded its event, so no redelivery would come to correct it.
    first.promise.catch(() => undefined);
    first.resolve(Promise.reject(new Error('offline')) as unknown as number[]);
    await flush();

    expect(errors).toHaveLength(1);
    expect(started).toBe(2);

    second.resolve([1, 2]);
    await settled;

    expect(applied).toEqual([[1, 2]]);
  });

  it('reports the failure and applies nothing when there is no value', async () => {
    const applied: number[][] = [];
    const errors: unknown[] = [];

    const loader = createCoalescingLoader<number, number[]>({
      read: () => Promise.reject(new Error('offline')),
      satisfied: () => true,
      apply: (value) => applied.push(value),
      onError: (error) => errors.push(error),
      attempts: 2,
      sleep: noSleep,
    });

    await loader.run();

    expect(applied).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('absorbs a transient failure inside the retry budget', async () => {
    const applied: number[][] = [];
    const errors: unknown[] = [];
    let call = 0;

    const loader = createCoalescingLoader<number, number[]>({
      read: () => {
        call += 1;
        return call === 1 ? Promise.reject(new Error('blip')) : Promise.resolve([1]);
      },
      satisfied: (value, expectations) => expectations.every((e) => value.includes(e)),
      apply: (value) => applied.push(value),
      onError: (error) => errors.push(error),
      attempts: 3,
      sleep: noSleep,
    });

    await loader.run(1);

    // One failed read while waiting for a projection is indistinguishable from a slow one.
    expect(errors).toEqual([]);
    expect(applied).toEqual([[1]]);
  });
});
