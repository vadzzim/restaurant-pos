import { randomUUID } from 'node:crypto';

import { maxPublishDelayMs, type SimulatorResponse } from '@pos/contracts';
import { outboxEvents, readOutboxControls, readPrinterControls } from '@pos/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { DEMO_RESTAURANT, db, testApp, useTestDatabase } from './helpers.js';

useTestDatabase();

/** `buildApp`'s default, restated so the ceiling assertion below does not depend on it. */
const LEASE_MS = 30_000;

async function insertOutboxRow(
  overrides: Partial<typeof outboxEvents.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await db()
    .insert(outboxEvents)
    .values({
      id,
      aggregateId: randomUUID(),
      aggregateType: 'order',
      restaurantId: DEMO_RESTAURANT,
      eventType: 'OrderCreated',
      eventVersion: 1,
      payload: {},
      ...overrides,
    });
  return id;
}

async function post(
  app: ReturnType<typeof buildApp>,
  control: string,
  payload: Record<string, unknown> = {},
) {
  return app.inject({ method: 'POST', url: `/api/debug/simulator/${control}`, payload });
}

describe('GET /api/debug/simulator', () => {
  it('reports the defaults when no control row has ever been written', async () => {
    const app = testApp();
    const response = await app.inject({ method: 'GET', url: '/api/debug/simulator' });

    expect(response.statusCode).toBe(200);
    expect(response.json<SimulatorResponse>().state).toEqual({
      outbox: { paused: false, publishDelayMs: 0 },
      printer: { failing: false },
    });
  });
});

describe('POST /api/debug/simulator/:control', () => {
  it('pauses and resumes the publisher, and each switch leaves the other alone', async () => {
    const app = testApp();

    await post(app, 'outbox-delay', { publishDelayMs: 250 });
    const paused = await post(app, 'outbox-pause', { enabled: true });

    // The whole point of patching one field at a time: a pause must not silently clear a delay.
    expect(paused.json<SimulatorResponse>().state.outbox).toEqual({
      paused: true,
      publishDelayMs: 250,
    });
    expect(await readOutboxControls(db())).toEqual({ paused: true, publishDelayMs: 250 });

    const resumed = await post(app, 'outbox-pause', { enabled: false });
    expect(resumed.json<SimulatorResponse>().state.outbox).toEqual({
      paused: false,
      publishDelayMs: 250,
    });
  });

  it('refuses a delay past the publisher lease ceiling, and the row is untouched', async () => {
    const app = buildApp({ db: db(), logLevel: 'silent', outboxLeaseMs: LEASE_MS });
    const ceiling = maxPublishDelayMs(LEASE_MS);

    const accepted = await post(app, 'outbox-delay', { publishDelayMs: ceiling });
    expect(accepted.statusCode).toBe(200);

    const refused = await post(app, 'outbox-delay', { publishDelayMs: ceiling + 1 });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
    expect((await readOutboxControls(db())).publishDelayMs).toBe(ceiling);
  });

  it('fails and fixes the printer', async () => {
    const app = testApp();

    const failing = await post(app, 'printer-fail', { enabled: true });
    expect(failing.json<SimulatorResponse>().state.printer).toEqual({ failing: true });
    expect(await readPrinterControls(db())).toEqual({ failing: true });

    await post(app, 'printer-fail', { enabled: false });
    expect(await readPrinterControls(db())).toEqual({ failing: false });
  });

  it('rejects an unknown control and a body of the wrong shape', async () => {
    const app = testApp();

    const unknown = await post(app, 'melt-the-broker', { enabled: true });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ message: string }>().message).toContain('outbox-pause');

    const badBody = await post(app, 'outbox-pause', { enabled: 'yes' });
    expect(badBody.statusCode).toBe(400);
    expect(await readOutboxControls(db())).toEqual({ paused: false, publishDelayMs: 0 });
  });
});

describe('POST /api/debug/simulator/replay-last-event', () => {
  it('puts the newest published row back into the claimable state', async () => {
    const app = testApp();
    const older = await insertOutboxRow({ publishedAt: new Date('2026-01-01T10:00:00Z') });
    const newest = await insertOutboxRow({
      eventType: 'OrderItemAdded',
      eventVersion: 2,
      publishedAt: new Date('2026-01-01T11:00:00Z'),
      claimedBy: 'worker-that-published-it',
      lastError: 'a previous attempt failed',
    });

    const response = await post(app, 'replay-last-event');
    expect(response.statusCode).toBe(200);

    const body = response.json<SimulatorResponse>();
    expect(body.replayed).toMatchObject({
      eventId: newest,
      eventType: 'OrderItemAdded',
      eventVersion: 2,
      previouslyPublishedAt: '2026-01-01T11:00:00.000Z',
    });

    const [row] = await db().select().from(outboxEvents).where(eq(outboxEvents.id, newest));
    expect(row?.publishedAt).toBeNull();
    expect(row?.claimedBy).toBeNull();
    expect(row?.claimUntil).toBeNull();
    expect(row?.lastError).toBeNull();

    // Only the newest: a replay is one event, not a re-publication of the whole history.
    const [untouched] = await db().select().from(outboxEvents).where(eq(outboxEvents.id, older));
    expect(untouched?.publishedAt).not.toBeNull();
  });

  it('walks back through the history, one event per press', async () => {
    const app = testApp();
    await insertOutboxRow({ publishedAt: new Date('2026-01-01T10:00:00Z') });
    await insertOutboxRow({ publishedAt: new Date('2026-01-01T11:00:00Z') });

    const first = (await post(app, 'replay-last-event')).json<SimulatorResponse>();
    const second = (await post(app, 'replay-last-event')).json<SimulatorResponse>();
    const third = (await post(app, 'replay-last-event')).json<SimulatorResponse>();

    expect(first.replayed?.previouslyPublishedAt).toBe('2026-01-01T11:00:00.000Z');
    expect(second.replayed?.previouslyPublishedAt).toBe('2026-01-01T10:00:00.000Z');
    expect(third.replayed).toBeNull();
  });

  it('ignores unpublished and dead-lettered rows', async () => {
    const app = testApp();
    await insertOutboxRow();
    await insertOutboxRow({
      publishedAt: new Date('2026-01-01T12:00:00Z'),
      deadLetteredAt: new Date('2026-01-01T12:00:01Z'),
    });

    // A dead-lettered row is a decision, not a candidate: replaying it would quietly undo a
    // publisher that gave up (ADR 010).
    expect((await post(app, 'replay-last-event')).json<SimulatorResponse>().replayed).toBeNull();
  });
});
