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

  for (const client of [pub, sub]) {
    client.on('error', (error: Error) => {
      logger.warn({ err: error }, 'redis adapter connection error; broadcast stays instance-local');
    });
  }

  io.adapter(createAdapter(pub, sub));

  io.on('connection', (socket: Socket) => {
    socket.on(SUBSCRIBE_EVENT_NAME, (payload: unknown) => {
      const parsed = subscribeSchema.safeParse(payload);
      if (!parsed.success) {
        logger.warn({ socketId: socket.id }, 'rejected an invalid subscribe request');
        return;
      }

      const { restaurantId, role, orderId } = parsed.data;

      // Room membership is derived here, never taken from the client as a raw string.
      const wanted = new Set<string>([restaurantRoom(restaurantId)]);
      if (role === 'kitchen') {
        wanted.add(kitchenRoom(restaurantId));
      }
      if (orderId !== undefined) {
        wanted.add(orderRoom(orderId));
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
    close: async () => {
      await io.close();
      pub.disconnect();
      sub.disconnect();
    },
  };
}
