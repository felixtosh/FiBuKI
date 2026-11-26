/**
 * Orphaned Transactions: a User's Transactions whose Bank Account no longer
 * exists, the leftovers of a failed delete. The one delete both cleanups use,
 * the admin callable and the Bank Accounts page's route (#813): filed years
 * keep their evidence (#794), so a closed orphan stays.
 *
 * Callable-free (no `createCallable`, no `firebase-functions`), so a Next API
 * route can import it.
 */

import { readFiscalYears, stretchOf } from "../fiscalYears/settings";
import { toDateSafe } from "../utils/toDateSafe";

type Db = FirebaseFirestore.Firestore;
type Row = FirebaseFirestore.QueryDocumentSnapshot;

const BATCH_SIZE = 500;

/** The rows naming a Bank Account outside `validSourceIds`. A row without one is no orphan. */
export function orphanRows(rows: Row[], validSourceIds: Set<string>): Row[] {
  return rows.filter((d) => {
    const sourceId = d.data().sourceId;
    return !!sourceId && !validSourceIds.has(sourceId);
  });
}

/** Delete the orphans dated outside the Closed stretch; keep and count the closed ones. */
export async function deleteOrphanRows(
  db: Db,
  userId: string,
  orphans: Row[]
): Promise<{ deleted: number; keptClosed: number }> {
  const fiscalYears = await readFiscalYears(db, userId);
  const deletable = orphans.filter((d) => {
    const date = toDateSafe(d.data().date);
    return !(date && stretchOf(fiscalYears, date) === "closed");
  });

  for (let i = 0; i < deletable.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const row of deletable.slice(i, i + BATCH_SIZE)) batch.delete(row.ref);
    await batch.commit();
  }

  return { deleted: deletable.length, keptClosed: orphans.length - deletable.length };
}
