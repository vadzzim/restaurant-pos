import type { MenuItem } from '@pos/contracts';
import { products, type Db } from '@pos/db';
import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/** The menu is reference data: no tenant scoping, because every restaurant sells the same list. */
export function registerMenuRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/menu', async (): Promise<MenuItem[]> => {
    const rows = await db
      .select({ id: products.id, name: products.name, priceCents: products.priceCents })
      .from(products)
      .orderBy(asc(products.name));

    return rows;
  });
}
