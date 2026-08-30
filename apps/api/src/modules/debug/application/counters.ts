/**
 * The in-process half of §20, in **one module**.
 *
 * The alternative — a `metrics.inc()` sprinkled across twenty call sites — is how a counter list
 * rots: a branch is added, nobody increments it, and the number stays plausible while being wrong.
 * Everything here is instead incremented from the handful of places that are already the single
 * chokepoint for the thing they count: the Fastify `onResponse` hook, `executeMutation`, the
 * realtime consumer, and the Socket.IO server's own client count.
 *
 * **These numbers are this process's, and they reset when it restarts.** That is not a defect to
 * be hidden — it is reported as `source: 'process'` on every reading, because a counter that
 * silently resets is worse than no counter. Everything that has a durable row is derived from the
 * database instead (see `metrics.ts`), and exactly one fact that has neither lives in Redis.
 */

/** Every in-process counter. Closed on purpose: an unknown name is a typo, not a new metric. */
export const PROCESS_COUNTER_NAMES = [
  'apiRequests',
  'apiErrors',
  'mutationsReceived',
  'mutationsApplied',
  'duplicateMutationsPrevented',
  'mutationIdReuseRejected',
  'crossTenantRejections',
  'realtimeEventsBroadcast',
] as const;

export type ProcessCounterName = (typeof PROCESS_COUNTER_NAMES)[number];

export type ProcessCounters = Record<ProcessCounterName, number>;

function zeroed(): ProcessCounters {
  return Object.fromEntries(PROCESS_COUNTER_NAMES.map((name) => [name, 0])) as ProcessCounters;
}

let counters = zeroed();

export function incrementCounter(name: ProcessCounterName, by = 1): void {
  counters[name] += by;
}

/** A copy, so a reader cannot mutate the registry by holding on to what it was given. */
export function readCounters(): ProcessCounters {
  return { ...counters };
}

/**
 * Test seam. Module state is process-wide, so without this the third test in a file would be
 * asserting against the first two tests' traffic.
 */
export function resetCounters(): void {
  counters = zeroed();
}
