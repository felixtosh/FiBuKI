/**
 * Partner re-match disagreement report (fork #86, piece 1).
 *
 * Runs the *current* partner matcher over transactions that already carry a
 * partner assignment and reports where its answer differs from what is stored.
 * It writes nothing — no transaction update, no `manualRemovals` entry, no
 * automation history. That is the point: `processPartnerMatchesForTransactions`
 * skips any transaction with a `partnerId`, and the only way to unblock that
 * guard today (`removePartnerFromTransaction`) records the pair as a false
 * positive and permanently vetoes it, so a bulk re-match would blacklist the
 * *correct* stale assignments along with the wrong ones. Until a re-match path
 * exists that does not record a false positive (#86, piece 2), this report is
 * how a human decides selectively.
 *
 * Matcher parity: candidates are filtered through the same `manualRemovals`
 * veto the write path applies, and a global top match is resolved to the local
 * partner the assignment path would localise it into, so a localisation is not
 * reported as a partner change.
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  matchTransaction,
  shouldAutoApply,
  AUTO_APPLY_THRESHOLD,
  MatchResult,
  PartnerData,
  TransactionData,
} from "../utils/partner-matcher";
import {
  loadPartnerMatchingContext,
  PartnerMatchingContext,
} from "./partnerMatchingShared";

const db = getFirestore();

const PAGE_SIZE = 500;
const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 500;
/** Hard ceiling on documents scanned, so the report cannot run unbounded. */
const MAX_SCAN = 20000;
const DEFAULT_MATCHED_BY = ["auto", "ai"];

export type RematchVerdict =
  /** The matcher would now auto-apply a different partner. */
  | "different_partner"
  /** The matcher still ranks candidates, but none reach the auto-apply gate. */
  | "below_threshold"
  /** The matcher finds no candidate at all for this transaction. */
  | "no_candidates"
  /** The stored partner is not in the active partner list — nothing to compare. */
  | "stored_partner_unknown"
  /** The matcher would auto-apply exactly what is stored. */
  | "agrees"
  /**
   * Agrees, but only because the partner is a local copy of a global preset.
   * `GLOBAL_APPROXIMATE_NAME_CAP` applies to `partnerType: "global"` only, and
   * `createLocalPartnerFromGlobal` copies the preset's name and aliases into a
   * user partner, so approximate name evidence against that copy is no longer
   * capped and can reach the gate on its own. Agreement here is weaker evidence
   * than a plain `agrees` and still deserves human eyes.
   */
  | "agrees_via_localized_global_name";

const AGREEING_VERDICTS: ReadonlySet<RematchVerdict> = new Set<RematchVerdict>([
  "agrees",
  "agrees_via_localized_global_name",
]);

export function isDisagreement(verdict: RematchVerdict): boolean {
  return !AGREEING_VERDICTS.has(verdict);
}

export interface StoredAssignment {
  transactionId: string;
  partnerId: string;
  partnerType: string | null;
  confidence: number | null;
  matchedBy: string | null;
}

/** Lookups the classifier needs, derived from the matching context. */
export interface PartnerIndex {
  /** Every active partner the matcher can return, by id. */
  byId: Map<string, { partner: PartnerData; type: "global" | "user" }>;
  /** globalPartnerId -> the local user partner that already localises it. */
  localIdByGlobalId: Map<string, string>;
}

export function buildPartnerIndex(context: PartnerMatchingContext): PartnerIndex {
  const byId = new Map<string, { partner: PartnerData; type: "global" | "user" }>();
  const localIdByGlobalId = new Map<string, string>();

  for (const partner of context.userPartners) {
    byId.set(partner.id, { partner, type: "user" });
    if (partner.globalPartnerId) {
      localIdByGlobalId.set(partner.globalPartnerId, partner.id);
    }
  }
  for (const partner of context.filteredGlobalPartners) {
    byId.set(partner.id, { partner, type: "global" });
  }

  return { byId, localIdByGlobalId };
}

