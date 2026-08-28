import type {
  ApiErrorResponse,
  ConfigResponse,
  KitchenTicket,
  MenuItem,
  MutationRequest,
  MutationResponse,
  OrderSnapshot,
} from '@pos/contracts';

import { ApiRequestError } from './errors';
import { assertOnline } from './offline';

export { ApiRequestError };

async function readJson(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
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
export const postMutation = (
  orderId: string,
  request: MutationRequest,
): Promise<MutationResponse> => postMutationTo(`/api/orders/${orderId}/mutations`, request);

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
