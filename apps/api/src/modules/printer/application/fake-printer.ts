import { randomUUID } from 'node:crypto';

import type { PrintTicketRequest, PrintTicketResponse } from '@pos/contracts';

/**
 * How many idempotency keys the device remembers. A real thermal printer's dedup window is a few
 * recent jobs held in its own memory; this is the same idea with a number attached, and it is
 * bounded so a long demo cannot grow the map without limit.
 */
const LEDGER_SIZE = 500;

export interface FakePrinter {
  /**
   * Accepts a ticket. A key already in the ledger is answered with the original receipt and
   * **nothing is emitted** — the property §21.14 tests, and a property of *this endpoint* rather
   * than a guarantee about hardware.
   */
  accept(idempotencyKey: string): PrintTicketResponse;
  /** How many tickets physically came out. The one number a duplicate must not move. */
  physicalPrints(): number;
}

/**
 * The device (§12.3). It lives in the API because the worker has to reach it over HTTP for the
 * demo to mean anything — an in-process function call could not fail the way a printer on a
 * kitchen wall fails.
 *
 * **Its memory is not durable, and that is the honest model.** Restarting the API empties the
 * ledger, so a retry that arrives afterwards prints a second ticket. Storing the ledger in
 * PostgreSQL would look more robust and would be a lie: the guarantee §12.3 claims is
 * at-least-once, and the paper is outside every transaction this system has.
 */
export function createFakePrinter(): FakePrinter {
  const ledger = new Map<string, string>();
  let prints = 0;

  return {
    accept: (idempotencyKey) => {
      const seen = ledger.get(idempotencyKey);
      if (seen !== undefined) {
        return { receiptId: seen, printed: false, duplicate: true };
      }

      const receiptId = randomUUID();
      ledger.set(idempotencyKey, receiptId);
      prints += 1;

      // Oldest first: `Map` preserves insertion order, so the eviction needs no bookkeeping of its
      // own. A key evicted here prints again if it comes back, which is the same window a real
      // device has and another reason §12.3 promises only at-least-once.
      if (ledger.size > LEDGER_SIZE) {
        const oldest = ledger.keys().next();
        if (!oldest.done) {
          ledger.delete(oldest.value);
        }
      }

      return { receiptId, printed: true, duplicate: false };
    },
    physicalPrints: () => prints,
  };
}

/** What the paper says, as one log line: the closest this demo gets to a physical ticket. */
export function renderTicket(ticket: PrintTicketRequest): string {
  const lines = ticket.items.map((item) => `${item.quantity}x ${item.name}`).join(', ');
  return `TABLE ${ticket.tableNumber} — ${lines}`;
}
