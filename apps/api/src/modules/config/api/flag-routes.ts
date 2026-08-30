import { FEATURE_FLAG_KEYS, type FlagsResponse } from '@pos/contracts';
import type { Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { validationFailed } from '../../../shared/errors.js';
import { writeFlag } from '../application/flag-store.js';
import {
  describeFlags,
  invalidateFlags,
  loadFlags,
  type FlagCache,
} from '../application/resolve-flags.js';

export interface FlagRouteOptions {
  db: Db;
  cache?: FlagCache | undefined;
}

/**
 * §17's `POST /api/debug/flags/:key`, and the `GET` that lets `/debug` render it.
 *
 * Deliberately the same shape as M12's simulator pair (ADR 015): a zod enum on the path segment so
 * an unknown flag is a 400 naming the real ones, a small body, and the new state in the response so
 * a button never has to wait for a poll to show what it did. Two debug write surfaces built two
 * ways would be two things to reason about for no gain.
 *
 * The read goes through the cache like `/api/config` does; the write goes to the table and then
 * invalidates, so the toggle is fleet-wide and takes effect without a restart (§15).
 */
export function registerFlagRoutes(app: FastifyInstance, options: FlagRouteOptions): void {
  const { db, cache } = options;

  async function currentState(): Promise<FlagsResponse> {
    return { flags: describeFlags(await loadFlags(db, cache)) };
  }

  /**
   * At least one field, because `{}` would be a request that reports success and changes nothing —
   * the one answer a toggle must never give.
   */
  const patchBody = z
    .object({
      enabled: z.boolean().optional(),
      rolloutPercent: z.number().int().min(0).max(100).optional(),
    })
    .refine(
      (body) => body.enabled !== undefined || body.rolloutPercent !== undefined,
      'Provide enabled, rolloutPercent, or both.',
    );

  app.get('/api/debug/flags', async (): Promise<FlagsResponse> => currentState());

  app.post<{ Params: { key: string } }>(
    '/api/debug/flags/:key',
    async (request): Promise<FlagsResponse> => {
      const key = z.enum(FEATURE_FLAG_KEYS).safeParse(request.params.key);
      if (!key.success) {
        throw validationFailed(`key must be one of: ${FEATURE_FLAG_KEYS.join(', ')}.`, key.error);
      }

      const patch = patchBody.safeParse(request.body);
      if (!patch.success) {
        throw validationFailed(
          'Body must be { enabled?: boolean, rolloutPercent?: 0-100 }.',
          patch.error,
        );
      }

      await writeFlag(db, key.data, patch.data);
      // Before the response, not after: the state this reply carries has to be the state the next
      // `GET /api/config` will resolve from, on this instance and on every other one.
      await invalidateFlags(cache);

      return currentState();
    },
  );
}
