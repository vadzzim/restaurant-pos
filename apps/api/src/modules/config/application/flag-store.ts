import { FEATURE_FLAG_KEYS, type FeatureFlagKey } from '@pos/contracts';
import { featureFlags, type Db } from '@pos/db';
import { asc, sql } from 'drizzle-orm';

/** One row of `feature_flags`, as the table holds it — before any restaurant is considered. */
export interface FlagRow {
  key: FeatureFlagKey;
  enabled: boolean;
  rolloutPercent: number;
  updatedAt: string;
}

/** What `POST /api/debug/flags/:key` may change. One field at a time, like the M12 controls. */
export interface FlagPatch {
  enabled?: boolean | undefined;
  rolloutPercent?: number | undefined;
}

const KNOWN = new Set<string>(FEATURE_FLAG_KEYS);

/**
 * Every known flag, in key order.
 *
 * Rows whose key is not in `FEATURE_FLAG_KEYS` are dropped rather than returned as strings: the
 * table outlives the code that reads it, and a flag nothing in this build understands must not
 * reach a `Record<FeatureFlagKey, boolean>` that the client indexes by a literal union.
 */
export async function readFlagRows(db: Db): Promise<FlagRow[]> {
  const rows = await db
    .select({
      key: featureFlags.key,
      enabled: featureFlags.enabled,
      rolloutPercent: featureFlags.rolloutPercent,
      updatedAt: featureFlags.updatedAt,
    })
    .from(featureFlags)
    .orderBy(asc(featureFlags.key));

  return rows
    .filter((row) => KNOWN.has(row.key))
    .map((row) => ({
      key: row.key as FeatureFlagKey,
      enabled: row.enabled,
      rolloutPercent: row.rolloutPercent,
      updatedAt: row.updatedAt.toISOString(),
    }));
}

/**
 * Upserts one flag, patching only the fields the caller named — the same rule as
 * `setOutboxControls`: a toggle must not silently reset a rollout percentage the operator set two
 * minutes ago, and a percentage must not turn the master switch back on.
 *
 * The insert branch exists for a database seeded before the key did; it is not the normal path.
 */
export async function writeFlag(db: Db, key: FeatureFlagKey, patch: FlagPatch): Promise<void> {
  await db
    .insert(featureFlags)
    .values({
      key,
      enabled: patch.enabled ?? false,
      rolloutPercent: patch.rolloutPercent ?? 0,
    })
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: {
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.rolloutPercent === undefined ? {} : { rolloutPercent: patch.rolloutPercent }),
        updatedAt: sql`now()`,
      },
    });
}
