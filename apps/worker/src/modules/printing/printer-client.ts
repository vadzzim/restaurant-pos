import { PRINTER_IDEMPOTENCY_HEADER, type PrintTicketResponse } from '@pos/contracts';

import type { PrintableTicket } from './ticket-hash.js';

/**
 * The device, as the processor sees it. An interface because the tests need a printer that can be
 * told to fail on command without an HTTP server, and because the real one is a fake anyway.
 */
export interface Printer {
  print(ticket: PrintableTicket, idempotencyKey: string): Promise<PrintTicketResponse>;
}

export interface HttpPrinterOptions {
  url: string;
  timeoutMs: number;
}

/**
 * Posts to the fake printer endpoint and **throws on anything that is not a 2xx**, because the
 * processor's contract with BullMQ is that a rejected promise means "retry this". A 503 from
 * `Fail Printer` and a socket that never opened are the same thing here: the ticket did not print.
 *
 * The timeout is an `AbortSignal` rather than a `Promise.race`, so a printer that accepts the
 * connection and then says nothing does not leak a request per attempt.
 */
export function httpPrinter({ url, timeoutMs }: HttpPrinterOptions): Printer {
  return {
    print: async (ticket, idempotencyKey) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PRINTER_IDEMPOTENCY_HEADER]: idempotencyKey,
        },
        body: JSON.stringify({
          orderId: ticket.orderId,
          restaurantId: ticket.restaurantId,
          tableNumber: ticket.tableNumber,
          items: ticket.items,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        // The body carries the §17 envelope; its `code` is the useful half of `last_error`.
        const detail = await response.text().catch(() => '');
        throw new Error(`printer answered ${response.status}: ${detail.slice(0, 200)}`);
      }

      return (await response.json()) as PrintTicketResponse;
    },
  };
}
