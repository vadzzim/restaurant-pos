import type { DomainEvent } from '@pos/contracts';

export type GateVerdict =
  /** Fresh news: refetch the snapshot. */
  | 'accepted'
  /** This exact event was already seen — at-least-once delivery (§12.2). */
  | 'duplicate'
  /** Not newer than what is already held, e.g. the echo of our own mutation. */
  | 'stale';

export interface EventGate {
  accept(event: DomainEvent, heldVersion: number): GateVerdict;
  readonly size: number;
}

/**
 * The client half of §12.2. Delivery over the socket is at-least-once *and* has a crash window in
 * which a broadcast is lost outright, so the client never treats a message as data: it drops
 * repeats by `eventId`, drops anything not newer than the version it already holds, and refetches
 * the canonical snapshot on reconnect (see `useConnectionStore`). What survives that filter is a
 * hint that the server has moved on.
 *
 * The seen set is bounded: a POS runs for a whole shift, and an unbounded set would grow with
 * every event of the day.
 */
export function createEventGate(historyLimit = 500): EventGate {
  const seen = new Set<string>();
  const order: string[] = [];

  return {
    accept(event: DomainEvent, heldVersion: number): GateVerdict {
      if (seen.has(event.eventId)) {
        return 'duplicate';
      }

      seen.add(event.eventId);
      order.push(event.eventId);
      while (order.length > historyLimit) {
        const evicted = order.shift();
        if (evicted !== undefined) {
          seen.delete(evicted);
        }
      }

      return event.version > heldVersion ? 'accepted' : 'stale';
    },

    get size(): number {
      return seen.size;
    },
  };
}
