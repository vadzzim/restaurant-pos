import type { MutationRequest, MutationResponse } from '@pos/contracts';
import { ref, type Ref } from 'vue';

/**
 * §18's **client-side** controls: the seven switches that live in one browser tab.
 *
 * They are here rather than behind an endpoint because that is genuinely where they belong. A
 * duplicate send is something a client does; a terminal pretending to be offline is a client that
 * refuses to call; a socket that is deliberately shut is a client that declines the transport.
 * Putting any of them on the server would mean the API holding per-tab state with no way to expire
 * it correctly. ADR 015 records the split.
 *
 * **The lifetime is the tab.** Module state survives the walk from `/debug` to `/pos/pos-1`, which
 * is exactly the flow these are for — arm a control on the debug page, then go and cause it. It
 * does *not* cross tabs, and the panel says so.
 *
 * The two `Simulate POS-n Offline` switches are not here: they were built in M8 and live in
 * `offline.ts`, where the API client's gate can reach them. The panel drives that module directly.
 */

/** The three one-shots. Each is spent by the next mutation it can act on, and no other. */
export type MutationArm =
  'duplicate-next-mutation' | 'reuse-mutation-id' | 'create-version-conflict';

/** The two latches. They stay thrown until thrown back, unlike the one-shots above. */
export type ClientLatch = 'socket-disabled' | 'polling-forced';

const arms = ref<Record<MutationArm, boolean>>({
  'duplicate-next-mutation': false,
  'reuse-mutation-id': false,
  'create-version-conflict': false,
});

const latches = ref<Record<ClientLatch, boolean>>({
  'socket-disabled': false,
  'polling-forced': false,
});

export const armStates: Ref<Record<MutationArm, boolean>> = arms;
export const latchStates: Ref<Record<ClientLatch, boolean>> = latches;

export const isArmed = (arm: MutationArm): boolean => arms.value[arm];
export const isLatched = (latch: ClientLatch): boolean => latches.value[latch];

export function setArm(arm: MutationArm, armed: boolean): void {
  arms.value = { ...arms.value, [arm]: armed };
}

export const toggleArm = (arm: MutationArm): boolean => {
  const next = !arms.value[arm];
  setArm(arm, next);
  return next;
};

export function setLatch(latch: ClientLatch, thrown: boolean): void {
  latches.value = { ...latches.value, [latch]: thrown };
}

export const toggleLatch = (latch: ClientLatch): boolean => {
  const next = !latches.value[latch];
  setLatch(latch, next);
  return next;
};

/**
 * What each control did, newest first.
 *
 * A one-shot fires on the POS screen, not on `/debug`, and its effect on the counters takes a poll
 * to appear. Without a log the operator arms a control, walks away, comes back, and has to infer
 * from a number whether it fired at all — so the page keeps the sentence as well as the number.
 */
export interface SimulatorEffect {
  at: string;
  control: string;
  detail: string;
}

const EFFECT_LIMIT = 20;

export const simulatorEffects = ref<SimulatorEffect[]>([]);

export function recordSimulatorEffect(control: string, detail: string): void {
  simulatorEffects.value = [
    { at: new Date().toISOString(), control, detail },
    ...simulatorEffects.value,
  ].slice(0, EFFECT_LIMIT);
}

export const clearSimulatorEffects = (): void => {
  simulatorEffects.value = [];
};

/** Test seam: no test should inherit another test's armed controls. */
export function resetSimulatorArms(): void {
  arms.value = {
    'duplicate-next-mutation': false,
    'reuse-mutation-id': false,
    'create-version-conflict': false,
  };
  latches.value = { 'socket-disabled': false, 'polling-forced': false };
  simulatorEffects.value = [];
}

/**
 * `Create Version Conflict`: send the next mutation at one version below the one the client
 * actually holds, so the server's `expected_version` guard refuses it (§8) and the queue halts
 * under §14.1 with a real `conflict_log` row behind it.
 *
 * **Only the wire request is tampered with.** The pending row in IndexedDB keeps its true
 * `baseVersion`, so Rebase still has something correct to re-stamp from.
 *
 * **It stays armed below v2.** Creation is defined at `baseVersion` 0 (§5) and every other mutation
 * is `z.number().int().min(1)` at the boundary, so tampering with a create *or* with the first
 * mutation on a v1 order produces a 400 `VALIDATION_ERROR` rather than a conflict — a different
 * demonstration wearing this one's label, and one that halts nothing. The arm waits for a mutation
 * it can genuinely make conflict, which is the first at v2 or above.
 */
