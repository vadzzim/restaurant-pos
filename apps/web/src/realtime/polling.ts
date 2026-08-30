import { POLLING_INTERVAL_MS, type PresenceReport } from '@pos/contracts';

import { postPresence } from '../api/client';
import { startPresenceBeat } from './presence-beat';

export interface PollingConnectionOptions {
  /**
   * The same canonical refetch the socket path calls, with the same `undefined` it passes on
   * reconnect: there is no event here to wait for, only a snapshot — which is what §13 says a
   * reconnect does anyway.
   */
  refresh: (event: undefined) => Promise<void>;
  presence?: () => PresenceReport | undefined;
  intervalMs?: number;
}

export interface PollingConnection {
  /**
   * Present so a screen can drive either transport through one shape. Polling has no subscription
   * to renew — it asks for the snapshot it wants each time — so this only brings the next poll
   * forward, which is what a screen that just changed order actually wants.
   */
  resubscribe: () => void;
  close: () => void;
}

/**
 * §13's second transport, complete: the client polls the snapshot instead of being pushed to.
 *
 * This is what makes `realtime.websocket_push` a rollout rather than a kill switch (§15). Nothing
 * about correctness changes on this path — the snapshot is canonical either way, and the POS was
 * never allowed to treat a socket event as more than a hint to refetch — so the only difference is
 * latency, which is the claim the flag is there to demonstrate.
 *
 * **One refresh at a time.** A poll fires on a timer whether or not the previous one has answered,
 * and a slow API would otherwise stack refetches that each rewrite the same store.
 */
export function connectPolling(options: PollingConnectionOptions): PollingConnection {
  const intervalMs = options.intervalMs ?? POLLING_INTERVAL_MS;
  let closed = false;
  let inFlight = false;

  const poll = (): void => {
    if (closed || inFlight) {
      return;
    }
    inFlight = true;
    // A failed poll is not news: the terminal may be pretending to be offline (§18) or the API may
    // be down, and both are already on screen. The next tick tries again — which is the one place
    // this transport is more forgiving than the socket, whose reconnect the client does not drive.
    void options
      .refresh(undefined)
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };

  const beat = startPresenceBeat(
    () => options.presence?.(),
    (report) => {
      // Fire and forget, like the socket emit it replaces: nothing the screen does waits on it.
      void postPresence(report).catch(() => undefined);
    },
  );

  const timer = setInterval(poll, intervalMs);

  // Immediately, for both, and for the same reasons the socket does it on `connect`: the screen
  // that just came up must not wait an interval for its first canonical read, and a terminal that
  // took five seconds to appear on `/debug` looks like a terminal that failed to connect.
  poll();
  beat.report();

  return {
    resubscribe: () => {
      beat.report();
      poll();
    },
    close: () => {
      closed = true;
      clearInterval(timer);
      beat.stop();
    },
  };
}
