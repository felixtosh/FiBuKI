/**
 * Cloud Function: prepare the UVA filing for a period, and keep it (#85).
 *
 * `calculateUva` answers "what are the figures" and `uva/filing.ts` turns a run
 * into the record a Steuerberater signs. Neither survives the call: a filing
 * built and thrown away cannot be compared against the next one, and an
 * exception nobody kept is an exception rediscovered next quarter — which is
 * the failure this ticket exists to stop.
 *
 * So this callable does three things a pure module cannot:
 *
 *  1. Derives the period from the corpus, through the same run the figures
 *     come from (uvaPeriodRun), and builds the filing off it.
 *  2. Keeps a BASELINE per period and reconciles every later run against it on
 *     derivation source. The D6 sweep improved 131 files and weakened 29; the
 *     only reason that was knowable is that a run from before it was kept. A
 *     baseline that predates this record — the pre-sweep run — can be supplied
 *     on the request; otherwise the first preparation of a period becomes it.
 *  3. Records the handover a human performed. There is no state here that means
 *     submitted: FinanzOnline submission is the separate, user-triggered
 *     submitUvaToFinanzOnline callable, and a filing prepared here must not be
 *     able to claim it happened.
 *
 * The handover is stored against the totals it covered, so a re-run that moves
 * the figures cannot leave a record saying Stefan received THIS filing when he
 * received a different one.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { runUvaForPeriod, assertValidPeriod } from "./uvaPeriodRun";
import {
  buildUvaFiling,
  type UvaFiling,
  type UvaFilingHandover,
  type UvaOpenItem,
} from "../uva/filing";
import {
  periodKeyOf,
  reconcileDerivations,
  snapshotDerivations,
  type UvaDerivationSnapshot,
} from "../uva/reconcile";
import type { UvaPeriod } from "../uva/types";

/** Where the run this filing was measured against came from. */
export type BaselineOrigin =
  /** No baseline existed; this run became it, so there is nothing to compare. */
  | "established"
  /** Kept from an earlier preparation of the same period. */
  | "stored"
  /** Supplied on the request — a run that predates this record. */
  | "supplied";

interface PrepareUvaFilingRequest {
  period: UvaPeriod;
  /**
   * Declared open items. Omitted keeps the stored set; an empty array clears
   * it. Nothing in the corpus can know that a POS receipt's 10/20 split has to
   * be read off paper, so these are declared rather than derived.
   */
  openItems?: UvaOpenItem[];
  /** A baseline that predates this record — the pre-sweep run. Replaces the stored one. */
  baseline?: UvaDerivationSnapshot;
  /** Record a handover a human performed. Never set by the server. */
  handover?: UvaFilingHandover;
}

interface PrepareUvaFilingResponse {
  success: boolean;
  filing: UvaFiling;
  baseline: {
    origin: BaselineOrigin;
    /** Null when this run established it — a self-diff is not a comparison. */
    periodKey: string | null;
  };
}

/** One filing record per user per period. */
const COLLECTION = "uvaFilings";

interface StoredFiling {
  userId: string;
  periodKey: string;
  period: UvaPeriod;
  baseline: UvaDerivationSnapshot | null;
  baselineOrigin: BaselineOrigin;
  /** The run the last preparation produced. */
  latest: UvaDerivationSnapshot;
  openItems: UvaOpenItem[];
  handover: UvaFilingHandover;
  /** The totals the recorded handover covered — see the module note. */
  handoverCovers: HandoverCoverage | null;
  blockerCodes: string[];
}

interface HandoverCoverage {
  totalInputVat: number;
  totalOutputVat: number;
  balance: number;
}

export const prepareUvaFilingCallable = createCallable<
  PrepareUvaFilingRequest,
  PrepareUvaFilingResponse
