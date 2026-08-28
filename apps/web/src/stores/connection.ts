import type { DomainEvent } from '@pos/contracts';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { fetchConfig } from '../api/client';
import { createEventGate, type GateVerdict } from '../realtime/event-gate';
import { connectRealtime, type RealtimeConnection } from '../realtime/socket';

export type SocketState = 'DISCONNECTED' | 'CONNECTED';

/**
 * `PUSH` is the WebSocket transport of §13. `PUSH DISABLED` is what M4 shows when the
 * `realtime.websocket_push` flag is off: the screens stay correct after every mutation, but there
 * are no live updates until M13 lands the polling transport as the flag's other, complete branch.
 */
export type Transport = 'PUSH' | 'PUSH DISABLED' | 'UNKNOWN';

export interface RealtimeStartOptions {
  restaurantId: string;
  role: 'pos' | 'kitchen';
  currentOrderId: () => string | undefined;
  /** What the screen holds for the aggregate this event is about; 0 when it holds nothing. */
  heldVersion: (aggregateId: string) => number;
  /**
   * The canonical refetch — the only way this client learns anything from a socket message. The
   * event is passed so a screen reading an eventually-consistent projection can wait for it;
   * `undefined` means this is a reconnect refresh with nothing specific to wait for.
   */
  refresh: (event: DomainEvent | undefined) => Promise<void>;
}

export const useConnectionStore = defineStore('connection', () => {
  const online = ref(navigator.onLine);
  const socketState = ref<SocketState>('DISCONNECTED');
  const transport = ref<Transport>('UNKNOWN');
  const lastVerdict = ref<GateVerdict | undefined>();

  const gate = createEventGate();
  let connection: RealtimeConnection | undefined;
  /**
   * `start` awaits `GET /api/config` before it opens a socket, and in that gap the component can
   * unmount or the terminal in the URL can change. Every `start` and `stop` claims a generation;
   * a `start` that finds its claim superseded drops what it built instead of installing it, so a
   * stale connection can neither replace a newer one nor outlive a `stop`.
   */
  let generation = 0;

  const pushEnabled = computed(() => transport.value === 'PUSH');

  window.addEventListener('online', () => {
    online.value = true;
  });
  window.addEventListener('offline', () => {
    online.value = false;
  });

  /**
   * Fetched once at bootstrap. M13 re-polls this every 15 s so an open client picks up a rollout
   * change; a WebSocket control event would be circular when the flag turns WebSocket off (§15).
   */
  async function resolveTransport(restaurantId: string): Promise<boolean> {
    try {
      const config = await fetchConfig(restaurantId);
      const enabled = config.flags['realtime.websocket_push'];
      transport.value = enabled ? 'PUSH' : 'PUSH DISABLED';
      return enabled;
    } catch {
      transport.value = 'UNKNOWN';
      return false;
    }
  }

  function teardown(): void {
    connection?.close();
    connection = undefined;
    socketState.value = 'DISCONNECTED';
  }

  async function start(options: RealtimeStartOptions): Promise<void> {
    generation += 1;
    const mine = generation;
    teardown();

    const enabled = await resolveTransport(options.restaurantId);
    if (!enabled || mine !== generation) {
      return;
    }

    const opened = connectRealtime({
      subscription: () => ({
        restaurantId: options.restaurantId,
        role: options.role,
        orderId: options.currentOrderId(),
      }),
      onConnected: () => {
        if (mine !== generation) {
          return;
        }
        socketState.value = 'CONNECTED';
        // §13: reconnecting means refetching the snapshot, not merely showing a green badge.
        // Anything lost in the §12.2 crash window is repaired right here.
        void options.refresh(undefined);
      },
      onDisconnected: () => {
        if (mine === generation) {
          socketState.value = 'DISCONNECTED';
        }
      },
      onEvent: (event: DomainEvent) => {
        if (mine !== generation) {
          return;
        }
        const verdict = gate.accept(event, options.heldVersion(event.aggregateId));
        lastVerdict.value = verdict;
        if (verdict === 'accepted') {
          void options.refresh(event);
        }
      },
    });

    // `stop()` may have run while `connectRealtime` was wiring itself up.
    if (mine !== generation) {
      opened.close();
      return;
    }

    connection = opened;
  }

  function resubscribe(): void {
    connection?.resubscribe();
  }

  function stop(): void {
    generation += 1;
    teardown();
  }

  return { online, socketState, transport, pushEnabled, lastVerdict, start, resubscribe, stop };
});
