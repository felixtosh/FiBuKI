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
 * It also decodes the flat `extractedPartner` (#300) — the counterparty name the
 * detail panel shows. #233 decoded the Partner records, so until this ran a
 * File and the Partner it points at disagreed on the name.
 *
 * Idempotent — a record whose entity names already decode to themselves is
 * skipped, and a name with no character reference in it (including one holding
 * a bare "&") comes back byte-identical, so it is skipped too.
 *
 * Scope is the stored entity shape. `invoiceDirection` and the § 11
 * classification derived from it are re-derived by the `onUserDataUpdate`
 * sweep, which runs on the next identity edit, and by re-extraction — this
 * pass deliberately does not duplicate that derivation.
 *
 * What it writes is the File facts module's decision (#640,
 * `fileFacts/entityNames.ts`), through the one applier. It is a one-off: once
 * every deployment's call log (`functionCalls`, functionName
 * "backfillFileEntityNames") shows a successful run per user, it can go.
 */

import { createCallable } from "../utils/createCallable";
import { applyFactChange } from "../fileFacts/applyFactChange";
import { decodedEntityNameFields } from "../fileFacts/entityNames";

interface BackfillFileEntityNamesRequest {
  // empty — operates on all files for the calling user
}

interface BackfillFileEntityNamesResponse {
  success: boolean;
  updated: number;
  skipped: number;
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
      // Asked of the module up front, so a File with nothing to decode costs
      // no second read; the applier asks again on the File as it is now.
      if (Object.keys(decodedEntityNameFields(fileDoc.data())).length === 0) {
        skipped++;
        continue;
      }

      const outcome = await applyFactChange(ctx.db, {
        fileId: fileDoc.id,
        userId: ctx.userId,
        change: { origin: "entity-name-backfill" },
      });
      if (outcome.refused || Object.keys(outcome.update).length === 0) {
        skipped++;
        continue;
      }

      console.log(`[backfillFileEntityNames] Decoded entity names on file ${fileDoc.id}`);
      updated++;
    }

    console.log(`[backfillFileEntityNames] Done: updated=${updated}, skipped=${skipped}`);

    return { success: true, updated, skipped };
  }
);
