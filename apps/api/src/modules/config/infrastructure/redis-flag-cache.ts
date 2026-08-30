import type { Redis } from 'ioredis';

import type { FlagCache } from '../application/resolve-flags.js';
import type { FlagRow } from '../application/flag-store.js';

/** One key for the whole set: the flags are read together and invalidated together. */
const FLAGS_KEY = 'config:feature-flags';

/**
 * §15's Redis cache in front of `feature_flags`.
 *
 * The client passed in is expected to be a **bounded** one — `commandTimeout` set,
 * `enableOfflineQueue` off — like the presence store's, and for a sharper reason: a cache lookup
 * that queues behind a Redis outage would make `/api/config` slower than the table it exists to
 * spare, on the request every terminal in the fleet makes every fifteen seconds.
 *
 * A malformed or older-shaped value is treated as a miss rather than parsed optimistically; the
 * table is always there to answer.
 */
export function createRedisFlagCache(redis: Redis, ttlMs: number): FlagCache {
  return {
    read: async () => {
      const value = await redis.get(FLAGS_KEY);
      if (value === null) {
        return undefined;
      }

      try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? (parsed as FlagRow[]) : undefined;
      } catch {
        return undefined;
      }
    },

    // `PX` in the same command as the value: a key that could exist without a lifetime is a flag
    // state that could outlive the row it was copied from.
    write: async (rows: FlagRow[]) => {
      await redis.set(FLAGS_KEY, JSON.stringify(rows), 'PX', ttlMs);
    },

    // Delete rather than overwrite. The next read repopulates from the table, so two instances
    // toggling at once cannot leave the loser's value cached.
    invalidate: async () => {
      await redis.del(FLAGS_KEY);
    },
  };
}
