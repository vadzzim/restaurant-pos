import type { FlagCache, FlagCacheRead } from '../application/resolve-flags.js';
import type { FlagRow } from '../application/flag-store.js';

/** One key for the whole set: the flags are read together and invalidated together. */
const FLAGS_KEY = 'config:feature-flags';

/**
 * The invalidation counter. Separate from the value, and with **no expiry**: it is what a cached
 * payload is compared against, and a version that vanished while a payload survived would make a
 * stale payload readable again.
 */
const VERSION_KEY = 'config:feature-flags:version';

/** A missing counter reads as this, so the first fill has something to present. */
const NO_VERSION = '0';

/**
 * The three commands this cache uses, rather than `Redis` itself.
 *
 * A real `ioredis` client satisfies it, and so does an in-memory double — which is what lets the
 * conditional fill be tested for the interleaving it exists to prevent without a live Redis.
 */
export interface FlagRedis {
  mget: (...keys: string[]) => Promise<(string | null)[]>;
  set: (key: string, value: string, mode: 'PX', ttlMs: number) => Promise<unknown>;
  incr: (key: string) => Promise<number>;
}

/** What `FLAGS_KEY` holds: the rows, and the version they were read at. */
interface CachedFlags {
  version: string;
  rows: FlagRow[];
}

function parse(value: string | null): CachedFlags | undefined {
  if (value === null) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }

    const { version, rows } = parsed as Partial<CachedFlags>;
    return typeof version === 'string' && Array.isArray(rows) ? { version, rows } : undefined;
  } catch {
    return undefined;
  }
}

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
 *
 * **The value is versioned** (ADR 019). Cache-aside has a race that a plain delete does not close:
 * a request that missed reads the rows, a toggle commits and invalidates, and the late fill puts
 * the pre-toggle rows back for one TTL — so §15's "fleet-wide and immediate" would be false for
 * exactly one interval of the fleet's config poll. Here the payload carries the version it was
 * filled at, and a payload whose version no longer matches the counter reads as a miss. A stale
 * fill is therefore not merely refused: it is unreadable even when it lands.
 */
export function createRedisFlagCache(redis: FlagRedis, ttlMs: number): FlagCache {
  return {
    // One round trip for both keys, so the payload and the version compared against it are the
    // ones that existed at the same instant.
    read: async (): Promise<FlagCacheRead> => {
      const [value, counter] = await redis.mget(FLAGS_KEY, VERSION_KEY);
      const version = counter ?? NO_VERSION;
      const cached = parse(value ?? null);

      return cached !== undefined && cached.version === version
        ? { hit: true, rows: cached.rows }
        : { hit: false, version };
    },

    // `PX` in the same command as the value: a key that could exist without a lifetime is a flag
    // state that could outlive the row it was copied from. The TTL is the backstop; the version is
    // what makes the toggle immediate.
    write: async (rows: FlagRow[], version: string) => {
      const payload: CachedFlags = { version, rows };
      await redis.set(FLAGS_KEY, JSON.stringify(payload), 'PX', ttlMs);
    },

    // One command, and it neither reads nor writes the value. Two instances toggling at once both
    // increment, so neither one's in-flight fill can become the cached answer.
    invalidate: async () => {
      await redis.incr(VERSION_KEY);
    },
  };
}
