import { sql } from 'drizzle-orm';

import type { Db } from './client.js';
import { featureFlags, products, restaurants, terminals } from './schema.js';

export const RESTAURANTS = [
  { id: 'demo-restaurant', name: 'Demo Restaurant' },
  { id: 'second-restaurant', name: 'Second Restaurant' },
] as const;

/** POS-3 lives in the second restaurant: it is what makes §21.11 and the §15 rollout showable. */
export const TERMINALS = [
  { id: 'pos-1', restaurantId: 'demo-restaurant', label: 'POS-1' },
  { id: 'pos-2', restaurantId: 'demo-restaurant', label: 'POS-2' },
  { id: 'bar-1', restaurantId: 'demo-restaurant', label: 'BAR-1' },
  { id: 'pos-3', restaurantId: 'second-restaurant', label: 'POS-3' },
] as const;

export const PRODUCTS = [
  { id: 'burger', name: 'Burger', priceCents: 1200 },
  { id: 'cheeseburger', name: 'Cheeseburger', priceCents: 1400 },
  { id: 'pizza', name: 'Pizza', priceCents: 1500 },
  { id: 'caesar-salad', name: 'Caesar Salad', priceCents: 1000 },
  { id: 'french-fries', name: 'French Fries', priceCents: 500 },
  { id: 'cola', name: 'Cola', priceCents: 300 },
  { id: 'coffee', name: 'Coffee', priceCents: 400 },
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
      .values([...TERMINALS])
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
