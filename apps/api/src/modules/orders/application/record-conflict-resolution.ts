import type { ConflictResolution } from '@pos/contracts';
import type { Db } from '@pos/db';
import { sql } from 'drizzle-orm';

export interface ResolutionInput {
  orderId: string;
  terminalId: string;
  resolution: ConflictResolution;
}

/**
 * Close the open `conflict_log` rows for one order on one terminal.
 *
 * **Why the resolution comes from the client at all.** §14.1's two ways out of a halt — Discard and
 * Rebase — both happen entirely in the browser: one deletes rows from IndexedDB, the other re-issues
 * them under new `mutationId`s. Neither is visible to the server, so until M20 `resolution` was
 * written `null` at insert and never written again. That made `/debug`'s **Conflict history** a list
 * that could only grow, and made `blockedMutations` — described as "a client queue still halted" —
 * a monotonic counter of every conflict that ever happened.
 *
 * **Why by order and terminal, and not by `mutationId`.** `known-problems.md` proposed a
 * `.../conflicts/:mutationId/resolution` route, but the client's action is not per mutation: Discard
 * drops *the order's whole queue* for that terminal and Rebase re-issues all of it. A halt can also
 * outlive the banner that named the mutation — reload the tab and the queue is still blocked while
 * the in-memory banner is gone. Order plus terminal is the granularity the operator actually acted
 * at, and it is the granularity that survives a reload.
 *
 * **It is observability, not domain state.** Nothing reads `resolution` except `/debug`, so this is
 * a report and not a command: it is not idempotency-keyed, it is not in the mutation transaction,
 * and the client sends it best-effort. Offline it never arrives, and the row stays `null` — which
 * is the honest answer, because offline nobody can see `/debug` either.
 */
export async function recordConflictResolution(db: Db, input: ResolutionInput): Promise<number> {
  const result = await db.execute(sql`
    update conflict_log
    set resolution = ${input.resolution}
    where order_id = ${input.orderId}::uuid
      and terminal_id = ${input.terminalId}
      and resolution is null
  `);

  return result.rowCount ?? 0;
}
