import {
  FEATURE_FLAG_KEYS,
  flagAppliesTo,
  flagBucket,
  type FeatureFlagKey,
  type FlagState,
} from '@pos/contracts';
import { RESTAURANTS, type Db } from '@pos/db';

import { readFlagRows, type FlagRow } from './flag-store.js';

/**
 * The §15 cache, as a port rather than a Redis client (ADR 006): `buildApp()` without one reads the
 * table on every request and every `fastify.inject` test stays free of infrastructure.
 *
 * **Every method may fail and the caller must not care.** Redis is soft here in the strongest
 * sense: this is the read in front of `/api/config`, which the whole fleet polls every 15 s, and a
 * cache outage that took the transport decision with it would be the outage §15 exists to avoid.
 */
export interface FlagCache {
  /** The cached rows, or `undefined` for a miss — never an error the caller has to handle. */
  read: () => Promise<FlagRow[] | undefined>;
  write: (rows: FlagRow[]) => Promise<void>;
  /** Called after a write. A toggle is fleet-wide and immediate, not "within the TTL". */
  invalidate: () => Promise<void>;
}

/**
 * The flag rows, cache first, table second.
 *
 * The fill is awaited rather than fired and forgotten so a failing Redis cannot leave one rejected
 * promise per request unobserved; it is swallowed for the same reason the read is — the answer is
 * already in hand and the caller is a client waiting on its transport.
 */
export async function loadFlags(db: Db, cache?: FlagCache): Promise<FlagRow[]> {
  const cached = await cache?.read().catch(() => undefined);
  if (cached !== undefined) {
    return cached;
  }

  const rows = await readFlagRows(db);
  await cache?.write(rows).catch(() => undefined);
  return rows;
}

/**
 * A write, and then the invalidation that makes it visible to every instance rather than only to
 * the one that served the POST. Failing to invalidate is logged nowhere and swallowed here: the
 * row is written, and the worst case is one TTL of staleness on a demo toggle.
 */
export async function invalidateFlags(cache?: FlagCache): Promise<void> {
  await cache?.invalidate().catch(() => undefined);
}

/**
 * §15's rule, applied for one restaurant. A key with no row resolves to `false`: an unknown flag is
 * an unshipped feature, and defaulting the other way would ship it during a failed migration.
 */
export function resolveFor(rows: FlagRow[], restaurantId: string): Record<FeatureFlagKey, boolean> {
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return Object.fromEntries(
    FEATURE_FLAG_KEYS.map((key) => {
      const row = byKey.get(key);
      return [key, row === undefined ? false : flagAppliesTo(key, restaurantId, row)];
    }),
  ) as Record<FeatureFlagKey, boolean>;
}

/**
 * The rows plus what they mean for each seeded restaurant, which is what `/debug` renders. The
 * bucket is on screen deliberately: a percentage alone leaves the operator guessing which way a
 * restaurant will fall, and the demo depends on knowing that 10 % splits these two.
 */
export function describeFlags(rows: FlagRow[]): FlagState[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return FEATURE_FLAG_KEYS.map((key) => {
    const row = byKey.get(key) ?? {
      key,
      enabled: false,
      rolloutPercent: 0,
      updatedAt: new Date(0).toISOString(),
    };

    return {
      ...row,
      resolved: RESTAURANTS.map((restaurant) => ({
        restaurantId: restaurant.id,
        enabled: flagAppliesTo(key, restaurant.id, row),
        bucket: flagBucket(key, restaurant.id),
      })),
    };
  });
}
