import { loadConfig } from '@pos/config';

import { createDb } from '../src/client.js';
import {
  FEATURE_FLAGS,
  PRODUCTS,
  RESTAURANTS,
  TERMINALS,
  seedReferenceData,
} from '../src/reference-data.js';

const { db, close } = createDb(loadConfig().DATABASE_URL);

try {
  await seedReferenceData(db);
  console.log(
    `Seed applied: ${RESTAURANTS.length} restaurants, ${TERMINALS.length} terminals, ` +
      `${PRODUCTS.length} products, ${FEATURE_FLAGS.length} feature flag(s).`,
  );
} catch (error) {
  console.error('Seed failed:', error);
  process.exitCode = 1;
} finally {
  await close();
}
