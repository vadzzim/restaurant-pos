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
  /** The canonical refetch — the only way this client learns anything from a socket message. */
  refresh: () => Promise<void>;
}

export const useConnectionStore = defineStore('connection', () => {
  const online = ref(navigator.onLine);
  const socketState = ref<SocketState>('DISCONNECTED');
  const transport = ref<Transport>('UNKNOWN');
  const lastVerdict = ref<GateVerdict | undefined>();

  const gate = createEventGate();
  let connection: RealtimeConnection | undefined;

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

  async function start(options: RealtimeStartOptions): Promise<void> {
    const enabled = await resolveTransport(options.restaurantId);
    if (!enabled) {
      return;
    }

    connection = connectRealtime({
      subscription: () => ({
        restaurantId: options.restaurantId,
        role: options.role,
        orderId: options.currentOrderId(),
      }),
      onConnected: () => {
        socketState.value = 'CONNECTED';
        // §13: reconnecting means refetching the snapshot, not merely showing a green badge.
        // Anything lost in the §12.2 crash window is repaired right here.
        void options.refresh();
      },
      onDisconnected: () => {
        socketState.value = 'DISCONNECTED';
      },
      onEvent: (event: DomainEvent) => {
        const verdict = gate.accept(event, options.heldVersion(event.aggregateId));
        lastVerdict.value = verdict;
        if (verdict === 'accepted') {
          void options.refresh();
        }
      },
    });
  }

  function resubscribe(): void {
    connection?.resubscribe();
  }

  function stop(): void {
    connection?.close();
    connection = undefined;
    socketState.value = 'DISCONNECTED';
  }

  return { online, socketState, transport, pushEnabled, lastVerdict, start, resubscribe, stop };
});
