import { refetchUntil } from './refetch-until';

export interface CoalescingLoaderOptions<E, T> {
  read: () => Promise<T>;
  /** Whether one read accounts for every expectation collected for this round. */
  satisfied: (value: T, expectations: E[]) => boolean;
  /** The only place the result is written. Called once per round, never concurrently. */
  apply: (value: T, converged: boolean) => void;
  /** A round in which no read succeeded. There is no value to apply, only something to say. */
  onError?: (error: unknown) => void;
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CoalescingLoader<E> {
  run: (expectation?: E) => Promise<void>;
}

/**
 * One reader at a time, with everything that asked while it was reading folded into the next round.
 *
 * A list that is replaced wholesale cannot be loaded concurrently. Several events arrive close
 * together, each starts a read, and each finished read overwrites the whole list — so the answer to
 * the *first* event, delayed by its own wait for a lagging projection, can land after the answer to
 * the second and take an already-visible ticket back off the screen. The client drops repeats by
 * `eventId`, so nothing would arrive to correct it.
 *
 * Serialising alone would be wrong too. An expectation may only be judged by a read *issued after*
 * it was raised: a read already in flight was sent before the event existed, so it proves nothing
 * about it even when it happens to contain it. Each round therefore takes the expectations queued
 * when it starts, and anything raised while it reads forces one more round before the loader goes
 * idle. Dropping the late arrival instead — or checking it against the in-flight response — is the
 * subtler version of the same lost update.
 *
 * A round that fails outright must not end the loop either. Everything raised while it was reading
 * is still queued, and abandoning it there would strand exactly the expectations this loader exists
 * to honour: the gate has already recorded those events, so no redelivery would come to correct it.
 * The failure is reported, its own batch is given up on — the same concession the budget already
 * makes when a projection never catches up — and the loop carries on with whatever is waiting.
 */
export function createCoalescingLoader<E, T>(
  options: CoalescingLoaderOptions<E, T>,
): CoalescingLoader<E> {
  let queued: E[] = [];
  let running: Promise<void> | undefined;
  let again = false;

  const budget = {
    ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
    ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };

  async function drain(): Promise<void> {
    do {
      again = false;
      const batch = queued;
      queued = [];

      try {
        const outcome = await refetchUntil(
          options.read,
          (value) => options.satisfied(value, batch),
          budget,
        );

        options.apply(outcome.value, outcome.converged);
      } catch (error) {
        options.onError?.(error);
      }
    } while (again || queued.length > 0);
  }

  return {
    run: (expectation?: E): Promise<void> => {
      if (expectation !== undefined) {
        queued.push(expectation);
      }

      if (running !== undefined) {
        again = true;
        return running;
      }

      running = drain().finally(() => {
        running = undefined;
      });

      return running;
    },
  };
}