export interface CandidateView {
  /** The id the assignment would store, after global-to-local resolution. */
  partnerId: string;
  /** The id the matcher returned, which is what `partnerSuggestions` records. */
  rawPartnerId: string;
  partnerName: string;
  partnerType: "global" | "user";
  confidence: number;
  source: MatchResult["source"];
  /** True when applying this match would create a new local partner document. */
  wouldCreateLocalPartner: boolean;
}

export interface RematchClassification {
  verdict: RematchVerdict;
  /** Partner id the matcher would store now, or null if it would assign nothing. */
  wouldAssignPartnerId: string | null;
  /** Top-ranked candidate, or null when the matcher returns nothing. */
  topCandidate: CandidateView | null;
  /** All candidates the matcher returns (it caps its own list at 3). */
  candidates: CandidateView[];
}

/**
 * Note on the global-to-local resolution below: `loadPartnerMatchingContext`
 * drops any global preset that already has a local copy from the candidate pool,
 * so today the lookup cannot fire and a returned global is always one the write
 * path would localise fresh. It stays as a guard, because that pool rule lives
 * in a different function and a change there must not silently turn a
 * localisation into a reported partner change.
 */
function toCandidateView(
  match: MatchResult,
  index: PartnerIndex
): CandidateView {
  const localised =
    match.partnerType === "global"
      ? index.localIdByGlobalId.get(match.partnerId)
      : undefined;

  return {
    partnerId: localised ?? match.partnerId,
    rawPartnerId: match.partnerId,
    partnerName: match.partnerName,
    partnerType: match.partnerType,
    confidence: match.confidence,
    source: match.source,
    wouldCreateLocalPartner: match.partnerType === "global" && !localised,
  };
}

/**
 * Compare one stored assignment against the matcher's current answer.
 *
 * Pure — takes the matcher output, returns a verdict. `matches` must already
 * have the `manualRemovals` veto applied, exactly as the write path does.
 */
export function classifyRematch(
  stored: StoredAssignment,
  matches: MatchResult[],
  index: PartnerIndex
): RematchClassification {
  const candidates = matches.map((m) => toCandidateView(m, index));
  const topCandidate = candidates[0] ?? null;

  if (!index.byId.has(stored.partnerId)) {
    return {
      verdict: "stored_partner_unknown",
      wouldAssignPartnerId: null,
      topCandidate,
      candidates,
    };
  }

  if (!topCandidate) {
    return {
      verdict: "no_candidates",
      wouldAssignPartnerId: null,
      topCandidate: null,
      candidates,
    };
  }

  if (!shouldAutoApply(topCandidate.confidence)) {
    return {
      verdict: "below_threshold",
      wouldAssignPartnerId: null,
      topCandidate,
      candidates,
    };
  }

  if (topCandidate.wouldCreateLocalPartner ||
      topCandidate.partnerId !== stored.partnerId) {
    return {
      verdict: "different_partner",
      wouldAssignPartnerId: topCandidate.wouldCreateLocalPartner
        ? null
        : topCandidate.partnerId,
      topCandidate,
      candidates,
    };
  }

  const storedPartner = index.byId.get(stored.partnerId)!;
  const localisedFromGlobal =
    storedPartner.type === "user" && Boolean(storedPartner.partner.globalPartnerId);

  return {
    verdict:
      localisedFromGlobal && topCandidate.source === "name"
        ? "agrees_via_localized_global_name"
        : "agrees",
    wouldAssignPartnerId: topCandidate.partnerId,
    topCandidate,
    candidates,
  };
}

/**
 * Score the stored partner on its own, so a `different_partner` row can still
 * say what the stored answer is worth now. `matchTransaction` caps its result
 * list at 3, so the stored partner is not always in `candidates`.
 */
export function scoreStoredPartner(
  transaction: TransactionData,
  stored: StoredAssignment,
  index: PartnerIndex
): number | null {
  const entry = index.byId.get(stored.partnerId);
  if (!entry) return null;

  const [match] =
    entry.type === "user"
      ? matchTransaction(transaction, [entry.partner], [])
      : matchTransaction(transaction, [], [entry.partner]);

  return match ? match.confidence : null;
}

