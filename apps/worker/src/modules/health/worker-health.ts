// The worker's readiness surface (§17, and the third `[M14, P3]`, closed in M24).
//
// The worker had none, so `docker compose up --wait worker-prod` proved only that the container was
// running: a worker that booted and immediately failed to reach the broker was reported by
// `verify:multi` as a *broadcast* failure — the §19.10 assertion blaming the thing it is testing.
//
// Deliberately not Fastify and deliberately not in `@pos/contracts`. Two routes over `node:http`
// carry no schema, no plugins and no route registration, and the only clients are a busybox `wget`
// in a healthcheck and a human running `docker compose exec`. A shared response type would be a
// contract between one writer and no parsers.

import { createServer, type Server, type ServerResponse } from 'node:http';

import type { Logger } from 'pino';

/**
 * What readiness is made of. Every field is a fact the worker already had — this module invents
 * none of them, it only decides what their conjunction means.
 */
export interface WorkerHealthChecks {
  /** The supervised Kafka session is up. The publisher idles while it is not (ADR 011). */
  brokerConnected: boolean;
  /**
   * The publisher loop has completed at least one pass. Boot-time gating, not liveness: the
   * heartbeat log is what says the loop is still turning an hour later.
   */
  publisherPassCompleted: boolean;
  /** BullMQ's print worker is consuming rather than closed or paused (§12.3). */
  printWorkerRunning: boolean;
}

export interface WorkerHealthReport {
  status: 'ok' | 'unavailable';
  uptimeSeconds: number;
  checks: WorkerHealthChecks;
}

/**
 * The whole decision, as a pure function so that it is the one part of the deployment surface a
 * vitest can reach.
 *
 * All three, not two: a worker whose print pipeline is closed still publishes, but it silently
 * stops printing tickets, and `--wait` is the only gate in front of a smoke run that asserts both.
 */
export function describeWorkerReadiness(
  checks: WorkerHealthChecks,
  uptimeSeconds: number,
): WorkerHealthReport {
  const ready =
    checks.brokerConnected && checks.publisherPassCompleted && checks.printWorkerRunning;

  return { status: ready ? 'ok' : 'unavailable', uptimeSeconds, checks };
}

export interface WorkerHealthServer {
  /** The bound port, which is the requested one unless it was 0 — the tests ask for 0. */
  port: number;
  close: () => Promise<void>;
}

export interface WorkerHealthServerOptions {
  port: number;
  probe: () => WorkerHealthChecks;
  logger: Logger;
  /**
   * `127.0.0.1` and not `0.0.0.0`: the only probe is inside the container, and a worker started on
   * a developer's machine must not publish a port. `wget` in the Node image tries `::1` first for
   * `localhost`, so the healthcheck spells the address out — see `docker-compose.multi.yml`.
   */
  host?: string;
}

/**
 * Starts the two routes and resolves once the port is bound, so a caller that awaits this knows
 * the healthcheck will be answered rather than refused.
 *
 * A bind failure **rejects** rather than throwing asynchronously: `index.ts` turns it into a
 * warning and keeps publishing. The port is a probe, not the job — and Docker reports the
 * consequence by failing the healthcheck, which is exactly the signal this module exists to give.
 */
export function startWorkerHealthServer(
  options: WorkerHealthServerOptions,
): Promise<WorkerHealthServer> {
  const { port, probe, logger, host = '127.0.0.1' } = options;

  const server: Server = createServer((request, response) => {
    // `url` is a path here, never absolute — this is a plain server, not a proxy — but a query
    // string would still defeat a `===`, and `/health/ready?x` is a URL somebody will type.
    const path = (request.url ?? '/').split('?')[0];
    const uptimeSeconds = Math.round(process.uptime());

    if (path === '/health/live') {
      // Liveness touches nothing, for the reason ADR 011 gives for the API's: a liveness probe
      // that consulted a dependency would restart a healthy process because Redis blinked.
      return send(response, 200, { status: 'ok', uptimeSeconds });
    }

    if (path === '/health/ready') {
      const report = describeWorkerReadiness(probe(), uptimeSeconds);
      // 503 with the same body shape as the 200, so whoever reads a failing probe sees *which*
      // check failed. An error envelope would tell them nothing.
      return send(response, report.status === 'ok' ? 200 : 503, report);
    }

    return send(response, 404, { status: 'not-found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      // A listening TCP server always has an object address; the union is `AddressInfo | string |
      // null` because the same type covers a pipe.
      const bound = typeof address === 'object' && address !== null ? address.port : port;

      server.removeListener('error', reject);
      server.on('error', (error) => {
        logger.warn({ err: error }, 'worker health server error');
      });

      logger.info({ port: bound, host }, 'worker health server listening');
      resolve({ port: bound, close: () => closeServer(server) });
    });
  });
}

/**
 * `closeAllConnections` before `close`: `close` stops accepting and then waits for open sockets,
 * and a keep-alive connection from a probe that has not timed out yet would hold the shutdown for
 * as long as the client feels like — the same class of hang `stopPrinting` in `index.ts` is written
 * around.
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);

  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
