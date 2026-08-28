import {
  REALTIME_EVENT_NAME,
  SUBSCRIBE_EVENT_NAME,
  type DomainEvent,
  type SubscribeRequest,
} from '@pos/contracts';
import { io, type Socket } from 'socket.io-client';

export interface RealtimeConnectionOptions {
  subscription: () => SubscribeRequest;
  onEvent: (event: DomainEvent) => void;
  /** Fired on the first connect and on every reconnect: §13 requires a snapshot refetch here. */
  onConnected: () => void;
  onDisconnected: () => void;
}

export interface RealtimeConnection {
  /** Re-send the subscription, e.g. once the POS has an order to follow. */
  resubscribe: () => void;
  close: () => void;
}

/**
 * The client's end of §13. It sends what it wants to follow — restaurant, role, current order —
 * and the server turns that into room membership; the browser never names a room.
 */
export function connectRealtime(options: RealtimeConnectionOptions): RealtimeConnection {
  const socket: Socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });

  const subscribe = (): void => {
    socket.emit(SUBSCRIBE_EVENT_NAME, options.subscription());
  };

  socket.on('connect', () => {
    subscribe();
    options.onConnected();
  });

  socket.on('disconnect', () => {
    options.onDisconnected();
  });

  socket.on(REALTIME_EVENT_NAME, (event: DomainEvent) => {
    options.onEvent(event);
  });

  return {
    resubscribe: () => {
      if (socket.connected) {
        subscribe();
      }
    },
    close: () => {
      socket.close();
    },
  };
}
