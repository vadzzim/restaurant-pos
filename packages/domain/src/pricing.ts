import type { OrderItemSnapshot } from '@pos/contracts';

/** Money is integer cents. There is no floating point anywhere on this path. */
export function calculateTotalCents(items: readonly OrderItemSnapshot[]): number {
  return items.reduce((total, item) => total + item.quantity * item.unitPriceCents, 0);
}
