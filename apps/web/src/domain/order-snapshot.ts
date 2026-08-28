import type { OrderSnapshot } from '@pos/contracts';

/**
 * A snapshot may only move forward. Socket events fire refetches without waiting for each other,
 * so two `GET /api/orders/:id` calls can be in flight at once and the older response can land
 * last; adopting it unconditionally would roll the screen back to a state the server has already
 * left. The version is monotonic per order, which makes this check exact rather than heuristic.
 *
 * A snapshot for a *different* order is accepted, because that is how a mutation response installs
 * a newly created order. That is right for a response and wrong for a refetch, so `refetch` checks
 * separately that the order it asked about is still the one on screen — `acceptsSnapshot` alone
 * cannot tell the two callers apart.
 *
 * **It lives here, outside both the store and the repository, because both obey it.** Memory and
 * disk have to agree about which snapshot is newer, and a rule stated twice is a rule that will
 * eventually disagree with itself. `stores/order.ts` applies it in `adopt`; `local-store.ts`
 * applies it inside the write transaction that caches a snapshot.
 */
export function acceptsSnapshot(held: OrderSnapshot | undefined, incoming: OrderSnapshot): boolean {
  if (held === undefined || held.id !== incoming.id) {
    return true;
  }

  return incoming.version >= held.version;
}
