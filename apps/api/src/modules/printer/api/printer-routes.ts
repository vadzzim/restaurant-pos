import {
  PRINTER_IDEMPOTENCY_HEADER,
  type PrintTicketRequest,
  type PrintTicketResponse,
} from '@pos/contracts';
import { readPrinterControls, type Db } from '@pos/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApiError, validationFailed } from '../../../shared/errors.js';
import { renderTicket, type FakePrinter } from '../application/fake-printer.js';

const ticketSchema = z.object({
  orderId: z.uuid(),
  restaurantId: z.string().min(1),
  tableNumber: z.string().min(1),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        name: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPriceCents: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

/**
 * The fake local printer (§12.3). It is not in §17's endpoint list because it is not part of the
 * API's contract with the POS: it stands in for a device on the kitchen wall, and the print worker
 * is its only client. Recorded in docs/build-log.md alongside `GET /api/kitchen/tickets`.
 *
 * Two failure modes are deliberate:
 *
 * - **no `Idempotency-Key` → 400.** A printer that deduplicates only when asked nicely would let a
 *   caller opt out of the one guarantee this endpoint offers, and §21.14 would then be testing a
 *   convention rather than a contract.
 * - **`Fail Printer` → 503.** The switch is read per request rather than cached, so flipping it
 *   from `/debug` (M12) or the CLI takes effect on the very next attempt with nothing to restart.
 *   A 503 is the honest status: the ticket did not print and retrying later is the answer, which is
 *   exactly what the worker does with it.
 */
export function registerPrinterRoutes(app: FastifyInstance, db: Db, printer: FakePrinter): void {
  app.post('/api/printer/print', async (request): Promise<PrintTicketResponse> => {
    const key = request.headers[PRINTER_IDEMPOTENCY_HEADER];
    if (typeof key !== 'string' || key.length === 0) {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        `${PRINTER_IDEMPOTENCY_HEADER} is required: this device deduplicates on it.`,
      );
    }

    const parsed = ticketSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailed('The ticket could not be read.', parsed.error);
    }

    const controls = await readPrinterControls(db);
    if (controls.failing) {
      throw new ApiError(503, 'PRINTER_OFFLINE', 'The printer is offline.');
    }

    const ticket: PrintTicketRequest = parsed.data;
    const receipt = printer.accept(key);

    request.log.info(
      {
        orderId: ticket.orderId,
        restaurantId: ticket.restaurantId,
        receiptId: receipt.receiptId,
        printed: receipt.printed,
        ticket: renderTicket(ticket),
      },
      receipt.printed ? 'printer emitted a ticket' : 'printer recognised an idempotency key',
    );

    return receipt;
  });
}
