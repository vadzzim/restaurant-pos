import { TERMINALS } from '@pos/contracts';
import { sql } from 'drizzle-orm';

import type { Db } from './client.js';
import { featureFlags, products, restaurants, terminals } from './schema.js';

export const RESTAURANTS = [
  { id: 'demo-restaurant', name: 'Demo Restaurant' },
  { id: 'second-restaurant', name: 'Second Restaurant' },
] as const;

// The terminal list itself lives in @pos/contracts: the browser resolves a terminal's restaurant
// from the URL and must read the same list this seed writes.
export { TERMINALS };

export const PRODUCTS = [
  { id: 'burger', name: 'Burger', priceCents: 1200 },
  { id: 'cheeseburger', name: 'Cheeseburger', priceCents: 1400 },
  { id: 'pizza', name: 'Pizza', priceCents: 1500 },
  { id: 'caesar-salad', name: 'Caesar Salad', priceCents: 1000 },
  { id: 'french-fries', name: 'French Fries', priceCents: 500 },
  { id: 'cola', name: 'Cola', priceCents: 300 },
  { id: 'coffee', name: 'Coffee', priceCents: 400 },
  // The bar half of the menu. `BAR_MENU` in @pos/contracts is what decides that BAR-1 shows these
  // and not the food; a product added here is invisible at the bar until it is named there too.
  { id: 'draft-beer', name: 'Draft Beer', priceCents: 700 },
  { id: 'house-red', name: 'House Red', priceCents: 900 },
  { id: 'house-white', name: 'House White', priceCents: 900 },
  { id: 'sparkling-water', name: 'Sparkling Water', priceCents: 350 },
] as const;

export const FEATURE_FLAGS = [
  { key: 'realtime.websocket_push', enabled: true, rolloutPercent: 100 },
] as const;

/** `excluded` is the row PostgreSQL was about to insert, so re-seeding refreshes reference data. */
const excluded = (column: string) => sql.raw(`excluded."${column}"`);

/** Idempotent: safe to run against a seeded database, a test database, or an empty one. */
export async function seedReferenceData(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(restaurants)
      .values([...RESTAURANTS])
      .onConflictDoUpdate({ target: restaurants.id, set: { name: excluded('name') } });

    await tx
      .insert(terminals)
      // `profile` is a screen property (@pos/contracts), not a column: the API never reads it, so
      // it is projected out here rather than given a migration nothing on the server would use.
      .values(TERMINALS.map(({ id, restaurantId, label }) => ({ id, restaurantId, label })))
      .onConflictDoUpdate({
        target: terminals.id,
        set: { restaurantId: excluded('restaurant_id'), label: excluded('label') },
      });

    await tx
      .insert(products)
      .values([...PRODUCTS])
      .onConflictDoUpdate({
        target: products.id,
        set: { name: excluded('name'), priceCents: excluded('price_cents') },
      });

    // Deliberately do-nothing: once /debug can toggle this flag (M13), a re-seed must not
    // silently re-enable a flag an operator turned off.
    await tx
      .insert(featureFlags)
      .values([...FEATURE_FLAGS])
      .onConflictDoNothing({ target: featureFlags.key });
  });
}
