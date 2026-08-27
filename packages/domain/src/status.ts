import type { OrderStatus } from '@pos/contracts';

/**
 * The full §3 lifecycle, declared once. M3 only walks OPEN -> SENT_TO_KITCHEN, but the later
 * transitions are already here so M5 extends the rules rather than this table.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  OPEN: ['SENT_TO_KITCHEN', 'PAID', 'CANCELLED'],
  SENT_TO_KITCHEN: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['PAID', 'CANCELLED'],
  PAID: [],
  CANCELLED: [],
};

export function isValidTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** A terminal status accepts no further modification at all (§8). */
export function isTerminalStatus(status: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}
