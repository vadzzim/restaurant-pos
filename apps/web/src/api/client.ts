import type {
  ApiErrorResponse,
  ConfigResponse,
  KitchenTicket,
  MenuItem,
  MutationRequest,
  MutationResponse,
  OrderSnapshot,
} from '@pos/contracts';

/** A §17 error envelope that came back from the API, surfaced with its code intact. */
export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

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

/** An order that is not there yet is a normal state on this client, not an error. */
export async function fetchOrder(orderId: string): Promise<OrderSnapshot | undefined> {
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
  const response = await fetch(`/api/orders/${orderId}/mutations`, {
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
