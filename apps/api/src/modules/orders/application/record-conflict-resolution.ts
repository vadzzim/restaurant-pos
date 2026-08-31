import type { ConflictResolution } from '@pos/contracts';
import type { Db } from '@pos/db';
import { sql } from 'drizzle-orm';

export interface ResolutionInput {
  orderId: string;
  terminalId: string;
  resolution: ConflictResolution;
  /** The mutations the client has actually unblocked. Never empty — the boundary refuses that. */
  mutationIds: readonly string[];
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
 * **Why a list of `mutationId`s, and not just the order and the terminal.** The operator's action is
 * not per mutation — Discard drops *the order's whole queue* for that terminal and Rebase re-issues
 * all of it — so the first version of this scoped the update to the order and the terminal alone.
 * That is wrong under Rebase, and the Codex review of M20 is where it was caught: a rebase that
 * conflicts again writes a **new** `conflict_log` row, and the report is fire-and-forget, so a
 * request still in flight lands after that insert and closes the fresh conflict along with the old
 * one. `blockedMutations` would then read zero over a queue that is still halted — the exact lie
 * this endpoint exists to remove.
 *
 * Naming the ids removes the race outright rather than narrowing it: a rebase re-issues under a
 * **new** `mutationId` (§14.1), so a conflict raised after this call cannot be one of the ids in it,
 * whenever the request happens to arrive. The client sends the ids that have actually left its
 * queue, which is also what makes a failed Discard or a Rebase that could not swap report nothing.
 *
 * **It is observability, not domain state.** Nothing reads `resolution` except `/debug`, so this is
 * a report and not a command: it is not idempotency-keyed, it is not in the mutation transaction,
 * and the client sends it best-effort. Offline it never arrives, and the row stays `null` — which
 * is the honest answer, because offline nobody can see `/debug` either.
 */
export async function recordConflictResolution(db: Db, input: ResolutionInput): Promise<number> {
  const ids = sql.join(
    input.mutationIds.map((mutationId) => sql`${mutationId}::uuid`),
    sql`, `,
  );

  // `order_id` and `terminal_id` stay in the predicate even though `mutation_id` is unique on its
  // own: they are what stops a client closing a row that belongs to another till or another order.
  const result = await db.execute(sql`
    update conflict_log
    set resolution = ${input.resolution}
    where order_id = ${input.orderId}::uuid
      and terminal_id = ${input.terminalId}
      and mutation_id in (${ids})
      and resolution is null
  `);

  return result.rowCount ?? 0;
}