export interface RematchRow {
  transactionId: string;
  verdict: RematchVerdict;
  date: string | null;
  amount: number | null;
  /** Bank-statement text the matcher reads. */
  transactionName: string;
  transactionPartnerText: string | null;
  storedPartnerId: string;
  storedPartnerName: string | null;
  storedConfidence: number | null;
  storedMatchedBy: string | null;
  /** When the auto-assignment ran, from `automationHistory`; null if not recorded. */
  assignedAt: string | null;
  /** What the stored partner scores under the current matcher, or null. */
  storedPartnerConfidenceNow: number | null;
  wouldAssignPartnerId: string | null;
  topCandidate: CandidateView | null;
  candidates: CandidateView[];
}

export interface PartnerRematchReportOptions {
  /** Only stored assignments at or above this confidence. */
  minConfidence?: number;
  /** Only stored assignments at or below this confidence. */
  maxConfidence?: number;
  /** Only assignments recorded before this instant (ISO 8601). */
  assignedBefore?: string;
  /** Which `partnerMatchedBy` values to consider. Default: auto + ai. */
  matchedBy?: string[];
  /** Cap on returned rows. Counts always cover the whole scanned population. */
  limit?: number;
  /** Include agreeing transactions in `rows` too. Default: disagreements only. */
  includeAgreements?: boolean;
}

export interface PartnerRematchReport {
  /** Nothing was written. Present so a caller cannot mistake this for a fix. */
  readOnly: true;
  autoApplyThreshold: number;
  /** Transactions read. */
  scanned: number;
  /** Transactions carrying a partner assignment. */
  assigned: number;
  /** Assignments that passed the filters and were re-run. */
  evaluated: number;
  /** Verdict counts over every evaluated transaction, not over `rows`. */
  counts: Record<RematchVerdict, number>;
  disagreements: number;
  /** True when `rows` was cut by `limit`; counts above are still complete. */
  truncated: boolean;
  rows: RematchRow[];
  filters: {
    minConfidence: number | null;
    maxConfidence: number | null;
    assignedBefore: string | null;
    matchedBy: string[];
    includeAgreements: boolean;
    limit: number;
  };
  /** Set when the scan hit `MAX_SCAN` — the population is only partly covered. */
  scanLimitReached?: true;
}

