import { expect, test, type Page } from '@playwright/test';

import {
  LOCAL_TIMEOUT_MS,
  PIPELINE_TIMEOUT_MS,
  resetServerSideState,
  uniqueTableNumber,
} from './support/stack';

/**
 * §21's end-to-end test, in full: POS-1 opens an order, adds an item, sends it to the kitchen; the
 * kitchen display shows the ticket, marks it PREPARING, and the POS follows.
 *
 * What makes it worth its runtime is the middle. Everything the POS sees up to `Send to kitchen` is
 * optimistic — §14 draws the queue folded onto the last snapshot, so those assertions prove the
 * client, not the server. The ticket appearing on the *other* browser proves the whole chain:
 * mutation → outbox row in the same transaction → publisher → Redpanda → kitchen consumer →
 * `kitchen_tickets`. And `PREPARING` arriving back on the POS is the only assertion in the
 * repository that no single process could satisfy on its own: the POS never issued that mutation
 * and never polled for it.
 *
 * Locators are roles, labels and text — the same things an operator reads — so this spec has no
 * hooks in the production markup to keep in step. Product names are read out of the DOM rather
 * than hard-coded: the menu is seed data and `BAR_MENU` already proves the list changes.
 */

const RESTAURANT_ID = 'demo-restaurant';

/** The tile aria-label is `Add {name}, {count} on the order` — see `PosView.vue`. */
const TILE_LABEL = /^Add (.+), \d+ on the order$/;

async function openPos(page: Page): Promise<void> {
  await page.goto('/pos/pos-1');
  await expect(page.getByRole('heading', { name: 'POS-1' })).toBeVisible();
  // The menu is a separate read from the order, and a create that races it would find no tiles.
  await expect(page.getByRole('button', { name: TILE_LABEL }).first()).toBeVisible({
    timeout: LOCAL_TIMEOUT_MS,
  });
  // And the socket, which is **not** cosmetic and is the difference between this test proving the
  // last segment of the pipeline and only appearing to. `menu.load()` resolves before
  // `connection.start()` does, so the tiles above are visible while the socket is still opening —
  // and `onConnected` refreshes the snapshot (§13: a reconnect repairs the §12.2 crash window).
  // A socket that connected *after* the kitchen marked PREPARING would therefore satisfy the final
  // assertion with a plain re-read, with no broadcast from the realtime consumer involved at all.
  //
  // Waiting here also makes the transport an assertion rather than an assumption: on §15's polling
  // fallback `socketState` stays DISCONNECTED and this badge never appears.
  await expect(page.getByText('WS CONNECTED', { exact: true })).toBeVisible({
    timeout: LOCAL_TIMEOUT_MS,
  });
}

test.beforeEach(async ({ request }) => {
  await resetServerSideState(request);
});

test('POS-1 sends an order, the kitchen ticket appears, and PREPARING comes back', async ({
  browser,
}) => {
  const tableNumber = uniqueTableNumber();

  // Two contexts, not two tabs: a till and a kitchen display are two devices, and each needs its
  // own IndexedDB — the POS store claims a terminal on disk (M16) and would refuse the second.
  const posContext = await browser.newContext();
  const kitchenContext = await browser.newContext();
  const pos = await posContext.newPage();
  const kitchen = await kitchenContext.newPage();

  await openPos(pos);

  // --- The order, opened on a cover unique to this run ------------------------------------------
  await pos.getByLabel('Another table').fill(tableNumber);
  await pos.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(pos.getByRole('heading', { name: `Table ${tableNumber}` })).toBeVisible({
    timeout: LOCAL_TIMEOUT_MS,
  });

  // --- One item, whatever the seed's first tile happens to be -----------------------------------
  const firstTile = pos.getByRole('button', { name: TILE_LABEL }).first();
  const tileLabel = await firstTile.getAttribute('aria-label');
  const productName = TILE_LABEL.exec(tileLabel ?? '')?.[1];
  expect(productName, `the menu tile should name its product: ${tileLabel}`).toBeTruthy();

  await firstTile.click();
  // The ± control's own label is the proof that a line exists for this product, and it says so
  // whatever the row's markup becomes.
  await expect(pos.getByRole('button', { name: `One more ${productName}` })).toBeVisible({
    timeout: LOCAL_TIMEOUT_MS,
  });

  // --- Send ------------------------------------------------------------------------------------
  await pos.getByRole('button', { name: 'Send to kitchen' }).click();

  // Optimistic: the projection shows the new status before the server has answered (§14).
  await expect(pos.getByText('SENT_TO_KITCHEN')).toBeVisible({ timeout: LOCAL_TIMEOUT_MS });
  // This is the assertion that says the server took all three mutations. A queue that stops
  // draining leaves the badge behind, and everything after here would time out for the wrong
  // reason — an offline client rather than a broken pipeline.
  await expect(pos.getByText(/^\d+ PENDING$/)).toHaveCount(0, { timeout: LOCAL_TIMEOUT_MS });

  // --- The kitchen display, on the far side of Kafka --------------------------------------------
  await kitchen.goto(`/kitchen?restaurantId=${RESTAURANT_ID}`);
  await expect(kitchen.getByRole('heading', { name: 'Kitchen' })).toBeVisible();
  // Its own socket, before it is asked to command anything — same argument as the POS's, from the
  // other end: a display whose socket is still opening reads the rail from `load()` alone.
  await expect(kitchen.getByText('WS CONNECTED', { exact: true })).toBeVisible({
    timeout: LOCAL_TIMEOUT_MS,
  });

  // The rail accumulates across runs, so the card is found by this run's cover and every
  // assertion below is scoped to it. The item rows inside a card carry no table number, so this
  // resolves to exactly one list item.
  const ticket = kitchen.getByRole('listitem').filter({ hasText: `Table ${tableNumber}` });

  await expect(ticket).toBeVisible({ timeout: PIPELINE_TIMEOUT_MS });
  await expect(ticket).toContainText('SENT_TO_KITCHEN');
  // The projection carried the line through the event, not just the header.
  await expect(ticket).toContainText(String(productName));

  // --- Mark PREPARING, from the kitchen ---------------------------------------------------------
  await ticket.getByRole('button', { name: 'Start preparing' }).click();
  await expect(ticket).toContainText('PREPARING', { timeout: PIPELINE_TIMEOUT_MS });

  // --- And the POS follows, having asked for nothing ---------------------------------------------
  await expect(pos.getByText('PREPARING')).toBeVisible({ timeout: PIPELINE_TIMEOUT_MS });

  await posContext.close();
  await kitchenContext.close();
});
