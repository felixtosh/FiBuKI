/**
 * Re-match the caller's unassigned Transactions when what they match against
 * changed since the last run: the Global Partner directory version
 * (partnerCatalogVersion.ts) or the user's own learned patterns
 * (patternSignal.ts).
 *
 * Called in the background when the Transactions page opens. Cheap when there
 * is nothing to do: one read of the catalog version and one of the user's
 * stamp. Otherwise the same rule-based matching the matchPartners callable
 * runs, over the unassigned Transactions only, with the agentic fallback off,
 * so a directory change never costs model calls.
 *
 * The run is claimed BEFORE it starts, with an atomic create() of a claim
 * document named after exactly what it catches up to, so two tabs opening at
 * once start it once, and the claims double as a record of past runs. A run
 * that fails after claiming
 * is not retried until something changes again; every Transaction is still
 * matched on open, as before.
 */

import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { createCallable } from "../utils/createCallable";
import { runPartnerMatching, type MatchPartnersResponse } from "./matchPartners";
import { PARTNER_CATALOG_DOC } from "./partnerCatalogVersion";
import { patternSignal } from "./patternSignal";

type CatchUpResponse = { skipped: true; version: number } | ({ skipped: false; version: number } & MatchPartnersResponse);

export const catchUpPartnerMatchingCallable = createCallable<Record<string, never> | null, CatchUpResponse>(
  { name: "catchUpPartnerMatching" },
  async (ctx) => {
    const db = getFirestore();
    const [catalog, partners] = await Promise.all([
      db.doc(PARTNER_CATALOG_DOC).get(),
      db.collection("partners").where("userId", "==", ctx.userId).get(),
    ]);
    const version = Number(catalog.data()?.version ?? 0);
    const signal = patternSignal(partners.docs.map((d) => d.data()));
    // Server-only (users/{uid}/system is denied on the client data plane), so a
    // client cannot mark itself caught up or force a run.
    const stampRef = db.doc(`users/${ctx.userId}/system/partnerMatching`);

    const stamp = await stampRef.get();
    const seen = stamp.exists ? stamp.data()! : null;
    if (seen && Number(seen.catalogVersion ?? -1) >= version && seen.patternSignal === signal) {
      return { skipped: true, version };
    }
    let claimed = true;
    try {
      await db.doc(`users/${ctx.userId}/system/partnerMatchingClaim-${version}-${signal}`).create({
        claimedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      if ((err as { code?: unknown })?.code !== 6) throw err;
      claimed = false; // another tab already started this exact catch-up
    }
    if (claimed) {
      await stampRef.set(
        { catalogVersion: version, patternSignal: signal, claimedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
    }
    if (!claimed) return { skipped: true, version };

    const result = await runPartnerMatching(ctx.userId, { matchAll: false, agenticFallback: false });
    return { skipped: false, version, ...result };
  },
);
