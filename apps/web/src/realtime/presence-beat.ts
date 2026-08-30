import { PRESENCE_HEARTBEAT_MS, type PresenceReport } from '@pos/contracts';

export interface PresenceBeat {
  /** Send one report now. Used at the moment a transport comes up, and after a queue changes. */
  report: () => void;
  stop: () => void;
}

/**
 * The presence heartbeat (§16), owned by neither transport.
 *
 * It used to live inside `connectRealtime`, which was correct only while the socket was the one
 * way to reach the server. Once polling became a working transport (§15) that placement meant a
 * polling terminal reported nothing and vanished from `/debug` — a working terminal, invisible, on
 * the panel whose whole job in the rollout demo is to show two terminals on two transports.
 *
 * So the beat is a timer and a `send`, and each transport supplies its own: an `emit` on the socket,
 * a `POST` on the polling side. What it reports — the pending queue depth and the §18 offline
 * switch — only the browser can know either way.
 */
export function startPresenceBeat(
  read: () => PresenceReport | undefined,
  send: (report: PresenceReport) => void,
): PresenceBeat {
  const report = (): void => {
    const presence = read();
    if (presence !== undefined) {
      send(presence);
    }
  };

  const timer = setInterval(report, PRESENCE_HEARTBEAT_MS);

  return {
    report,
    stop: () => {
      clearInterval(timer);
    },
  };
}
