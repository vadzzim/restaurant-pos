import {
  maxPublishDelayMs,
  SIMULATOR_CONTROLS,
  type SimulatorResponse,
  type SimulatorState,
} from '@pos/contracts';
import {
  readOutboxControls,
  readPrinterControls,
  setOutboxControls,
  setPrinterControls,
  type Db,
} from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { validationFailed } from '../../../shared/errors.js';
import { replayLastEvent } from '../application/replay-last-event.js';

export interface SimulatorRouteOptions {
  db: Db;
  /** The publisher's lease, which is what bounds a usable `Delay Outbox Publishing`. */
  outboxLeaseMs: number;
}

/**
 * §18's failure simulator, server side: **one endpoint pair for four controls**, deliberately.
 *
 * §17 lists a single debug write, `POST /api/debug/flags/:key` (M13), and five endpoints for four
 * switches would have been four times the surface for no extra expressiveness. So this is shaped
 * like the one M13 will add — a control in the path, a small body, the new state returned — and
 * ADR 015 records why.
 *
 * The other seven §18 controls never reach this file. They are switches inside one browser, and an
 * endpoint for them would mean the server holding per-tab state it could not expire correctly.
 *
 * Every switch here is a row in PostgreSQL: fleet-wide, and it outlives the process that obeys it.
 * The page says so next to each button, because the difference between these and the browser ones
 * is the thing worth showing.
 */
export function registerSimulatorRoutes(
  app: FastifyInstance,
  options: SimulatorRouteOptions,
): void {
  const { db, outboxLeaseMs } = options;
  const delayCeiling = maxPublishDelayMs(outboxLeaseMs);

  async function readState(): Promise<SimulatorState> {
    const [outbox, printer] = await Promise.all([readOutboxControls(db), readPrinterControls(db)]);
    return { outbox, printer };
  }

  const enabledBody = z.object({ enabled: z.boolean() });
  const delayBody = z.object({
    // The ceiling is the publisher's, not an arbitrary number: a delay past it turns every pass
    // into claim, wait, release, publish nothing — a pause wearing a delay's clothes.
    publishDelayMs: z.number().int().min(0).max(delayCeiling),
  });

  function parse<T>(schema: z.ZodType<T>, body: unknown, hint: string): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw validationFailed(hint, parsed.error);
    }
    return parsed.data;
  }

  app.get('/api/debug/simulator', async (): Promise<SimulatorResponse> => ({
    state: await readState(),
  }));

  app.post<{ Params: { control: string } }>(
    '/api/debug/simulator/:control',
    async (request): Promise<SimulatorResponse> => {
      // A zod enum on the path segment, so an unknown control is a 400 with the list of real ones
      // rather than a 404 that looks like the whole endpoint is missing — and so the switch below
      // is exhaustive over the union instead of over `string`.
      const control = parse(
        z.enum(SIMULATOR_CONTROLS),
        request.params.control,
        `control must be one of: ${SIMULATOR_CONTROLS.join(', ')}.`,
      );

      switch (control) {
        case 'outbox-pause': {
          const { enabled } = parse(
            enabledBody,
            request.body,
            'Body must be { enabled: boolean }.',
          );
          await setOutboxControls(db, { paused: enabled });
          // Not instant and not per-worker: the publisher sees this within one `OUTBOX_POLL_MS`,
          // and the row is fleet-wide. Both are stated on the page rather than only here.
          return { state: await readState() };
        }

        case 'outbox-delay': {
          const { publishDelayMs } = parse(
            delayBody,
            request.body,
            `publishDelayMs must be an integer between 0 and ${delayCeiling}.`,
          );
          await setOutboxControls(db, { publishDelayMs });
          return { state: await readState() };
        }

        case 'printer-fail': {
          const { enabled } = parse(
            enabledBody,
            request.body,
            'Body must be { enabled: boolean }.',
          );
          await setPrinterControls(db, { failing: enabled });
          return { state: await readState() };
        }

        case 'replay-last-event': {
          // A one-shot, not a switch, and the only control here whose body is empty. It returns
          // what it put back in flight so the page can name the event rather than say "done".
          const replayed = await replayLastEvent(db);
          return { state: await readState(), replayed };
        }
      }
    },
  );
}
