import {
  PRESENCE_KEY_PATTERN,
  SHARED_COUNTER_NAMES,
  presenceKey,
  sharedCounterKey,
  type PresenceEntry,
  type PresenceReport,
  type SharedCounterName,
} from '@pos/contracts';
import type { Redis } from 'ioredis';

import type { PresenceStore, SharedCounterStore } from '../application/ports.js';

/**
 * Presence and the shared counters, on Redis.
 *
 * Every method here is bounded and every method here may fail, because Redis is soft: nothing on
 * this path may keep a socket from connecting or a debug page from rendering. The client passed in
 * is expected to be a *bounded* one — `commandTimeout` set, `enableOfflineQueue` off — for the
 * same reason the health probe uses its own connection rather than the adapter's: a command that
 * waits for ever is the outage it was sent to observe.
 */
export function createRedisPresenceStore(redis: Redis, ttlMs: number): PresenceStore {
  return {
    touch: async (report: PresenceReport, socketId: string) => {
      const entry: PresenceEntry = {
        terminalId: report.terminalId,
        restaurantId: report.restaurantId,
        role: report.role,
        socketId,
        pendingCount: report.pendingCount,
        offline: report.offline,
        // Server time, deliberately. The staleness marking on screen compares this against the
        // server's clock, and a browser with a skewed clock would otherwise look permanently stale.
        lastSeenAt: new Date().toISOString(),
      };

      // `PX` rather than a separate EXPIRE: one round trip, and no window where a key exists
      // without a lifetime — which is precisely the "list that only grows" failure.
      await redis.set(presenceKey(report.terminalId), JSON.stringify(entry), 'PX', ttlMs);
    },

    forget: async (terminalId: string) => {
      await redis.del(presenceKey(terminalId));
    },

    list: async () => {
      const keys: string[] = [];
      let cursor = '0';

      // `SCAN`, not `KEYS`: this runs on the same Redis the Socket.IO adapter publishes broadcasts
      // through, and `KEYS` blocks the server for the length of the keyspace.
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', PRESENCE_KEY_PATTERN, 'COUNT', 100);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');

      if (keys.length === 0) {
        return [];
      }

      const values = await redis.mget(keys);

      return values
        .flatMap((value) => (value === null ? [] : [parseEntry(value)]))
        .flatMap((entry) => (entry === undefined ? [] : [entry]))
        .sort((left, right) => left.terminalId.localeCompare(right.terminalId));
    },
  };
}

/**
 * A key can expire between the `SCAN` and the `MGET`, and a value written by an older build may
 * not parse. Neither is worth failing the page for: the entry is dropped.
 */
function parseEntry(value: string): PresenceEntry | undefined {
  try {
    return JSON.parse(value) as PresenceEntry;
  } catch {
    return undefined;
  }
}

export function createRedisSharedCounters(redis: Redis): SharedCounterStore {
  return {
    read: async () => {
      const values = await redis.mget(SHARED_COUNTER_NAMES.map(sharedCounterKey));

      return Object.fromEntries(
        SHARED_COUNTER_NAMES.map((name, index) => [name, Number(values[index] ?? 0)]),
      ) as Record<SharedCounterName, number>;
    },
  };
}

/**
 * The write side of a shared counter, used by the API's own realtime consumer. Fire and forget by
 * contract: a duplicate event that was correctly suppressed must not become a failed message
 * handler because the counter could not be recorded.
 */
export function incrementSharedCounter(redis: Redis, name: SharedCounterName): void {
  void redis.incr(sharedCounterKey(name)).catch(() => undefined);
}
