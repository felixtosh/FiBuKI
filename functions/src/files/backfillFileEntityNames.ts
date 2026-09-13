/**
 * Backfill File Entity Names (#299)
 *
 * One-time callable that decodes HTML character references (e.g. "&amp;") in
 * the names of the stored counterparty entities — `extractedIssuer.name` and
 * `extractedRecipient.name` — on file records written before entity
 * normalisation started decoding them. The same treatment #233 gave Partner
 * records, applied to the entities identity matching actually reads.
 *
 * Sequenced after #281, which is what made a persisted backfill value
 * trustworthy: this pass only ever writes a value derived from what is already
 * on the record, never a guess.
 *
 * Idempotent — a record whose entity names already decode to themselves is
 * skipped, and a name with no character reference in it (including one holding
 * a bare "&") comes back byte-identical, so it is skipped too.
 *
 * Scope is the stored entity shape. `invoiceDirection` and the § 11
 * classification derived from it are re-derived by the `onUserDataUpdate`
 * sweep, which runs on the next identity edit, and by re-extraction — this
 * pass deliberately does not duplicate that derivation.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable } from "../utils/createCallable";
import { decodeHtmlEntities } from "../utils/htmlEntities";

interface BackfillFileEntityNamesRequest {
  // empty — operates on all files for the calling user
}

interface BackfillFileEntityNamesResponse {
  success: boolean;
  updated: number;
  skipped: number;
}

/** The stored entity shape, read defensively: these are legacy records. */
type StoredEntity = { name?: unknown } & Record<string, unknown>;

/**
 * The decoded name for a stored entity, or null when there is nothing to
 * write — no entity, no string name, or a name that decodes to itself.
 */
function decodedName(entity: unknown): string | null {
  if (!entity || typeof entity !== "object") return null;

  const name = (entity as StoredEntity).name;
  if (typeof name !== "string" || !name) return null;

  const decoded = decodeHtmlEntities(name);
  return decoded === name ? null : decoded;
}

export const backfillFileEntityNamesCallable = createCallable<
  BackfillFileEntityNamesRequest,
  BackfillFileEntityNamesResponse
>(
  { name: "backfillFileEntityNames" },
  async (ctx) => {
    const filesSnap = await ctx.db
      .collection("files")
      .where("userId", "==", ctx.userId)
      .get();

    let updated = 0;
    let skipped = 0;

    for (const fileDoc of filesSnap.docs) {
      const data = fileDoc.data();

      const issuerName = decodedName(data.extractedIssuer);
      const recipientName = decodedName(data.extractedRecipient);

      if (issuerName === null && recipientName === null) {
        skipped++;
        continue;
      }

      // Rewrite the whole entity rather than a dotted path: the entity is a
      // map and only its `name` moves, so spreading keeps every other field
      // exactly as stored.
      const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
      if (issuerName !== null) {
        update.extractedIssuer = { ...(data.extractedIssuer as StoredEntity), name: issuerName };
      }
      if (recipientName !== null) {
        update.extractedRecipient = {
          ...(data.extractedRecipient as StoredEntity),
          name: recipientName,
        };
      }

      await fileDoc.ref.update(update);
      console.log(`[backfillFileEntityNames] Decoded entity names on file ${fileDoc.id}`);
      updated++;
    }

    console.log(`[backfillFileEntityNames] Done: updated=${updated}, skipped=${skipped}`);

    return { success: true, updated, skipped };
  }
);
