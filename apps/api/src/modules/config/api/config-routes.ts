import { FEATURE_FLAG_KEYS, type ConfigResponse, type FeatureFlagKey } from '@pos/contracts';
import { featureFlags, type Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError } from '../../../shared/errors.js';

const querySchema = z.object({ restaurantId: z.string().min(1) });

/**
 * The resolved flag state for one restaurant (§15, §17). M4 reads the table directly: the Redis
 * cache and the percentage-by-hash rollout are M13, and adding them here would be scope this
 * milestone cannot demonstrate.
 */
export function registerConfigRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/config', async (request): Promise<ConfigResponse> => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'restaurantId is required.', {
        issues: query.error.issues,
      });
    }

    const rows = await db
      .select({ key: featureFlags.key, enabled: featureFlags.enabled })
      .from(featureFlags);

    const enabled = new Map(rows.map((row) => [row.key, row.enabled]));
    const flags = Object.fromEntries(
      FEATURE_FLAG_KEYS.map((key) => [key, enabled.get(key) ?? false]),
    ) as Record<FeatureFlagKey, boolean>;

    return { restaurantId: query.data.restaurantId, flags };
  });
}
