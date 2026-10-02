/**
 * Ownership checks for ids that arrive from a caller.
 *
 * Every user of a deployment shares one database tenant, so nothing below the
 * application stops a route from reading or writing another user's document:
 * an id taken from a body, query string or tool argument is only safe once
 * the document it names is known to belong to the caller.
 *
 * The answer for "not yours" is deliberately the same as for "does not
 * exist", so a caller cannot use a route to learn which ids are real.
 */

import type { DocumentSnapshot, Firestore } from "firebase-admin/firestore";

/** Ids are opaque document ids, never paths: no separators, bounded length. */
export function isPlainDocId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 256 &&
    !id.includes("/") &&
    id !== "." &&
    id !== ".."
  );
}

/**
 * The snapshot of `collection/id` when it exists and `userId === uid`,
 * otherwise null. Never throws for a malformed id; that is just "not found".
 */
export async function getOwnedDoc(
  db: Firestore,
  collection: string,
  id: unknown,
  uid: string
): Promise<DocumentSnapshot | null> {
  if (!isPlainDocId(id) || !uid) return null;
  const snap = await db.collection(collection).doc(id).get();
  if (!snap.exists) return null;
  return snap.data()?.userId === uid ? snap : null;
}

/** True when every id names a document the caller owns. */
export async function ownsAll(
  db: Firestore,
  collection: string,
  ids: unknown[],
  uid: string
): Promise<boolean> {
  for (const id of ids) {
    if (!(await getOwnedDoc(db, collection, id, uid))) return false;
  }
  return true;
}
