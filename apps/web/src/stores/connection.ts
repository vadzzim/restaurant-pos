import type { DomainEvent, PresenceReport } from '@pos/contracts';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

import { fetchConfig } from '../api/client';
import { isLatched, latchStates } from '../api/simulator-arms';
import { createEventGate, type GateVerdict } from '../realtime/event-gate';
import { connectRealtime, type RealtimeConnection } from '../realtime/socket';

export type SocketState = 'DISCONNECTED' | 'CONNECTED';

/**
 * `PUSH` is the WebSocket transport of §13. `PUSH DISABLED` is what M4 shows when the
 * `realtime.websocket_push` flag is off: the screens stay correct after every mutation, but there
 * are no live updates until M13 lands the polling transport as the flag's other, complete branch.
 *
 * §18's `Force Polling Transport` puts this terminal on that same `PUSH DISABLED` branch without
 * touching the flag. Today the two are indistinguishable on the badge because the branch is one
 * branch; M13 is what makes it a working second transport.
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
  /**
   * What this screen reports for §16's active-terminals panel, or `undefined` when it has no
   * terminal to report — the kitchen display is not one of the four seeded terminals.
   */
  presence?: () => PresenceReport | undefined;
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
  /** What the mounted screen last asked for, so a §18 latch can rebuild the same connection. */
  let lastOptions: RealtimeStartOptions | undefined;

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
   *
   * Deliberately free of side effects: it resolves a value and writes nothing. The caller writes
   * `transport` only after checking that its generation is still current, so the late answer of a
   * cancelled `start` cannot relabel the transport of the restaurant that replaced it.
   */
  async function resolveTransport(restaurantId: string): Promise<Transport> {
    // §18's `Force Polling Transport`, per terminal and ahead of the flag: this screen declines
    // push without touching a fleet-wide row that would take every other terminal with it.
    if (isLatched('polling-forced')) {
      return 'PUSH DISABLED';
    }

    try {
      const config = await fetchConfig(restaurantId);
      return config.flags['realtime.websocket_push'] ? 'PUSH' : 'PUSH DISABLED';
    } catch {
      return 'UNKNOWN';
    }
  }

  function teardown(): void {
    connection?.close();
    connection = undefined;
    socketState.value = 'DISCONNECTED';
  }

  async function start(options: RealtimeStartOptions): Promise<void> {
    lastOptions = options;
    generation += 1;
    const mine = generation;
    teardown();

    const resolved = await resolveTransport(options.restaurantId);
    if (mine !== generation) {
      return;
    }

    transport.value = resolved;
    if (resolved !== 'PUSH') {
      return;
    }

    // §18's `Disconnect WebSocket`. It is checked here rather than by closing an open socket
    // because the operator throws it on `/debug`, where no screen holds one — a latch the next
    // `start` obeys is what makes the control work from the page it is drawn on.
    if (isLatched('socket-disabled')) {
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
      // Guarded by the same generation check as everything else here: a superseded connection
      // must not keep reporting a terminal the screen has left.
      presence: () => (mine === generation ? options.presence?.() : undefined),
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
    lastOptions = undefined;
    generation += 1;
    teardown();
  }

  /**
   * Both §18 latches change what `start` would have built, so flipping one re-runs it against the
   * screen that is up. Without this the operator would have to leave `/pos` and come back for a
   * switch thrown on `/debug` to take effect, which is a control that appears not to work.
   *
   * `stop()` clears `lastOptions`, so a latch thrown with no screen mounted rebuilds nothing.
   */
  watch(
    () => [latchStates.value['socket-disabled'], latchStates.value['polling-forced']],
    () => {
      if (lastOptions !== undefined) {
        void start(lastOptions);
      }
    },
  );

  return { online, socketState, transport, pushEnabled, lastVerdict, start, resubscribe, stop };
});