function emptyCounts(): Record<RematchVerdict, number> {
  return {
    different_partner: 0,
    below_threshold: 0,
    no_candidates: 0,
    stored_partner_unknown: 0,
    agrees: 0,
    agrees_via_localized_global_name: 0,
  };
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  const ts = value as Timestamp;
  if (typeof ts.toDate === "function") {
    const date = ts.toDate();
    return isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/**
 * When the partner was auto-assigned, read off the last `partner_assigned`
 * entry in `automationHistory`. Null when the history predates that entry —
 * such a transaction is *older* than the recorded ones, never newer, so an
 * `assignedBefore` filter keeps it rather than dropping it silently.
 */
export function readAssignedAt(automationHistory: unknown): string | null {
  if (!Array.isArray(automationHistory)) return null;

  let latest: string | null = null;
  for (const entry of automationHistory) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { type?: unknown; ranAt?: unknown };
    if (candidate.type !== "partner_assigned") continue;
    const ranAt = toIso(candidate.ranAt);
    if (!ranAt) continue;
    if (!latest || ranAt > latest) latest = ranAt;
  }
  return latest;
}

/** Everything the matcher needs, loaded once per run. */
export interface RematchContext {
  partnerContext: PartnerMatchingContext;
  index: PartnerIndex;
}

export async function loadRematchContext(userId: string): Promise<RematchContext> {
  const partnerContext = await loadPartnerMatchingContext(userId);
  return { partnerContext, index: buildPartnerIndex(partnerContext) };
}

export interface AssignmentFilters {
  minConfidence: number | null;
  maxConfidence: number | null;
  assignedBefore: string | null;
  matchedBy: string[];
}

export interface AssignedEvaluation {
  txDoc: FirebaseFirestore.QueryDocumentSnapshot;
  txData: FirebaseFirestore.DocumentData;
  stored: StoredAssignment;
  transaction: TransactionData;
  assignedAt: string | null;
  classification: RematchClassification;
}

export interface AssignedScanSummary {
  /** Transactions read. */
  scanned: number;
  /** Transactions carrying a partner assignment. */
  assigned: number;
  /** Assigned, but `partnerMatchedBy` is not one of the requested values. */
  skippedByMatchedBy: number;
  /** Assigned with no `partnerMatchedBy` at all (legacy rows). Counted, never assumed. */
  assignedWithoutMatchedBy: number;
  /** Passed `matchedBy` but dropped by a confidence or date filter. */
  skippedByFilters: number;
  /** Assignments actually re-run through the matcher. */
  evaluated: number;
  /** True when the scan hit its ceiling — the population is only partly covered. */
  scanLimitReached: boolean;
}

/**
 * Page through the user's transactions, re-run the matcher over every stored
 * assignment that passes `filters`, and hand each result to `visit`.
 *
 * This is the seam the report and the apply path share on purpose: a human acts
 * on the report and then runs the apply, so the two must select and judge the
 * same population. Two copies of this loop would drift, and the drift would only
 * show up as a surprise write.
 */
export async function evaluateAssignedTransactions(
  userId: string,
  filters: AssignmentFilters,
  context: RematchContext,
  visit: (evaluation: AssignedEvaluation) => void | Promise<void>
): Promise<AssignedScanSummary> {
  const { partnerContext, index } = context;
  const matchedByFilter = new Set(filters.matchedBy);

  const summary: AssignedScanSummary = {
    scanned: 0,
    assigned: 0,
    skippedByMatchedBy: 0,
    assignedWithoutMatchedBy: 0,
    skippedByFilters: 0,
    evaluated: 0,
    scanLimitReached: false,
  };

  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  for (;;) {
    let query = db
      .collection("transactions")
      .where("userId", "==", userId)
      .orderBy("__name__")
      .limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);

    const snapshot = await query.get();
    if (snapshot.empty) break;

    for (const txDoc of snapshot.docs) {
      summary.scanned++;
      const txData = txDoc.data();
      const storedPartnerId = txData.partnerId;
      if (!storedPartnerId || typeof storedPartnerId !== "string") continue;
      summary.assigned++;

      const storedMatchedBy =
        typeof txData.partnerMatchedBy === "string" ? txData.partnerMatchedBy : null;
      if (!storedMatchedBy) summary.assignedWithoutMatchedBy++;
      if (!storedMatchedBy || !matchedByFilter.has(storedMatchedBy)) {
        summary.skippedByMatchedBy++;
        continue;
      }

      const storedConfidence =
        typeof txData.partnerMatchConfidence === "number"
          ? txData.partnerMatchConfidence
          : null;
      if (filters.minConfidence !== null &&
          (storedConfidence === null || storedConfidence < filters.minConfidence)) {
        summary.skippedByFilters++;
        continue;
      }
      if (filters.maxConfidence !== null &&
          (storedConfidence === null || storedConfidence > filters.maxConfidence)) {
        summary.skippedByFilters++;
        continue;
      }

      const assignedAt = readAssignedAt(txData.automationHistory);
      if (filters.assignedBefore !== null &&
          assignedAt !== null &&
          assignedAt >= filters.assignedBefore) {
        summary.skippedByFilters++;
        continue;
      }

      const stored: StoredAssignment = {
        transactionId: txDoc.id,
        partnerId: storedPartnerId,
        partnerType:
          typeof txData.partnerType === "string" ? txData.partnerType : null,
        confidence: storedConfidence,
        matchedBy: storedMatchedBy,
      };

      const transaction: TransactionData = {
        id: txDoc.id,
        partner: txData.partner || null,
        partnerIban: txData.partnerIban || null,
        name: txData.name || "",
        reference: txData.reference || null,
      };

      // Same veto the write path applies, so neither the report nor the apply
      // can claim a match the matcher would refuse to make.
      const matches = matchTransaction(
        transaction,
        partnerContext.userPartners,
        partnerContext.filteredGlobalPartners
      ).filter((m) => {
        const removals = partnerContext.partnerManualRemovals.get(m.partnerId);
        return !(removals && removals.has(txDoc.id));
      });

      summary.evaluated++;
      await visit({
        txDoc,
        txData,
        stored,
        transaction,
        assignedAt,
        classification: classifyRematch(stored, matches, index),
      });
    }

    if (snapshot.size < PAGE_SIZE) break;
    if (summary.scanned >= MAX_SCAN) {
      summary.scanLimitReached = true;
      break;
    }
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }

  return summary;
}

