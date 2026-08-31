import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  LOCAL_TIMEOUT_MS,
  PIPELINE_TIMEOUT_MS,
  resetServerSideState,
  uniqueTableNumber,
} from './support/stack';

const ASSET = resolve('.verify-output/restaurant-pos-demo.webm');
const RECORDINGS = resolve('.verify-output/.recordings');
const TILE_LABEL = /^Add (.+), \d+ on the order$/;

async function caption(page: Page, title: string, detail: string, holdMs = 4_500): Promise<void> {
  await page.evaluate(
    ({ title, detail }) => {
      document.querySelector('#recording-caption')?.remove();
      const card = document.createElement('aside');
      card.id = 'recording-caption';
      card.style.cssText = [
        'position:fixed',
        'z-index:2147483647',
        'left:24px',
        'bottom:24px',
        'max-width:720px',
        'padding:16px 20px',
        'border-radius:14px',
        'background:rgba(23,32,28,.94)',
        'color:white',
        'font:16px/1.35 system-ui,sans-serif',
        'box-shadow:0 12px 36px rgba(0,0,0,.3)',
        'pointer-events:none',
      ].join(';');
      const heading = document.createElement('strong');
      heading.textContent = title;
      heading.style.cssText = 'display:block;font-size:22px;margin-bottom:4px';
      const copy = document.createElement('span');
      copy.textContent = detail;
      card.append(heading, copy);
      document.body.append(card);
    },
    { title, detail },
  );
  // This is presentation pacing, not synchronization. Every state change below still uses a
  // web-first assertion; the pause only leaves enough frames for a viewer to read the caption.
  await page.waitForTimeout(holdMs);
}

async function transitionTo(
  page: Page,
  linkName: 'POS' | 'Kitchen' | 'Debug',
  title: string,
  ready: Locator,
  timeout = LOCAL_TIMEOUT_MS,
): Promise<void> {
  await page.evaluate((title) => {
    document.querySelector('#recording-caption')?.remove();
    const cover = document.createElement('div');
    cover.id = 'recording-transition';
    cover.textContent = title;
    cover.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'inset:0',
      'display:grid',
      'place-items:center',
      'background:#17201c',
      'color:white',
      'font:600 30px/1.2 system-ui,sans-serif',
      'letter-spacing:.01em',
      'opacity:0',
      'transition:opacity 400ms ease',
      'pointer-events:none',
    ].join(';');
    document.body.append(cover);
    requestAnimationFrame(() => {
      cover.style.opacity = '1';
    });
  }, title);
  await page.waitForTimeout(500);

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: linkName, exact: true })
    .click();
  await expect(ready).toBeVisible({ timeout });
  await ready.scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);

  await page.evaluate(() => {
    const cover = document.querySelector<HTMLElement>('#recording-transition');
    if (cover !== null) {
      cover.style.opacity = '0';
    }
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('#recording-transition')?.remove());
}