>(
  { name: "prepareUvaFiling", memory: "512MiB", timeoutSeconds: 120 },
  async (ctx, request) => {
    const period = request?.period;
    assertValidPeriod(period);
    const periodKey = periodKeyOf(period);

    const openItemsRequested = request.openItems
      ? request.openItems.map(validateOpenItem)
      : null;
    const handoverRequested = request.handover
      ? validateHandover(request.handover)
      : null;
    const suppliedBaseline = request.baseline
      ? validateSnapshot(request.baseline, periodKey)
      : null;

    const docRef = ctx.db
      .collection(COLLECTION)
      .doc(`${ctx.userId}_${periodKey}`);
    const existingDoc = await docRef.get();
    const existing = existingDoc.exists
      ? (existingDoc.data() as StoredFiling)
      : null;

    const { result } = await runUvaForPeriod(ctx.db, ctx.userId, period);
    const latest = snapshotDerivations(result);

    // A run only compares against something that came from somewhere else. When
    // no baseline exists, this run becomes it and the filing carries no
    // reconciliation — a self-diff showing no movement would read as "compared
    // and clean" while nothing was compared at all.
    const baseline = suppliedBaseline ?? existing?.baseline ?? null;
    const origin: BaselineOrigin = suppliedBaseline
      ? "supplied"
      : baseline
        ? "stored"
        : "established";
    const reconciliation = baseline
      ? reconcileDerivations(baseline, latest)
      : null;

    const openItems = openItemsRequested ?? existing?.openItems ?? [];
    const handover = handoverRequested ??
      existing?.handover ?? { state: "prepared" as const };
    // A handover recorded on this call covers the run it was recorded against;
    // one carried over from an earlier call covers whatever it covered then.
    const handoverCovers: HandoverCoverage | null = handoverRequested
      ? coverageOf(result)
      : (existing?.handoverCovers ?? null);

    const filing = buildUvaFiling({
      report: result,
      openItems,
      reconciliation,
      handover,
      handoverCovers,
    });

    if (handoverRequested && filing.blockers.length > 0) {
      // A blocker is a defect in the filing, not a warning: undocumented
      // Vorsteuer, a trace that does not add up, an unexplained deferral. None
      // of those should reach a Steuerberater as though it were signed off.
      throw new HttpsError(
        "failed-precondition",
        `Filing ${periodKey} has ${filing.blockers.length} blocker(s): ` +
          filing.blockers.map((b) => b.code).join(", ")
      );
    }

    const stored: StoredFiling & { updatedAt: FieldValue } = {
      userId: ctx.userId,
      periodKey,
      period,
      baseline: baseline ?? latest,
      baselineOrigin: origin,
      latest,
      openItems,
      handover,
      handoverCovers,
      blockerCodes: filing.blockers.map((b) => b.code),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await docRef.set(stored, { merge: true });

    return {
      success: true,
      filing,
      baseline: {
        origin,
        periodKey: baseline ? baseline.periodKey : null,
      },
    };
  }
);

function coverageOf(result: {
  totalInputVat: number;
  totalOutputVat: number;
  balance: number;
}): HandoverCoverage {
  return {
    totalInputVat: result.totalInputVat,
    totalOutputVat: result.totalOutputVat,
    balance: result.balance,
  };
}

/**
 * An open item with no rationale is a blocker rather than a rejection — the
 * filing states it and refuses to go out. What is rejected here is a shape a
 * rule cannot read at all.
 */
function validateOpenItem(item: UvaOpenItem, i: number): UvaOpenItem {
  const where = `openItems[${i}]`;
  if (!item || typeof item !== "object") {
    throw new HttpsError("invalid-argument", `${where} is not an open item`);
  }
  if (typeof item.ref !== "string" || !item.ref.trim()) {
    throw new HttpsError("invalid-argument", `${where}.ref is required`);
  }
  if (item.disposition !== "resolved" && item.disposition !== "deferred") {
    throw new HttpsError(
      "invalid-argument",
      `${where}.disposition must be "resolved" or "deferred"`
    );
  }
  const effect = item.effect;
  if (
    !effect ||
    !Number.isFinite(effect.inputVat) ||
    !Number.isFinite(effect.outputVat)
  ) {
    throw new HttpsError(
      "invalid-argument",
      `${where}.effect must state what acting on it moves, in cents`
    );
  }
  return {
    ref: item.ref,
    summary: typeof item.summary === "string" ? item.summary : "",
    disposition: item.disposition,
    rationale: typeof item.rationale === "string" ? item.rationale : "",
    effect: { inputVat: effect.inputVat, outputVat: effect.outputVat },
  };
}

function validateHandover(handover: UvaFilingHandover): UvaFilingHandover {
  if (handover?.state === "prepared") return { state: "prepared" };
  if (handover?.state !== "handed-over") {
    // Deliberately narrow: the only two states that exist are prepared and
    // handed-over, and no caller gets to invent a third that means submitted.
    throw new HttpsError(
      "invalid-argument",
      'handover.state must be "prepared" or "handed-over"'
    );
  }
  for (const field of ["to", "at", "via"] as const) {
    if (typeof handover[field] !== "string" || !handover[field].trim()) {
      throw new HttpsError(
        "invalid-argument",
        `handover.${field} is required to record a handover`
      );
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(handover.at)) {
    throw new HttpsError("invalid-argument", "handover.at must be YYYY-MM-DD");
  }
  return {
    state: "handed-over",
    to: handover.to,
    at: handover.at,
    via: handover.via,
  };
}

function validateSnapshot(
  snapshot: UvaDerivationSnapshot,
  periodKey: string
): UvaDerivationSnapshot {
  if (!snapshot || !Array.isArray(snapshot.entries)) {
    throw new HttpsError("invalid-argument", "baseline.entries is required");
  }
  if (snapshot.periodKey !== periodKey) {
    // Reconciling across periods produces movements for every transaction on
    // either side and a delta that means nothing.
    throw new HttpsError(
      "invalid-argument",
      `baseline is for ${snapshot.periodKey}, not ${periodKey}`
    );
  }
  for (const field of ["totalInputVat", "totalOutputVat", "balance"] as const) {
    if (!Number.isFinite(snapshot[field])) {
      throw new HttpsError("invalid-argument", `baseline.${field} is required`);
    }
  }
  return snapshot;
}