/** Row view of one evaluation, shared by the report and the apply preview. */
export function toRematchRow(
  evaluation: AssignedEvaluation,
  context: RematchContext
): RematchRow {
  const { txDoc, txData, stored, transaction, assignedAt, classification } = evaluation;

  return {
    transactionId: txDoc.id,
    verdict: classification.verdict,
    date: toIso(txData.date)?.slice(0, 10) ?? null,
    amount: typeof txData.amount === "number" ? txData.amount : null,
    transactionName: transaction.name,
    transactionPartnerText: transaction.partner,
    storedPartnerId: stored.partnerId,
    storedPartnerName:
      context.partnerContext.partnerNameMap.get(stored.partnerId) ?? null,
    storedConfidence: stored.confidence,
    storedMatchedBy: stored.matchedBy,
    assignedAt,
    storedPartnerConfidenceNow: scoreStoredPartner(transaction, stored, context.index),
    wouldAssignPartnerId: classification.wouldAssignPartnerId,
    topCandidate: classification.topCandidate,
    candidates: classification.candidates,
  };
}

export async function buildPartnerRematchReport(
  userId: string,
  options: PartnerRematchReportOptions = {}
): Promise<PartnerRematchReport> {
  const matchedBy =
    options.matchedBy && options.matchedBy.length > 0
      ? options.matchedBy
      : DEFAULT_MATCHED_BY;
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_ROW_LIMIT),
    MAX_ROW_LIMIT
  );
  const filters: AssignmentFilters = {
    minConfidence: options.minConfidence ?? null,
    maxConfidence: options.maxConfidence ?? null,
    assignedBefore: options.assignedBefore ?? null,
    matchedBy,
  };
  const includeAgreements = options.includeAgreements ?? false;

  const context = await loadRematchContext(userId);

  const counts = emptyCounts();
  const rows: RematchRow[] = [];
  let disagreements = 0;
  let truncated = false;

  const summary = await evaluateAssignedTransactions(
    userId,
    filters,
    context,
    (evaluation) => {
      counts[evaluation.classification.verdict]++;

      const disagrees = isDisagreement(evaluation.classification.verdict);
      if (disagrees) disagreements++;
      if (!disagrees && !includeAgreements) return;

      if (rows.length >= limit) {
        truncated = true;
        return;
      }
      rows.push(toRematchRow(evaluation, context));
    }
  );

  return {
    readOnly: true,
    autoApplyThreshold: AUTO_APPLY_THRESHOLD,
    scanned: summary.scanned,
    assigned: summary.assigned,
    evaluated: summary.evaluated,
    counts,
    disagreements,
    truncated,
    rows,
    filters: {
      minConfidence: filters.minConfidence,
      maxConfidence: filters.maxConfidence,
      assignedBefore: filters.assignedBefore,
      matchedBy,
      includeAgreements,
      limit,
    },
    ...(summary.scanLimitReached ? { scanLimitReached: true as const } : {}),
  };
}
