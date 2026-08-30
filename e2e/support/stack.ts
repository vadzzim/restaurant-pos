import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * The preflight this spec needs, and why it is in the spec rather than in `verify-e2e.mjs`.
 *
 * Four of §18's controls are rows in PostgreSQL (ADR 015): fleet-wide, and they outlive the process
 * that obeys them. A `Pause Outbox Publishing` left armed by a demo makes this test fail exactly
 * the way a broken broker would. `realtime.websocket_push` has the same shape from the other side:
 * the seed writes it with `onConflictDoNothing`, so a flag turned off by hand survives a re-seed.
 *
 * Putting the reset here rather than in the script means `pnpm test:e2e:run` — the spec alone,
 * against the stack a developer already has up, which is the machine most likely to be carrying a
 * demo's leftovers — gets the same guarantee.
 */
export async function resetServerSideState(api: APIRequestContext): Promise<void> {
  const responses = await Promise.all([
    api.post('/api/debug/simulator/outbox-pause', { data: { enabled: false } }),
    api.post('/api/debug/simulator/outbox-delay', { data: { publishDelayMs: 0 } }),
    api.post('/api/debug/simulator/printer-fail', { data: { enabled: false } }),
    // Not because the test needs push — the polling fallback would carry it (§13) — but because a
    // three-second poll and a WebSocket fail in different places, and a spec that silently ran on
    // the fallback would stop testing the transport §13 is about.
    api.post('/api/debug/flags/realtime.websocket_push', {
      data: { enabled: true, rolloutPercent: 100 },
    }),
  ]);

  // Asserted, not ignored: if the reset did not land, the failure that follows would be blamed on
  // the pipeline. `expect` rather than a thrown string so the report names the request.
  for (const response of responses) {
    expect(response, `${response.url()} should have accepted the reset`).toBeOK();
  }
}

/**
 * The cover this run opens.
 *
 * The database is never reset between runs — the demo data is the point — so the kitchen rail
 * accumulates tickets, and `Table 5` would be ambiguous by the second run. Every locator in the
 * spec is scoped to the card carrying this string.
 */
export function uniqueTableNumber(): string {
  return `E2E-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * How long a cross-process assertion waits.
 *
 * Send to kitchen returns when the mutation commits. The ticket appears only after the publisher
 * claims the outbox row, Redpanda delivers it and the kitchen consumer commits its projection: a
 * poll interval plus a broker round trip. Not a group join — `verify-e2e.mjs` waits for both
 * consumer groups to have their assignment before it starts the spec, precisely so that a
 * rebalance is never charged to an assertion. Nothing here sleeps; this is the budget instead.
 */
export const PIPELINE_TIMEOUT_MS = 45_000;

/** A same-process update: the POS re-reading its own aggregate after a mutation it just sent. */
export const LOCAL_TIMEOUT_MS = 15_000;
