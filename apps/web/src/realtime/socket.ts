import {
  PRESENCE_EVENT_NAME,
  REALTIME_EVENT_NAME,
  SUBSCRIBE_EVENT_NAME,
  type DomainEvent,
  type PresenceReport,
  type SubscribeRequest,
} from '@pos/contracts';
import { io, type Socket } from 'socket.io-client';

import { startPresenceBeat } from './presence-beat';

export interface RealtimeConnectionOptions {
  subscription: () => SubscribeRequest;
  onEvent: (event: DomainEvent) => void;
  /** Fired on the first connect and on every reconnect: §13 requires a snapshot refetch here. */
  onConnected: () => void;
  onDisconnected: () => void;
  /**
   * What this screen reports about itself for §16's active-terminals panel: its terminal id, its
   * pending-mutation count and its §18 offline switch. Nothing else can know the last two.
   *
   * Optional, and returning `undefined` sends nothing — the kitchen display is not one of the four
   * seeded terminals, and a screen with no terminal has no presence to report.
   */
  presence?: () => PresenceReport | undefined;
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

  /**
   * The presence beat, on this transport's terms. The timer itself lives in `presence-beat.ts`,
   * because since M13 the polling transport keeps the same beat over HTTP — a terminal is on
   * `/debug` because it is working, not because it happens to hold a socket.
   *
   * `socket.emit` on a disconnected socket buffers, which is exactly wrong here: a burst of stale
   * beats would land at once on reconnect and each would overwrite `lastSeenAt` with the moment it
   * arrived. So it only reports while connected.
   */
  const beat = startPresenceBeat(
    () => options.presence?.(),
    (presence) => {
      if (socket.connected) {
        socket.emit(PRESENCE_EVENT_NAME, presence);
      }
    },
  );

  socket.on('connect', () => {
    subscribe();
    // Immediately, not on the next tick: a terminal that had to wait five seconds to appear on
    // /debug would look like a terminal that failed to connect.
    beat.report();
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
        // The queue depth is the commonest reason a screen resubscribes, so the panel follows a
        // mutation without waiting out the interval.
        beat.report();
      }
    },
    close: () => {
      beat.stop();
      socket.close();
    },
  };
}
