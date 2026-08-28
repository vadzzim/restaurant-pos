import { ref } from 'vue';

/**
 * What a call made by a terminal that is pretending to be offline throws.
 *
 * It is a distinct class so the sync engine can tell "the network is not there" from "the server
 * answered something I did not expect": the first stops the pass and waits for a trigger, the
 * second is a domain outcome and is acted on. Callers that only need to know a request failed do
 * not have to care, because it is an ordinary `Error` as well.
 */
export class OfflineError extends Error {
  constructor(readonly terminalId: string) {
    super(`${terminalId} is simulating an offline terminal.`);
    this.name = 'OfflineError';
  }
}

/**
 * The §18 `Simulate POS-1 Offline` / `Simulate POS-2 Offline` switches, as one set of terminal ids.
 *
 * **Per terminal, not per client**, because the demo runs two POS screens against one server and
 * §19.3 needs exactly one of them cut off. Reactive so the header badge and the button follow it
 * without anything polling.
 */
const offlineTerminals = ref(new Set<string>());

export const isTerminalOffline = (terminalId: string | undefined): boolean =>
  terminalId !== undefined && offlineTerminals.value.has(terminalId);

/** Returns the new state, so a caller can decide whether to kick the sync engine. */
export function setTerminalOffline(terminalId: string, offline: boolean): boolean {
  // A new Set rather than a mutation: `ref` is not `reactive`, and Vue does not track `Set.add`
  // on a plain value held in a `ref`.
  const next = new Set(offlineTerminals.value);
  if (offline) {
    next.add(terminalId);
  } else {
    next.delete(terminalId);
  }
  offlineTerminals.value = next;
  return offline;
}

export const toggleTerminalOffline = (terminalId: string): boolean =>
  setTerminalOffline(terminalId, !isTerminalOffline(terminalId));

/**
 * The gate the API client calls. Throwing here rather than in a store is what keeps the offline
 * demo honest: the stores have one code path, and what they see is what they would see if the
 * network were genuinely gone.
 */
export function assertOnline(terminalId: string | undefined): void {
  if (isTerminalOffline(terminalId)) {
    throw new OfflineError(terminalId as string);
  }
}

/** Test seam: no test should inherit another test's offline terminals. */
export function resetOfflineTerminals(): void {
  offlineTerminals.value = new Set();
}
