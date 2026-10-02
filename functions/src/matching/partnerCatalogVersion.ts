/**
 * A version number for the Global Partner directory, raised whenever a change
 * could alter what a Transaction matches.
 *
 * Partner suggestions are computed at moments (an import, a user Partner
 * created or changed, a transaction opened) and stored on the Transaction. A
 * Global Partner added or corrected later (a new alias, a fixed name) reached
 * no existing Transaction until someone opened it, so the list showed "no
 * partner" for rows the directory could now match, and opening one rewrote
 * it. catchUpPartnerMatching compares this version with the one a user last
 * matched against and re-matches that user's unassigned Transactions once.
 *
 * One small write per relevant directory change, however many users there
 * are; the per-user work happens lazily, only for users who come back.
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export const PARTNER_CATALOG_DOC = "config/partnerCatalog";

/** The Global Partner fields the matcher reads. Usage counters and the like are not among them. */
const MATCH_FIELDS = ["name", "aliases", "patterns", "ibans", "vatId", "website", "isActive"] as const;

export function changesMatching(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): boolean {
  if (!before || !after) return true; // created or deleted
  return MATCH_FIELDS.some((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null));
}

export const onGlobalPartnerWritten = onDocumentWritten(
  { document: "globalPartners/{partnerId}", region: "europe-west1" },
  async (event) => {
    const before = event.data?.before?.data() as Record<string, unknown> | undefined;
    const after = event.data?.after?.data() as Record<string, unknown> | undefined;
    if (!changesMatching(before, after)) return;
    await getFirestore()
      .doc(PARTNER_CATALOG_DOC)
      .set({ version: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  },
);
