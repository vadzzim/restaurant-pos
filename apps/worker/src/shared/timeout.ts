/** What became of a promise that was given a deadline. */
export type Settled<T> =
  | { kind: 'resolved'; value: T }
  | { kind: 'rejected'; error: unknown }
  /** Still outstanding when the deadline passed. The work itself is **not** cancelled. */
  | { kind: 'overran' };

/**
 * Waits for a promise for at most `timeoutMs` and reports which of the three things happened,
 * rather than throwing any of them. Both callers want to branch on the difference — an enqueue
 * that failed and an enqueue that hung are different log lines, and at shutdown neither is fatal.
 *
 * The rejection is turned into a value **up front**, so a promise that is abandoned here always
 * has a handler: an unhandled rejection arriving later would take the worker down for a failure it
 * had already decided to tolerate. The same reasoning, and the same shape, as `sendWithinLease` in
 * the outbox publisher.
 */
export async function settleWithin<T>(work: Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  const settled: Promise<Settled<T>> = work.then(
    (value): Settled<T> => ({ kind: 'resolved', value }),
    (error: unknown): Settled<T> => ({ kind: 'rejected', error }),
  );

  let timer: NodeJS.Timeout | undefined;
  const overran = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'overran' });
    }, timeoutMs);
  });

  try {
    return await Promise.race([settled, overran]);
  } finally {
    clearTimeout(timer);
  }
}
