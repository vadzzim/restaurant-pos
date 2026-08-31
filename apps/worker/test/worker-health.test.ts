import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import {
  describeWorkerReadiness,
  startWorkerHealthServer,
  type WorkerHealthChecks,
  type WorkerHealthServer,
} from '../src/modules/health/worker-health.js';

const logger = pino({ level: 'silent' });

const READY: WorkerHealthChecks = {
  brokerConnected: true,
  publisherPassCompleted: true,
  printWorkerRunning: true,
};

let server: WorkerHealthServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Port 0, so the suite never collides with a worker the developer has running. */
async function start(probe: () => WorkerHealthChecks): Promise<string> {
  server = await startWorkerHealthServer({ port: 0, probe, logger });
  return `http://127.0.0.1:${server.port}`;
}

describe('the worker readiness predicate', () => {
  it('is ready only when all three checks hold', () => {
    expect(describeWorkerReadiness(READY, 1).status).toBe('ok');
  });

  // One case per field rather than one loop, because what would break is a conjunction losing a
  // term, and a loop over the keys would be written from the same list as the implementation.
  it('is unavailable while the broker session is down', () => {
    expect(describeWorkerReadiness({ ...READY, brokerConnected: false }, 1).status).toBe(
      'unavailable',
    );
  });

  it('is unavailable until the publisher loop has turned once', () => {
    expect(describeWorkerReadiness({ ...READY, publisherPassCompleted: false }, 1).status).toBe(
      'unavailable',
    );
  });

  it('is unavailable when the print worker has stopped consuming', () => {
    expect(describeWorkerReadiness({ ...READY, printWorkerRunning: false }, 1).status).toBe(
      'unavailable',
    );
  });

  // The body is the same shape on 200 and 503 on purpose: whoever reads a failing healthcheck
  // needs to see *which* check failed.
  it('reports the checks it was given, ready or not', () => {
    const report = describeWorkerReadiness({ ...READY, brokerConnected: false }, 42);

    expect(report.checks).toEqual({ ...READY, brokerConnected: false });
    expect(report.uptimeSeconds).toBe(42);
  });
});

describe('the worker health server', () => {
  it('answers 200 on /health/ready when the worker is ready', async () => {
    const origin = await start(() => READY);
    const response = await fetch(`${origin}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', checks: READY });
  });

  it('answers 503 on /health/ready when it is not, which is what gates `up --wait`', async () => {
    const origin = await start(() => ({ ...READY, brokerConnected: false }));
    const response = await fetch(`${origin}/health/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'unavailable',
      checks: { brokerConnected: false },
    });
  });

  // The probe is read per request, not captured at startup: a worker that lost its broker session
  // has to start failing the healthcheck it was passing a moment ago.
  it('re-reads the probe on every request', async () => {
    let connected = false;
    const origin = await start(() => ({ ...READY, brokerConnected: connected }));

    expect((await fetch(`${origin}/health/ready`)).status).toBe(503);
    connected = true;
    expect((await fetch(`${origin}/health/ready`)).status).toBe(200);
  });

  it('answers liveness without consulting the probe at all', async () => {
    const origin = await start(() => {
      throw new Error('liveness must not read the dependencies (ADR 011)');
    });
    const response = await fetch(`${origin}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('ignores a query string, which is what a human typing the URL will add', async () => {
    const origin = await start(() => READY);

    expect((await fetch(`${origin}/health/ready?pretty`)).status).toBe(200);
  });

  it('answers 404 on anything else', async () => {
    const origin = await start(() => READY);

    expect((await fetch(`${origin}/`)).status).toBe(404);
  });

  // The bind failure `index.ts` catches into a warning. Asserted here because the alternative — a
  // process that exits because a *probe* could not start — is the regression the opt-in port and
  // that catch exist to prevent.
  it('rejects rather than throwing asynchronously when the port is taken', async () => {
    const origin = await start(() => READY);
    const port = Number(new URL(origin).port);

    await expect(startWorkerHealthServer({ port, probe: () => READY, logger })).rejects.toThrow(
      /EADDRINUSE/,
    );
  });
});
