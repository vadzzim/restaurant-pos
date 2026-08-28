import { randomUUID } from 'node:crypto';

import {
  PRINTER_IDEMPOTENCY_HEADER,
  type ApiErrorResponse,
  type PrintTicketRequest,
  type PrintTicketResponse,
} from '@pos/contracts';
import { setPrinterControls } from '@pos/db';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createFakePrinter } from '../src/modules/printer/application/fake-printer.js';
import { DEMO_RESTAURANT, db, useTestDatabase } from './helpers.js';

useTestDatabase();

function ticket(): PrintTicketRequest {
  return {
    orderId: randomUUID(),
    restaurantId: DEMO_RESTAURANT,
    tableNumber: '12',
    items: [{ productId: 'burger', name: 'Burger', quantity: 2, unitPriceCents: 950 }],
  };
}

/** The device is built here rather than inside `buildApp`, so the test can count physical prints. */
function printerApp(): { app: ReturnType<typeof buildApp>; physicalPrints: () => number } {
  const printer = createFakePrinter();
  return {
    app: buildApp({ db: db(), logLevel: 'silent', printer }),
    physicalPrints: () => printer.physicalPrints(),
  };
}

async function print(
  app: ReturnType<typeof buildApp>,
  body: PrintTicketRequest,
  key: string,
): Promise<{ statusCode: number; body: PrintTicketResponse }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/printer/print',
    headers: { [PRINTER_IDEMPOTENCY_HEADER]: key },
    payload: body,
  });

  return { statusCode: response.statusCode, body: response.json<PrintTicketResponse>() };
}

/**
 * §21.14. The spec is precise about what this proves: the *endpoint* honours an idempotency key.
 * It says nothing about paper, and §12.3 says why nothing could.
 */
describe('§21.14 the fake printer honours an idempotency key', () => {
  it('prints once when the same ticket hash arrives twice', async () => {
    const { app, physicalPrints } = printerApp();
    const body = ticket();
    const key = 'ticket-hash-aaa';

    const first = await print(app, body, key);
    const second = await print(app, body, key);

    expect(first.statusCode).toBe(200);
    expect(first.body.printed).toBe(true);
    expect(first.body.duplicate).toBe(false);

    expect(second.statusCode).toBe(200);
    expect(second.body.printed).toBe(false);
    expect(second.body.duplicate).toBe(true);
    // The device answers with the receipt it issued the first time, so a caller that lost the
    // first response can still tell which ticket its retry corresponds to.
    expect(second.body.receiptId).toBe(first.body.receiptId);

    expect(physicalPrints()).toBe(1);
  });

  it('prints again for a different key, which is what makes the first assertion mean something', async () => {
    const { app, physicalPrints } = printerApp();
    const body = ticket();

    await print(app, body, 'ticket-hash-aaa');
    const other = await print(app, body, 'ticket-hash-bbb');

    expect(other.body.printed).toBe(true);
    expect(physicalPrints()).toBe(2);
  });
});

describe('POST /api/printer/print', () => {
  it('refuses a request with no idempotency key', async () => {
    const { app, physicalPrints } = printerApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/printer/print',
      payload: ticket(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ApiErrorResponse>().code).toBe('VALIDATION_FAILED');
    expect(physicalPrints()).toBe(0);
  });

  it('rejects a ticket with no items before the device sees it', async () => {
    const { app, physicalPrints } = printerApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/printer/print',
      headers: { [PRINTER_IDEMPOTENCY_HEADER]: 'ticket-hash-ccc' },
      payload: { ...ticket(), items: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(physicalPrints()).toBe(0);
  });

  it('answers 503 while Fail Printer is set, and prints again once it is cleared', async () => {
    const { app, physicalPrints } = printerApp();
    const body = ticket();

    await setPrinterControls(db(), { failing: true });

    const failed = await app.inject({
      method: 'POST',
      url: '/api/printer/print',
      headers: { [PRINTER_IDEMPOTENCY_HEADER]: 'ticket-hash-ddd' },
      payload: body,
    });

    expect(failed.statusCode).toBe(503);
    expect(failed.json<ApiErrorResponse>().code).toBe('PRINTER_OFFLINE');
    expect(physicalPrints()).toBe(0);

    // The switch is read per request, so nothing is restarted between these two calls.
    await setPrinterControls(db(), { failing: false });
    const fixed = await print(app, body, 'ticket-hash-ddd');

    expect(fixed.body.printed).toBe(true);
    expect(physicalPrints()).toBe(1);
  });
});
