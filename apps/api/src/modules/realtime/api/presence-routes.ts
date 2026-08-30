import type { FastifyInstance } from 'fastify';

import type { PresenceStore } from '../../debug/application/ports.js';
import { validationFailed } from '../../../shared/errors.js';
import { presenceReportSchema } from '../presence-report.js';

export interface PresenceRouteOptions {
  presence?: PresenceStore | undefined;
}

/**
 * Presence over HTTP: the second path the heartbeat needed once polling became a real transport
 * (§13, §15). A terminal that has declined the socket still belongs on `/debug`'s active-terminal
 * panel — it is the panel where "these two terminals are on different transports" is visible, so a
 * polling terminal missing from it would be the rollout demo hiding its own effect.
 *
 * **Not in §17's endpoint list**, like `GET /api/kitchen/tickets`; `known-problems.md` says so.
 * Riding the beat on `GET /api/config` was the alternative and was rejected twice over: that poll
 * is three times too slow for `PRESENCE_TTL_MS`, and a GET that writes is a GET that lies.
 *
 * Answers `202` with no body. Nothing the client does depends on the write, and presence is
 * best-effort throughout — Redis is soft, and a terminal whose entry could not be recorded must
 * still be taking orders.
 */
export function registerPresenceRoutes(app: FastifyInstance, options: PresenceRouteOptions): void {
  app.post('/api/presence', async (request, reply): Promise<void> => {
    const parsed = presenceReportSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailed('Body must be a presence report.', parsed.error);
    }

    try {
      await options.presence?.touch(parsed.data, { source: 'polling' });
    } catch (error) {
      // Logged at `debug` for the same reason the socket path does it: during a Redis outage this
      // fires once per terminal per heartbeat, and a line per beat would bury the outage itself.
      request.log.debug(
        { err: error, terminalId: parsed.data.terminalId },
        'could not record presence',
      );
    }

    await reply.status(202).send();
  });
}
