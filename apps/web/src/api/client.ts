import type {
  ApiErrorResponse,
  ConflictsDebugResponse,
  ConfigResponse,
  DependenciesResponse,
  EventsDebugResponse,
  KitchenTicket,
  MenuItem,
  MetricsResponse,
  MutationRequest,
  MutationResponse,
  OrderSnapshot,
  OutboxDebugResponse,
  SimulatorControl,
  SimulatorResponse,
} from '@pos/contracts';

import { ApiRequestError } from './errors';
import { assertOnline } from './offline';
import { applyVersionConflictArm, fireMutationShadows } from './simulator-arms';

export { ApiRequestError };

async function readJson(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });

  return unwrap<T>(response);
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  return unwrap<T>(response);
}

/**
 * Every non-mutation call has the same two outcomes: a body, or the §17 error envelope. The
 * mutation path below cannot use this — three of its 4xx answers are domain outcomes, not errors.
 */
async function unwrap<T>(response: Response): Promise<T> {
  const body = await readJson(response);

  if (!response.ok) {
    const error = body as ApiErrorResponse;
    throw new ApiRequestError(
      error.code ?? 'UNKNOWN',
      error.message ?? 'Request failed.',
      response.status,
    );
  }

  return body as T;
}

export const fetchMenu = (): Promise<MenuItem[]> => get<MenuItem[]>('/api/menu');

export const fetchConfig = (restaurantId: string): Promise<ConfigResponse> =>
  get<ConfigResponse>(`/api/config?restaurantId=${encodeURIComponent(restaurantId)}`);

export const fetchTickets = (restaurantId: string): Promise<KitchenTicket[]> =>
  get<KitchenTicket[]>(`/api/kitchen/tickets?restaurantId=${encodeURIComponent(restaurantId)}`);

/**
 * The five §17 debug reads. They deliberately do **not** go through `assertOnline`: `/debug` has no
 * terminal, and the §18 offline switch is per terminal — cutting the debug page off because POS-1
 * is pretending to be offline would hide the very state that switch exists to demonstrate.
 */
export const fetchDependencies = (): Promise<DependenciesResponse> =>
  get<DependenciesResponse>('/api/debug/dependencies');

export const fetchMetrics = (): Promise<MetricsResponse> =>
  get<MetricsResponse>('/api/debug/metrics');

export const fetchDebugEvents = (): Promise<EventsDebugResponse> =>
  get<EventsDebugResponse>('/api/debug/events');

export const fetchDebugConflicts = (): Promise<ConflictsDebugResponse> =>
  get<ConflictsDebugResponse>('/api/debug/conflicts');

export const fetchDebugOutbox = (): Promise<OutboxDebugResponse> =>
  get<OutboxDebugResponse>('/api/debug/outbox');

export const fetchSimulator = (): Promise<SimulatorResponse> =>
  get<SimulatorResponse>('/api/debug/simulator');

/**
 * §18's four server-side controls, through the one endpoint pair M12 added (ADR 015). The response
 * is the new state, so a button never has to guess or wait for the next poll to show what it did.
 */
export const postSimulatorControl = (
  control: SimulatorControl,
  body: Record<string, unknown> = {},
): Promise<SimulatorResponse> =>
  postJson<SimulatorResponse>(`/api/debug/simulator/${control}`, body);

/**
 * An order that is not there yet is a normal state on this client, not an error.
 *
 * `terminalId` is here for the offline gate and for nothing else. Reads have to be cut off as well
 * as writes: §19.3 depends on POS-1 *not* learning that POS-2 cancelled the order while it is
 * offline, because a refresh it never asked for would silently re-validate the `baseVersion`s its
 * queue is stamped with and the conflict the scenario exists to show would not happen.
 */
export async function fetchOrder(
  orderId: string,
  terminalId?: string,
): Promise<OrderSnapshot | undefined> {
  assertOnline(terminalId);

  try {
    return await get<OrderSnapshot>(`/api/orders/${orderId}`);
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'ORDER_NOT_FOUND') {
      return undefined;
    }
    throw error;
  }
}

/**
 * The single write path (§5). `CONFLICT`, `MUTATION_ID_REUSED` and `REJECTED` arrive with a 4xx
 * status but are domain outcomes carrying a §5 body, so they are returned rather than thrown; only
 * the §17 error envelope becomes an exception.
 */
export async function postMutation(
  orderId: string,
  request: MutationRequest,
): Promise<MutationResponse> {
  // §18's three mutation controls hang off this one call and not off `postMutationTo`, so the
  // kitchen adapters below are untouched: all three are POS-queue demonstrations (§19.3–§19.5),
  // and two of them need an `orderId` and a payload the kitchen commands do not carry.
  const { request: outgoing, spend } = applyVersionConflictArm(request);
  const response = await postMutationTo(`/api/orders/${orderId}/mutations`, outgoing);
  spend();

  if (response.status === 'APPLIED') {
    await fireMutationShadows(orderId, outgoing, (id, body) =>
      postMutationTo(`/api/orders/${id}/mutations`, body),
    );
  }

  return response;
}

/** What the two §17 kitchen adapters take: a mutation identity, with the type in the URL. */
export interface KitchenCommandRequest {
  mutationId: string;
  terminalId: string;
  restaurantId: string;
  baseVersion: number;
}

/**
 * The kitchen commands go through the §17 adapters rather than through `postMutation` with a type
 * in the body. Both reach the same handler; using the endpoints that exist for this is what keeps
 * them honest — an adapter nothing calls is an adapter nobody notices breaking.
 */
export const postKitchenCommand = (
  orderId: string,
  command: 'preparing' | 'ready',
  request: KitchenCommandRequest,
): Promise<MutationResponse> =>
  postMutationTo(`/api/kitchen/orders/${orderId}/${command}`, request);

async function postMutationTo(
  path: string,
  request: { terminalId: string },
): Promise<MutationResponse> {
  // Every mutation body carries the terminal that sent it, so the gate needs no extra argument —
  // and cannot be bypassed by a caller that forgot to pass one.
  assertOnline(request.terminalId);

  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(request),
  });

  const body = await readJson(response);

  if (typeof body === 'object' && body !== null && 'status' in body) {
    return body as MutationResponse;
  }

  const error = body as ApiErrorResponse;
  throw new ApiRequestError(
    error.code ?? 'UNKNOWN',
    error.message ?? 'Request failed.',
    response.status,
  );
}
