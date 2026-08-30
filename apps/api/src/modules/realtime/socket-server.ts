import type { Server as HttpServer } from 'node:http';

import type { AppConfig } from '@pos/config';
import {
  PRESENCE_EVENT_NAME,
  REALTIME_EVENT_NAME,
  SUBSCRIBE_EVENT_NAME,
  type DomainEvent,
  type PresenceReport,
} from '@pos/contracts';
import { createAdapter } from '@socket.io/redis-adapter';
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { Server as SocketServer, type Socket } from 'socket.io';
import { z } from 'zod';

import type { PresenceStore } from '../debug/application/ports.js';
import { kitchenRoom, orderRoom, restaurantRoom, type RealtimeEmitter } from './broadcast.js';
import { presenceReportSchema } from './presence-report.js';

const subscribeSchema = z.object({
  restaurantId: z.string().min(1),
  role: z.enum(['pos', 'kitchen']),
  orderId: z.uuid().optional(),
});

export interface RealtimeServer {
  io: SocketServer;
  emitter: RealtimeEmitter;
  /** §20's `activeWebSocketConnections`, for this instance. A gauge: it goes down. */
  socketCount: () => number;
  /**
   * Reaches Redis over the adapter's own publisher client, so `/api/debug/dependencies` reports
   * the connection the broadcasts actually travel on rather than a second one that might differ.
   * Rejects immediately when that client is not ready rather than queueing behind the outage.
   */
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Socket.IO on the API's own HTTP server, with the Redis adapter so several API instances share
 * one broadcast surface (§13). Redis is a soft dependency: with it down, an instance still reaches
 * the sockets it holds itself and only cross-instance fan-out degrades — which must never take a
 * POS offline (§17).
 */
export function createRealtimeServer(
  httpServer: HttpServer,
  config: AppConfig,
  logger: FastifyBaseLogger,
  /**
   * Where presence is recorded. Optional and best effort throughout: Redis is soft, and a terminal
   * whose presence could not be written must still be connected and receiving events.
   */
  presence?: PresenceStore,
): RealtimeServer {
  const io = new SocketServer(httpServer, {
    // The browser is served by Vite on another port in development; the proxy only covers /api.
    cors: { origin: true },
    path: '/socket.io',
  });

  const pub = new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: null });
  const sub = pub.duplicate();

  for (const client of [pub, sub]) {
    client.on('error', (error: Error) => {
      logger.warn({ err: error }, 'redis adapter connection error; broadcast stays instance-local');
    });
  }

  /**
   * A third connection, for the health probe alone. The adapter's two must never drop a command —
   * `maxRetriesPerRequest: null` holds a broadcast until Redis returns — and that is exactly what a
   * probe must not do: a command that waits forever is the outage it was sent to detect.
   */
  function openProbe(): Redis {
    const client = pub.duplicate({
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: config.HEALTH_CHECK_TIMEOUT_MS,
    });
    // Its failures are the probe's answer, not news; without a listener ioredis would throw them at
    // the process instead.
    client.on('error', () => undefined);
    return client;
  }

  /**
   * Nothing may open a Redis connection once `close()` has run. A probe that fails *during* shutdown
   * would otherwise replace the client that was just disconnected, and nobody would ever close the
   * replacement: during an outage its reconnect timers hold the event loop open, so the API would
   * not exit on SIGTERM.
   */
  let closed = false;

  let probe = openProbe();

  io.adapter(createAdapter(pub, sub));

  /**
   * Presence is written on every heartbeat and never awaited by anything the client is waiting for.
   * A failure is logged at `debug`, not `warn`: during a Redis outage this fires once per terminal
   * every `PRESENCE_HEARTBEAT_MS`, and a log line per beat would bury the outage it is reporting.
   * The `redis` dependency row and the `null` shared counters are what say Redis is down.
   */
  function recordPresence(report: PresenceReport, socketId: string): void {
    void presence?.touch(report, { source: 'socket', socketId }).catch((error: unknown) => {
      logger.debug({ err: error, terminalId: report.terminalId }, 'could not record presence');
    });
  }

  io.on('connection', (socket: Socket) => {
    /**
     * The terminal this socket last claimed, so a disconnect can delete its entry eagerly.
     *
     * The TTL is what makes presence correct; this only makes it *prompt*. Everything the eager
     * delete cannot cover — a browser killed, a lid closed, this very API instance dying while
     * holding the socket — is covered by the entry expiring, which is why the TTL is the mechanism
     * and this is the courtesy.
     */
    let claimed: string | undefined;

    socket.on(PRESENCE_EVENT_NAME, (payload: unknown) => {
      const parsed = presenceReportSchema.safeParse(payload);
      if (!parsed.success) {
        logger.debug({ socketId: socket.id }, 'rejected an invalid presence report');
        return;
      }

      claimed = parsed.data.terminalId;
      recordPresence(parsed.data, socket.id);
    });

    socket.on('disconnect', () => {
      if (claimed === undefined) {
        return;
      }
      const terminalId = claimed;
      void presence?.forget(terminalId).catch((error: unknown) => {
        logger.debug({ err: error, terminalId }, 'could not clear presence');
      });
    });

    socket.on(SUBSCRIBE_EVENT_NAME, (payload: unknown) => {
      const parsed = subscribeSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'rejected an invalid subscribe request');
        return;
      }

      const { restaurantId, role, orderId } = parsed.data;

      // Room membership is derived here, never taken from the client as a raw string. The kitchen
      // joins *only* its own room: it renders the projection, and the restaurant room carries
      // every event of every order, none of which it could act on.
      const wanted = new Set<string>();
      if (role === 'kitchen') {
        wanted.add(kitchenRoom(restaurantId));
      } else {
        wanted.add(restaurantRoom(restaurantId));
        if (orderId !== undefined) {
          wanted.add(orderRoom(orderId));
        }
      }

      for (const room of socket.rooms) {
        // `socket.id` is the socket's own room and is never left.
        if (room !== socket.id && !wanted.has(room)) {
          void socket.leave(room);
        }
      }
      for (const room of wanted) {
        void socket.join(room);
      }

      logger.debug({ socketId: socket.id, restaurantId, role, orderId }, 'socket subscribed');
    });
  });

  const emitter: RealtimeEmitter = {
    emit: (rooms: string[], event: DomainEvent) => {
      io.to(rooms).emit(REALTIME_EVENT_NAME, event);
    },
  };

  return {
    io,
    emitter,
    // `engine.clientsCount` is this instance's own sockets. Deliberately not a cluster-wide
    // number: the Redis adapter could give one, but presence already answers "who is connected"
    // across the fleet, and a per-instance gauge is what makes an uneven load balancer visible.
    socketCount: () => io.engine.clientsCount,
    ping: async () => {
      // Two questions, two sources. *Is the adapter connected?* is about the client the broadcasts
      // actually travel on, and only that client's state can answer it. *Is Redis answering?* has
      // to be a real command, and it goes through the bounded probe client so it can fail instead
      // of hanging.
      if (pub.status !== 'ready') {
        throw new Error(`redis adapter client is ${pub.status}`);
      }

      try {
        await probe.ping();
      } catch (error) {
        // `commandTimeout` rejects the promise but cannot take the command out of ioredis's ordered
        // response queue; only closing the socket does that. Against a black-holed connection the
        // timeout alone would therefore leave one more queued PING behind on every health request.
        // The probe connection is cheap and disposable, so a failed probe throws it away.
        probe.disconnect();
        // A probe can still be in flight when shutdown disconnects it, and its failure then lands
        // here. Replacing the client at that point would leave a connection nobody closes.
        if (!closed) {
          probe = openProbe();
        }
        throw error;
      }
    },
    close: async () => {
      closed = true;
      await io.close();
      pub.disconnect();
      sub.disconnect();
      probe.disconnect();
    },
  };
}
