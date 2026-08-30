import {
  PRESENCE_EVENT_NAME,
  PRESENCE_HEARTBEAT_MS,
  REALTIME_EVENT_NAME,
  SUBSCRIBE_EVENT_NAME,
  type DomainEvent,
  type PresenceReport,
  type SubscribeRequest,
} from '@pos/contracts';
import { io, type Socket } from 'socket.io-client';

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
   * The presence beat. It is emitted rather than merely observed from the connection because two
   * of its fields — the pending count and the offline switch — exist only in this browser, and
   * because a periodic beat is what makes the server's TTL meaningful: an entry that is not
   * refreshed expires, so a terminal that dies without a disconnect leaves the list on its own.
   *
   * `socket.emit` on a disconnected socket buffers, which is exactly wrong here: a burst of stale
   * beats would land at once on reconnect and each would overwrite `lastSeenAt` with the moment it
   * arrived. So it only reports while connected.
   */
  const report = (): void => {
    const presence = options.presence?.();
    if (presence !== undefined && socket.connected) {
      socket.emit(PRESENCE_EVENT_NAME, presence);
    }
  };

  const beat = setInterval(report, PRESENCE_HEARTBEAT_MS);

  socket.on('connect', () => {
    subscribe();
    // Immediately, not on the next tick: a terminal that had to wait five seconds to appear on
    // /debug would look like a terminal that failed to connect.
    report();
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
        report();
      }
    },
    close: () => {
      clearInterval(beat);
      socket.close();
    },
  };
}
