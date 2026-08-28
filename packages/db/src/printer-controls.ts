import { eq, sql } from 'drizzle-orm';

import type { Db } from './client.js';
import { printerControls } from './schema.js';

/** One switch, one row: see the comment on `printerControls` in the schema. */
const SINGLETON = 'singleton';

/** §18's `Fail Printer`, as the fake device sees it. */
export interface PrinterControls {
  failing: boolean;
}

export const DEFAULT_PRINTER_CONTROLS: PrinterControls = { failing: false };

/**
 * Lives in `@pos/db` rather than in either application because both ends need it and neither owns
 * it: the API's fake printer reads the switch on every print, and the worker's CLI writes it. The
 * alternative was two copies of "one row, id `singleton`, a missing row means the defaults", which
 * is exactly the kind of rule that drifts.
 */
export async function readPrinterControls(db: Db): Promise<PrinterControls> {
  const [row] = await db
    .select()
    .from(printerControls)
    .where(eq(printerControls.id, SINGLETON))
    .limit(1);

  return row === undefined ? DEFAULT_PRINTER_CONTROLS : { failing: row.failing };
}

export async function setPrinterControls(db: Db, patch: PrinterControls): Promise<void> {
  await db
    .insert(printerControls)
    .values({ id: SINGLETON, failing: patch.failing })
    .onConflictDoUpdate({
      target: printerControls.id,
      set: { failing: patch.failing, updatedAt: sql`now()` },
    });
}
