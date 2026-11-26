/**
 * Orphaned Transactions: a User's Transactions whose Bank Account no longer
 * exists, the leftovers of a failed delete, and the delete the
 * `cleanupOrphanedTransactions` callable runs on them. Filed years keep their
 * evidence (#794), so a closed orphan stays; every File comes off a deleted
 * one first, through the File Connection writer (#612), so no File keeps
 * listing it.
 */

import { detachTransactions } from "../fileConnections/writer";
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

/** Delete the orphans dated outside the Closed stretch, Files detached first; keep and count the closed ones. */
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
    const chunk = deletable.slice(i, i + BATCH_SIZE);
    await detachTransactions(
      db,
      userId,
      chunk.map((d) => ({ id: d.id, data: d.data() })),
      { why: "as an orphan of a deleted bank account" }
    );
    const batch = db.batch();
    for (const row of chunk) batch.delete(row.ref);
    await batch.commit();
  }

  return { deleted: deletable.length, keptClosed: orphans.length - deletable.length };
}
