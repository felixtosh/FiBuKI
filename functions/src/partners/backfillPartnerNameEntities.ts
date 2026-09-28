/**
 * Backfill Partner Name Entities (#233)
 *
 * One-time callable that decodes HTML character references (e.g. "&amp;")
 * left in Partner names and aliases by extraction before the fix in
 * extractionCore.ts started decoding on the way in. Idempotent: a Partner
 * whose name and aliases already decode to themselves is skipped, and so is
 * one this backfill already rewrote (#266, see partnerNameEntities.ts).
 *
 * The self-host store is backfilled by
 * selfhost/migrate-decode-partner-name-entities.ts, which shares the plan.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable } from "../utils/createCallable";
import { PARTNER_NAME_DECODED_MARKER, planPartnerNameDecode } from "./partnerNameEntities";

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
      const plan = planPartnerNameDecode(partnerDoc.data());

      if (!plan) {
        skipped++;
        continue;
      }

      const update: Record<string, unknown> = {
        [PARTNER_NAME_DECODED_MARKER]: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (plan.name !== undefined) update.name = plan.name;
      if (plan.aliases !== undefined) update.aliases = plan.aliases;

      await partnerDoc.ref.update(update);
      console.log(`[backfillPartnerNameEntities] Decoded entities on partner ${partnerDoc.id}`);
      updated++;
    }

    console.log(`[backfillPartnerNameEntities] Done: updated=${updated}, skipped=${skipped}`);

    return { success: true, updated, skipped };
  }
);
