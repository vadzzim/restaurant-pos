import type { Server as HttpServer } from 'node:http';

import type { AppConfig } from '@pos/config';
import { REALTIME_EVENT_NAME, SUBSCRIBE_EVENT_NAME, type DomainEvent } from '@pos/contracts';
import { createAdapter } from '@socket.io/redis-adapter';
import type { FastifyBaseLogger } from 'fastify';
import { Redis } from 'ioredis';
import { Server as SocketServer, type Socket } from 'socket.io';
import { z } from 'zod';

import { kitchenRoom, orderRoom, restaurantRoom, type RealtimeEmitter } from './broadcast.js';

const subscribeSchema = z.object({
  restaurantId: z.string().min(1),
  role: z.enum(['pos', 'kitchen']),
  orderId: z.uuid().optional(),
});

export interface RealtimeServer {
  io: SocketServer;
  emitter: RealtimeEmitter;
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
): RealtimeServer {
  const io = new SocketServer(httpServer, {
    // The browser is served by Vite on another port in development; the proxy only covers /api.
    cors: { origin: true },
    path: '/socket.io',
  });

  const pub = new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: null });
  const sub = pub.duplicate();

  /**
   * A third connection, for the health probe alone. The adapter's two must never drop a command —
   * `maxRetriesPerRequest: null` holds a broadcast until Redis returns — and that is exactly what a
   * probe must not do: a command that waits forever is the outage it was sent to detect. This one
   * refuses to queue and times out on its own, so `/api/debug/dependencies` cannot accumulate
   * pending pings across an outage, including the half-open case where the socket never closes and
   * ioredis still believes it is `ready`.
   */
  const probe = pub.duplicate({
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: config.HEALTH_CHECK_TIMEOUT_MS,
  });

  for (const client of [pub, sub]) {
    client.on('error', (error: Error) => {
      logger.warn({ err: error }, 'redis adapter connection error; broadcast stays instance-local');
    });
  }

  // Its failures are the probe's answer, not news; without a listener ioredis would throw them at
  // the process instead.
  probe.on('error', () => undefined);

  io.adapter(createAdapter(pub, sub));

  io.on('connection', (socket: Socket) => {
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
    ping: async () => {
      // Two questions, two sources. *Is the adapter connected?* is about the client the broadcasts
      // actually travel on, and only that client's state can answer it. *Is Redis answering?* has
      // to be a real command, and it goes through the bounded probe client so it can fail instead
      // of hanging.
      if (pub.status !== 'ready') {
        throw new Error(`redis adapter client is ${pub.status}`);
      }
      await probe.ping();
    },
    close: async () => {
      await io.close();
      pub.disconnect();
      sub.disconnect();
      probe.disconnect();
    },
  };
}