export interface ArmedRequest {
  request: MutationRequest;
  /**
   * Called once the request has actually reached the server. **The arm is spent here and not when
   * it is applied**, because the two calls in front of it can both refuse to send: the offline gate
   * throws before `fetch`, and a dead network throws during it. An arm spent by a request that
   * never left the browser is a control that silently does nothing, which is the one thing a
   * demo switch must not be.
   *
   * The mirror of that: **a request the server answered spends the arm even when the answer was an
   * error envelope.** `CONFLICT` and `MUTATION_ID_REUSED` come back as values, but a 4xx from the
   * boundary is thrown, and an arm left armed by one goes on tampering with every later mutation
   * from this tab — a wedged till, from a control that was supposed to fire once.
   */
  spend: () => void;
}

/** The lowest `baseVersion` a decrement can leave valid. See the note above. */
const LOWEST_TAMPERABLE_VERSION = 2;

export function applyVersionConflictArm(request: MutationRequest): ArmedRequest {
  if (!isArmed('create-version-conflict') || request.baseVersion < LOWEST_TAMPERABLE_VERSION) {
    return { request, spend: () => undefined };
  }

  const tampered = { ...request, baseVersion: request.baseVersion - 1 } as MutationRequest;

  return {
    request: tampered,
    spend: () => {
      setArm('create-version-conflict', false);
      recordSimulatorEffect(
        'Create Version Conflict',
        `${request.type} sent at v${tampered.baseVersion} instead of v${request.baseVersion}.`,
      );
    },
  };
}

/** The table number the reuse shadow sends. Distinctive so it is recognisable in `/debug`. */
const REUSE_MARKER_TABLE = 'simulator-reuse';

/**
 * `Duplicate Next Mutation` (§19.4) and `Reuse Mutation Id With New Payload` (§19.5): after a
 * mutation has been applied, send a second request carrying the same `mutationId`.
 *
 * The two differ only in the body, which is the whole point of the pair — §9 has to tell a retry
 * apart from a reuse, and it does it on a hash of `(orderId, type, payload)`. The duplicate re-sends
 * the identical body and must come back `ALREADY_APPLIED` with the original result. The reuse sends
 * a `CREATE_ORDER` body instead: a different hash under the same id, which is the one thing §9
 * refuses. The handler compares the id before it looks at the order's state, so the shadow needs no
 * order in a matching state — only a body the boundary schema accepts.
 *
 * **Only after `APPLIED`.** There is nothing to duplicate before the first apply, and re-sending
 * after a conflict would fire the arm on a request the server never processed.
 *
 * **The shadow's response is logged and thrown away.** It must never reach the sync engine: the
 * engine would treat `ALREADY_APPLIED` as this row settling twice.
 */
export async function fireMutationShadows(
  orderId: string,
  request: MutationRequest,
  send: (orderId: string, request: MutationRequest) => Promise<MutationResponse>,
): Promise<void> {
  if (isArmed('duplicate-next-mutation')) {
    setArm('duplicate-next-mutation', false);
    await shadow('Duplicate Next Mutation', () => send(orderId, request));
  }

  if (isArmed('reuse-mutation-id')) {
    setArm('reuse-mutation-id', false);
    const reused: MutationRequest = {
      mutationId: request.mutationId,
      terminalId: request.terminalId,
      restaurantId: request.restaurantId,
      baseVersion: 0,
      type: 'CREATE_ORDER',
      payload: { tableNumber: REUSE_MARKER_TABLE },
    };
    await shadow('Reuse Mutation Id With New Payload', () => send(orderId, reused));
  }
}

async function shadow(control: string, send: () => Promise<MutationResponse>): Promise<void> {
  try {
    const response = await send();
    recordSimulatorEffect(control, `the server answered ${response.status}.`);
  } catch (error) {
    // A shadow that fails is a fact about the demo, never about the mutation that already applied.
    recordSimulatorEffect(control, error instanceof Error ? error.message : 'the send failed.');
  }
}
