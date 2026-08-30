import type { ConfigResponse } from '@pos/contracts';
import type { Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { validationFailed } from '../../../shared/errors.js';
import { loadFlags, resolveFor, type FlagCache } from '../application/resolve-flags.js';

const querySchema = z.object({ restaurantId: z.string().min(1) });

export interface ConfigRouteOptions {
  db: Db;
  cache?: FlagCache | undefined;
}

/**
 * The resolved flag state for one restaurant (§15, §17), and the only endpoint the fleet polls on a
 * timer: every open client re-reads it every `CONFIG_POLL_MS` to notice a rollout change.
 *
 * That is what the cache in front of it is for. It is also why the answer is resolved **per
 * restaurant** rather than returned as rows: the browser must not be trusted to apply the rollout
 * rule, or two clients of the same restaurant could disagree about their own transport.
 */
export function registerConfigRoutes(app: FastifyInstance, options: ConfigRouteOptions): void {
  const { db, cache } = options;

  app.get('/api/config', async (request): Promise<ConfigResponse> => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      throw validationFailed('restaurantId is required.', query.error);
    }

    const rows = await loadFlags(db, cache);

    return {
      restaurantId: query.data.restaurantId,
      flags: resolveFor(rows, query.data.restaurantId),
    };
  });
}
