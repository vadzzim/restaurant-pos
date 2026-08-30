import { randomUUID } from 'node:crypto';

import { REALTIME_EVENT_NAME, SUBSCRIBE_EVENT_NAME, type DomainEvent } from '@pos/contracts';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * §19.10 / §22 — the multi-instance smoke test. It needs the production-image stack from
 * `docker-compose.multi.yml`; `pnpm verify:multi` is what brings that up, runs this and tears it
 * down. It never runs under `pnpm -F @pos/api test`.
 *
 * What it proves, and why it is written this way. Nothing in `apps/api` broadcasts from the
 * mutation handler — the only `RealtimeEmitter` producer is `modules/realtime/consumer.ts` — so
 * the event reaches a browser by this path:
 *
 *   POST → replica A → outbox (same transaction) → worker → Kafka
 *        → the realtime consumer group → *one* replica → Redis adapter → every replica
 *
 * Both replicas join `REALTIME_CONSUMER_GROUP`, so exactly one of them consumes each message and
 * which one is not ours to choose. A test that watched only replica B would therefore pass without
 * any cross-instance hop whenever B happened to be the consumer — half the runs, with the adapter
 * removed. So both sockets are watched. `handleRealtimeEvent` records `processed_events` before
 * it emits, so exactly one replica in the fleet ever emits a given event; two sockets on two
 * instances receiving it is the Redis fan-out and nothing else.
 */

/**
 * The published ports of `api-1` and `api-2` in `docker-compose.multi.yml`, written out rather
 * than read from the environment: naming A and B is the whole point of the test, and an
 * overridable address is one more way for a run to prove something other than §19.10.
 */
const REPLICA_A = 'http://localhost:3001';
const REPLICA_B = 'http://localhost:3002';
const RESTAURANT = 'demo-restaurant';

/** Kafka's first round trip includes a group join and a rebalance; later ones are fast. */
const FIRST_EVENT_TIMEOUT_MS = 90_000;
const EVENT_TIMEOUT_MS = 30_000;

function connect(url: string): Promise<Socket> {
  const socket = io(url, { path: '/socket.io', transports: ['websocket'] });
  return new Promise((resolve, reject) => {
    const failed = setTimeout(() => reject(new Error(`no socket on ${url}`)), 30_000);
    socket.on('connect_error', (error) => {
      clearTimeout(failed);
      reject(error);
    });
    socket.on('connect', () => {
      clearTimeout(failed);
      // Room membership is derived server-side from this; without it the socket is in no room and
      // receives nothing (`socket-server.ts`).
      socket.emit(SUBSCRIBE_EVENT_NAME, { restaurantId: RESTAURANT, role: 'pos' });
      resolve(socket);
    });
  });
}

/**
 * Registered *before* the mutation is sent, never after: the event can arrive within milliseconds
 * of the HTTP reply and a listener attached afterwards would race it.
 */
function waitForOrder(
  socket: Socket,
  label: string,
  orderId: string,
  timeoutMs: number,
): Promise<DomainEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(REALTIME_EVENT_NAME, onEvent);
      reject(new Error(`no event for ${orderId} on ${label} within ${timeoutMs}ms`));
    }, timeoutMs);

    function onEvent(event: DomainEvent): void {
      if (event.aggregateId !== orderId) {
        return;
      }
      clearTimeout(timer);
      socket.off(REALTIME_EVENT_NAME, onEvent);
      resolve(event);
    }

    socket.on(REALTIME_EVENT_NAME, onEvent);
  });
}

async function createOrder(baseUrl: string, orderId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/orders/${orderId}/mutations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mutationId: randomUUID(),
      terminalId: 'pos-1',
      restaurantId: RESTAURANT,
      type: 'CREATE_ORDER',
      baseVersion: 0,
      payload: { tableNumber: '19' },
    }),
  });

  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`mutation on ${baseUrl} returned ${response.status}: ${JSON.stringify(body)}`);
  }
}

describe('§19.10 multi-instance broadcast', () => {
  let socketA: Socket;
  let socketB: Socket;

  beforeAll(async () => {
    [socketA, socketB] = await Promise.all([connect(REPLICA_A), connect(REPLICA_B)]);

    // A throwaway order to pay for the consumer group join and the first rebalance once, visibly,
    // instead of hiding them in a sleep that is either too short on CI or wasted locally.
    const warmUp = randomUUID();
    // Whichever replica consumes, only one of these resolves promptly. The `catch` is not
    // optional: the loser rejects on its own timeout long after the race is decided, and an
    // unhandled rejection would fail the run for the wrong reason.
    const arrived = Promise.race(
      [socketA, socketB].map((socket, index) =>
        waitForOrder(socket, `warm-up ${index}`, warmUp, FIRST_EVENT_TIMEOUT_MS).catch(
          () => undefined,
        ),
      ),
    );
    await createOrder(REPLICA_A, warmUp);
    if ((await arrived) === undefined) {
      throw new Error('the outbox → Kafka → consumer pipeline never delivered the warm-up order');
    }
  }, FIRST_EVENT_TIMEOUT_MS + 30_000);

  afterAll(() => {
    socketA?.close();
    socketB?.close();
  });

  it('delivers a mutation applied through replica A to a client attached to replica B', async () => {
    const orderId = randomUUID();
    const onA = waitForOrder(socketA, 'replica A', orderId, EVENT_TIMEOUT_MS);
    const onB = waitForOrder(socketB, 'replica B', orderId, EVENT_TIMEOUT_MS);

    await createOrder(REPLICA_A, orderId);

    // `allSettled`, not `all`: with `all` a failure on one socket leaves the other rejecting into
    // nothing, and the unhandled rejection buries the message that says which side went missing.
    const [resultA, resultB] = await Promise.allSettled([onA, onB]);
    if (resultA.status === 'rejected') {
      throw resultA.reason;
    }
    if (resultB.status === 'rejected') {
      throw resultB.reason;
    }
    const fromA = resultA.value;
    const fromB = resultB.value;

    expect(fromB.eventType).toBe('OrderCreated');
    expect(fromB.restaurantId).toBe(RESTAURANT);
    // One `emit`, two deliveries — and this is the assertion that makes the Redis adapter the only
    // possible explanation. `handleRealtimeEvent` writes `processed_events` before emitting, so
    // across the whole fleet exactly one replica ever emits a given `eventId`, whatever the
    // consumer group did. Two sockets on two instances holding the same one is the fan-out.
    expect(fromA.eventId).toBe(fromB.eventId);
  });
});
