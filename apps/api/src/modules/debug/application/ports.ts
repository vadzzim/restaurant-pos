import type { PresenceEntry, PresenceReport, SharedCounterName } from '@pos/contracts';

/**
 * The two things `/debug` needs from Redis, as ports rather than clients.
 *
 * Redis is soft (ADR 011, ADR 014) and `buildApp()` must stay free of infrastructure (ADR 006), so
 * an injected test app gets neither and says so on screen instead of failing. `index.ts` supplies
 * the Redis-backed implementations.
 */

export interface PresenceStore {
  /** Write or refresh one terminal's entry, with a TTL. Called on subscribe and on each heartbeat. */
  touch: (report: PresenceReport, socketId: string) => Promise<void>;
  /** Eager cleanup on disconnect. The TTL is what covers everything that never gets here. */
  forget: (terminalId: string) => Promise<void>;
  list: () => Promise<PresenceEntry[]>;
}

/**
 * Counters whose fact happens in the worker and has no row anywhere. Reading returns `null` when
 * Redis cannot answer — never a zero, which would read as "no duplicates" during an outage.
 */
export interface SharedCounterStore {
  read: () => Promise<Record<SharedCounterName, number> | null>;
}

/** How many sockets this instance holds right now. A gauge, not a counter: it goes down. */
export type SocketGauge = () => number;