async function openFreshOrder(page: Page, table: string): Promise<void> {
  const newOrder = page.getByRole('button', { name: /^New table$/ });
  if (await newOrder.isVisible()) {
    await newOrder.click();
  }
  await page.getByLabel('Another table').fill(table);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Table ${table}` })).toBeVisible({
    timeout: LOCAL_TIMEOUT_MS,
  });
  await page.waitForTimeout(600);
}

async function firstMenuTile(page: Page) {
  const tile = page.getByRole('button', { name: TILE_LABEL }).first();
  await expect(tile).toBeVisible({ timeout: LOCAL_TIMEOUT_MS });
  return tile;
}

async function pacedTap(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeEnabled();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) {
    throw new Error('recording tap target has no visible bounding box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.waitForTimeout(180);
  await page.mouse.up();
  await page.waitForTimeout(1_250);
}

test.beforeEach(async ({ request }) => {
  await resetServerSideState(request);
});

test('record the interview demo', async ({ browser }) => {
  rmSync(RECORDINGS, { recursive: true, force: true });
  mkdirSync(RECORDINGS, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: RECORDINGS, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const video = page.video();

  // 1. The normal realtime path.
  const realtimeTable = uniqueTableNumber();
  await page.goto('/pos/pos-1');
  await expect(page.getByText('WS CONNECTED', { exact: true })).toBeVisible({
    timeout: LOCAL_TIMEOUT_MS,
  });
  await caption(
    page,
    '1 · Realtime order flow',
    'The POS commits mutations; the kitchen reads a Kafka-built projection.',
  );
  await openFreshOrder(page, realtimeTable);
  await pacedTap(page, await firstMenuTile(page));
  await pacedTap(page, page.getByRole('button', { name: 'Send to kitchen' }));
  await expect(page.getByText(/^\d+ PENDING$/)).toHaveCount(0, { timeout: LOCAL_TIMEOUT_MS });
  const realtimeTicket = page.getByRole('listitem').filter({ hasText: `Table ${realtimeTable}` });
  await transitionTo(
    page,
    'Kitchen',
    'Opening the kitchen display',
    realtimeTicket,
    PIPELINE_TIMEOUT_MS,
  );
  await caption(
    page,
    'Realtime projection arrived',
    'Postgres → outbox → Redpanda → kitchen consumer → Socket.IO.',
  );

  // 2. Offline work and deterministic reconnect drain.
  const offlineTable = uniqueTableNumber();
  await transitionTo(
    page,
    'POS',
    'Taking the terminal offline',
    page.getByRole('button', { name: 'Simulate Offline' }),
  );
  await openFreshOrder(page, offlineTable);
  await page.getByRole('button', { name: 'Simulate Offline' }).click();
  await caption(
    page,
    '2 · Offline-capable client',
    'Mutations keep their ids and projected versions in IndexedDB.',
  );
  const offlineTile = await firstMenuTile(page);
  await pacedTap(page, offlineTile);
  await pacedTap(page, page.getByRole('button', { name: /^One more / }).first());
  await pacedTap(page, page.getByRole('button', { name: 'Send to kitchen' }));
  await expect(page.getByText('3 PENDING', { exact: true })).toBeVisible();
  await caption(
    page,
    'Three mutations queued locally',
    'The UI remains optimistic while the API is unreachable.',
  );
  await page.getByRole('button', { name: 'Go back online' }).click();
  await expect(page.getByText(/^\d+ PENDING$/)).toHaveCount(0, { timeout: PIPELINE_TIMEOUT_MS });
  await caption(
    page,
    'Reconnect drained the queue',
    'Mutations were sent sequentially; the durable queue is empty.',
  );

  // 3. A visible optimistic-concurrency conflict and explicit resolution.
  const conflictTable = uniqueTableNumber();
  await openFreshOrder(page, conflictTable);
  await pacedTap(page, await firstMenuTile(page));
  await expect(page.getByText(/^\d+ PENDING$/)).toHaveCount(0, { timeout: LOCAL_TIMEOUT_MS });
  const conflictArm = page.getByRole('button', { name: 'Create Version Conflict' });
  await transitionTo(page, 'Debug', 'Arming a competing write', conflictArm);
  await conflictArm.click();
  // Client simulator arms are tab-local module state (ADR 015), so cross this boundary through
  // Vue Router. A full navigation would correctly reset the arm and turn this into a fake demo.
  await transitionTo(
    page,
    'POS',
    'Returning to the affected order',
    page.getByRole('button', { name: TILE_LABEL }).first(),
  );
  await pacedTap(page, await firstMenuTile(page));
  await expect(page.getByText('CONFLICT — this order is blocked.')).toBeVisible({
    timeout: LOCAL_TIMEOUT_MS,
  });
  await caption(
    page,
    '3 · Concurrent write detected',
    'A stale baseVersion halted this order. The queued tail was not sent.',
  );
  await page.getByRole('button', { name: /^Rebase onto v\d+$/ }).click();
  await expect(page.getByText('CONFLICT — this order is blocked.')).toHaveCount(0, {
    timeout: LOCAL_TIMEOUT_MS,
  });
  await caption(
    page,
    'Operator chose Rebase',
    'A fresh mutation id was issued at the canonical version.',
  );

  // 4. The broker boundary fails without losing the order.
  const outboxTable = uniqueTableNumber();
  const pause = page.getByRole('button', { name: 'Pause Outbox Publisher' });
  await transitionTo(page, 'Debug', 'Pausing the event publisher', pause);
  await pause.click();
  await expect(page.getByText('paused', { exact: true }).last()).toBeVisible();
  await caption(
    page,
    '4 · Publisher paused',
    'The fleet-wide switch lives in PostgreSQL. Orders remain writable.',
  );
  await page.waitForTimeout(800);
  await transitionTo(
    page,
    'POS',
    'Taking an order during the outage',
    page.getByRole('button', { name: /^New table$/ }),
  );
  await openFreshOrder(page, outboxTable);
  await pacedTap(page, await firstMenuTile(page));
  await pacedTap(page, page.getByRole('button', { name: 'Send to kitchen' }));
  await expect(page.getByText(/^\d+ PENDING$/)).toHaveCount(0, { timeout: LOCAL_TIMEOUT_MS });
  await caption(
    page,
    'Order accepted while publishing is stopped',
    'The order and its outbox rows committed atomically.',
  );
  const backlog = page.getByText(/Outbox — [1-9]\d* pending/);
  await transitionTo(page, 'Debug', 'Inspecting the durable backlog', backlog);
  await caption(
    page,
    'Backlog is visible and attempts remain zero',
    'The outage delays delivery; it does not lose the order.',
  );
  const resume = page.getByRole('button', { name: 'Resume Outbox Publisher' });
  await resume.scrollIntoViewIfNeeded();
  await resume.click();
  const recoveredTicket = page.getByRole('listitem').filter({ hasText: `Table ${outboxTable}` });
  await transitionTo(
    page,
    'Kitchen',
    'Watching the kitchen recover',
    recoveredTicket,
    PIPELINE_TIMEOUT_MS,
  );
  await caption(
    page,
    'Publisher recovered; backlog drained',
    'The deferred ticket reached the kitchen in event order.',
    5_500,
  );

  await page.close();
  await context.close();
  if (video === null) {
    throw new Error('Playwright did not create a video for the demo page');
  }
  await video.saveAs(ASSET);
  await video.delete();
  rmSync(RECORDINGS, { recursive: true, force: true });
});
