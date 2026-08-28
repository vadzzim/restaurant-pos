export interface RefetchUntilOptions {
  /** Total reads, including the first. */
  attempts?: number;
  /** Delay before the second read; each further wait grows by the same step. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RefetchOutcome<T> {
  value: T;
  /** False means the budget ran out and `value` is the freshest read that still lagged. */
  converged: boolean;
  attempts: number;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Read until what came back accounts for what we were told, or the budget runs out.
 *
 * The kitchen screen needs this and the POS does not, and the asymmetry is the whole point. A POS
 * reads `orders`, written by the very transaction that wrote the outbox row — by the time an event
 * exists, the row is already at that version, so one read always suffices. The kitchen reads
 * `kitchen_tickets`, built by a *different* consumer on a *different* group (ADR 006), so the
 * broadcast genuinely can arrive first. One read would then return a projection that has not
 * caught up, and because the client drops repeats by `eventId` there would be no second chance:
 * the ticket would stay invisible until someone reloaded the page.
 *
 * A read that *fails* is spent from the same budget rather than ending the wait: a single blip
 * while waiting for a projection is indistinguishable from the projection being slow, and both are
 * answered by trying again. Only when no read at all succeeded is there nothing to report and the
 * last error is thrown — the caller cannot be handed a value that was never fetched.
 *
 * The budget is bounded and its exhaustion is reported rather than swallowed — an unbounded wait
 * would turn a dead consumer into a spinner that never resolves.
 */
export async function refetchUntil<T>(
  read: () => Promise<T>,
  satisfied: (value: T) => boolean,
  options: RefetchUntilOptions = {},
): Promise<RefetchOutcome<T>> {
  const attempts = Math.max(1, options.attempts ?? 5);
  const delayMs = options.delayMs ?? 150;
  const sleep = options.sleep ?? wait;

  let value: T | undefined;
  let readOnce = false;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(delayMs * attempt);
    }

    try {
      value = await read();
      readOnce = true;
      lastError = undefined;

      if (satisfied(value)) {
        return { value, converged: true, attempts: attempt + 1 };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (!readOnce) {
    throw lastError;
  }

  const last = value as T;
  return { value: last, converged: lastError === undefined && satisfied(last), attempts };
}
