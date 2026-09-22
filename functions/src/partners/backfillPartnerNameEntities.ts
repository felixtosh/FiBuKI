/**
 * Backfill Partner Name Entities (#233)
 *
 * One-time callable that decodes HTML character references (e.g. "&amp;")
 * left in Partner names and aliases by extraction before the fix in
 * extractionCore.ts started decoding on the way in. Idempotent — a Partner
 * whose name and aliases already decode to themselves is skipped.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable } from "../utils/createCallable";
import { decodeHtmlEntities } from "../utils/htmlEntities";

interface BackfillPartnerNameEntitiesRequest {
  // empty — operates on all partners for the calling user
}

interface BackfillPartnerNameEntitiesResponse {
  success: boolean;
  updated: number;
  skipped: number;
}

export const backfillPartnerNameEntitiesCallable = createCallable<
  BackfillPartnerNameEntitiesRequest,
  BackfillPartnerNameEntitiesResponse
>(
  { name: "backfillPartnerNameEntities" },
  async (ctx) => {
    const partnersSnap = await ctx.db
      .collection("partners")
      .where("userId", "==", ctx.userId)
      .get();

    let updated = 0;
    let skipped = 0;

    for (const partnerDoc of partnersSnap.docs) {
      const data = partnerDoc.data();

      const name: string | undefined = data.name;
      const aliases: string[] = Array.isArray(data.aliases) ? data.aliases : [];

      const decodedName = name ? decodeHtmlEntities(name) : null;
      const decodedAliases = aliases.map((alias) => decodeHtmlEntities(alias) ?? alias);

      const nameChanged = !!name && decodedName !== name;
      const aliasesChanged = decodedAliases.some((alias, i) => alias !== aliases[i]);

      if (!nameChanged && !aliasesChanged) {
        skipped++;
        continue;
      }

      const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
      if (nameChanged) update.name = decodedName;
      if (aliasesChanged) update.aliases = decodedAliases;

      await partnerDoc.ref.update(update);
      console.log(`[backfillPartnerNameEntities] Decoded entities on partner ${partnerDoc.id}`);
      updated++;
    }

    console.log(`[backfillPartnerNameEntities] Done: updated=${updated}, skipped=${skipped}`);

    return { success: true, updated, skipped };
  }
);
