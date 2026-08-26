/**
 * Whole-account partner re-match (fork #86, piece 2).
 *
 * Re-runs the current matcher over transactions that already carry an
 * auto-assigned partner and writes the corrected answer, **without recording a
 * false positive**. That is the whole reason this exists rather than a loop over
 * `removePartnerFromTransaction`: that path adds the pair to the partner's
 * `manualRemovals`, which `partnerMatchingShared` then vetoes forever, so a bulk
 * remove-and-rerun would permanently blacklist every correct stale assignment
 * along with the wrong ones. The veto is right for a human saying "no, not that
 * partner" and wrong for a mechanical re-match, so this path never writes one.
 *
 * Scope is the whole account by design — the same machinery is wanted intact
 * after any future matcher change, and selection happens in the read-only report
 * (`partner_rematch_report`), not in this op's filters.
 *
 * Three things it deliberately does not do:
 *  - it does not touch `manual`, `suggestion` or `ai` assignments. Those are
 *    human or agentic judgements, and they are also the positive training data
 *    for `learnPartnerPatterns`, so clearing them would quietly degrade the
 *    learned patterns. `auto` is neither.
 *  - it does not trigger pattern relearning. Relearning is driven by manual
 *    assignments, and this op changes none.
 *  - it does not queue agentic partner search for what it clears. A sweep over
 *    hundreds of transactions would spend the AI budget on work nobody asked
 *    for; the transaction lands back on the normal suggestion path instead.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createLocalPartnerFromGlobal } from "./createLocalPartnerFromGlobal";
import {
  applyPartnerMatchUpdates,
  PartnerMatchWriteOperation,
} from "./partnerMatchingShared";
import {
  AssignedEvaluation,
  AssignedScanSummary,
  AssignmentFilters,
  CandidateView,
  RematchRow,
  RematchVerdict,
  evaluateAssignedTransactions,
  loadRematchContext,
  toRematchRow,
} from "./partnerRematchReport";
import { AUTO_APPLY_THRESHOLD } from "../utils/partner-matcher";

/**
 * The only assignment kind this op may rewrite. Anything else is a judgement it
 * has no standing to overturn — see the module comment.
 */
const REMATCHABLE_MATCHED_BY = "auto";

const DEFAULT_MAX_WRITES = 1000;
const DEFAULT_ROW_LIMIT = 100;
const MAX_ROW_LIMIT = 1000;

export type RematchAction =
  /** The matcher would auto-apply a different partner; overwrite the assignment. */
  | "reassign"
  /** The matcher no longer reproduces this assignment; clear the partner fields. */
  | "clear"
  /** The matcher agrees; leave it alone. */
  | "keep"
  /** The stored partner is not in the active list — reported, never touched. */
  | "skip_stored_partner_unknown"
  /** Would be cleared, but `clearUnconfirmed` is off. */
  | "skip_clear_disabled";

export interface RematchPlanRow extends RematchRow {
  action: RematchAction;
  /**
   * Partner the transaction ends up with. Null for a clear, and null for a
   * reassign to a global preset with no local copy yet — that partner document
   * does not exist until the op creates it.
   */
  targetPartnerId: string | null;
  /** True when applying this row creates a local copy of a global preset. */
  createsLocalPartner: boolean;
}

export interface RematchAssignedPartnersOptions {
  /**
   * Default **true**. Nothing is written unless the caller passes false — a
   * whole-account rewrite is not something to trip into.
   */
  dryRun?: boolean;
  /**
   * Clear assignments the matcher no longer reproduces. Default **false**.
   * Failing to reproduce an assignment is not evidence that it is wrong, and
   * clearing dwarfs the corrections: on this account it turns 18 provable
   * reassignments into 159 writes.
   */
  clearUnconfirmed?: boolean;
  minConfidence?: number;
  maxConfidence?: number;
  assignedBefore?: string;
  /** Refuse to apply if the plan exceeds this many writes. Default 1000. */
  maxWrites?: number;
  /** Cap on returned rows. Counts always cover the whole plan. */
  limit?: number;
  /** Include `keep` rows in the returned list. Default false. */
  includeKept?: boolean;
}

export interface RematchAssignedPartnersResult {
  dryRun: boolean;
  /** True only when writes actually happened. */
  applied: boolean;
  autoApplyThreshold: number;
  scan: AssignedScanSummary;
  verdicts: Record<RematchVerdict, number>;
  actions: Record<RematchAction, number>;
  /** Transactions written. Zero on a dry run. */
  transactionsWritten: number;
  /** Local partner documents created from global presets. Zero on a dry run. */
  localPartnersCreated: number;
  /** Reassigns planned but skipped because the preset could not be localised. */
  localisationFailures?: number;
  /** True when `rows` was cut by `limit`; the counts above are still complete. */
  truncated: boolean;
  rows: RematchPlanRow[];
  filters: {
    matchedBy: string[];
    minConfidence: number | null;
    maxConfidence: number | null;
    assignedBefore: string | null;
    clearUnconfirmed: boolean;
    maxWrites: number;
    limit: number;
  };
  /** Set when the scan hit its ceiling — the population is only partly covered. */
  scanLimitReached?: true;
}

function emptyVerdicts(): Record<RematchVerdict, number> {
  return {
    different_partner: 0,
    below_threshold: 0,
    no_candidates: 0,
    stored_partner_unknown: 0,
    agrees: 0,
    agrees_via_localized_global_name: 0,
  };
}

function emptyActions(): Record<RematchAction, number> {
  return {
    reassign: 0,
    clear: 0,
    keep: 0,
    skip_stored_partner_unknown: 0,
    skip_clear_disabled: 0,
  };
}

export function decideAction(
  verdict: RematchVerdict,
  clearUnconfirmed: boolean
): RematchAction {
  switch (verdict) {
    case "different_partner":
      return "reassign";
    case "below_threshold":
    case "no_candidates":
      return clearUnconfirmed ? "clear" : "skip_clear_disabled";
    case "stored_partner_unknown":
      // The stored partner is inactive or deleted, so there is nothing to
      // compare against and no way to tell a bug-minted assignment from a
      // deliberate archive. Out of scope for #86: report it, do not touch it.
      return "skip_stored_partner_unknown";
    case "agrees":
    case "agrees_via_localized_global_name":
      // Agreement carried by a localised preset is surfaced by the report for
      // human eyes, but it *is* what the current matcher produces, so the
      // machine has no better answer to write.
      return "keep";
  }
}

interface PlannedWrite {
  evaluation: AssignedEvaluation;
  action: Extract<RematchAction, "reassign" | "clear">;
}

/**
 * `partnerSuggestions` in the shape the write path stores — raw matcher ids, not
 * the resolved ones. Refreshed on every write this op makes: the stored list was
 * produced by the same matcher run that produced the assignment being corrected,
 * so leaving it would hand the UI the old answer as a suggestion. An empty list
 * is written when the matcher now finds nothing, which is the honest state.
 */
function buildSuggestions(candidates: CandidateView[]) {
  return candidates.map((c) => ({
    partnerId: c.rawPartnerId,
    partnerType: c.partnerType,
    confidence: c.confidence,
    source: c.source,
  }));
}

function buildClearUpdates(
  previousPartnerId: string,
  previousPartnerName: string | null,
  candidates: CandidateView[]
): Record<string, unknown> {
  return {
    partnerId: null,
    partnerType: null,
    partnerMatchedBy: null,
    partnerMatchConfidence: null,
    partnerSuggestions: buildSuggestions(candidates),
    updatedAt: FieldValue.serverTimestamp(),
    automationHistory: FieldValue.arrayUnion({
      type: "partner_removed",
      ranAt: Timestamp.now(),
      status: "completed",
      actor: "auto",
      // The existing cascade-unassign writes "decision" here, but a machine
      // removal is not a user decision, and a sweep of this size would bury a
      // decision-filtered activity feed under hundreds of entries.
      level: "outcome",
      forPartnerId: previousPartnerId,
      partnerName: previousPartnerName,
      summary: `Partner "${previousPartnerName || previousPartnerId}" removed — the corrected matcher no longer reproduces this assignment`,
    }),
  };
}

function buildReassignUpdates(
  previousPartnerId: string,
  previousPartnerName: string | null,
  nextPartnerId: string,
  nextPartnerName: string | null,
  confidence: number,
  candidates: CandidateView[]
): Record<string, unknown> {
  return {
    partnerId: nextPartnerId,
    partnerType: "user",
    partnerMatchedBy: "auto",
    partnerMatchConfidence: confidence,
    partnerSuggestions: buildSuggestions(candidates),
    updatedAt: FieldValue.serverTimestamp(),
    automationHistory: FieldValue.arrayUnion(
      {
        type: "partner_removed",
        ranAt: Timestamp.now(),
        status: "completed",
        actor: "auto",
        level: "outcome",
        forPartnerId: previousPartnerId,
        partnerName: previousPartnerName,
        summary: `Partner "${previousPartnerName || previousPartnerId}" replaced by the corrected matcher`,
      },
      {
        type: "partner_assigned",
        ranAt: Timestamp.now(),
        status: "completed",
        actor: "auto",
        level: "outcome",
        forPartnerId: nextPartnerId,
        partnerName: nextPartnerName,
        confidence,
        summary: `Partner "${nextPartnerName || nextPartnerId}" re-assigned by the corrected matcher`,
      }
    ),
  };
}

export async function rematchAssignedPartners(
  userId: string,
  options: RematchAssignedPartnersOptions = {}
): Promise<RematchAssignedPartnersResult> {
  const dryRun = options.dryRun !== false;
  const clearUnconfirmed = options.clearUnconfirmed === true;
  const maxWrites = Math.max(1, options.maxWrites ?? DEFAULT_MAX_WRITES);
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_ROW_LIMIT),
    MAX_ROW_LIMIT
  );
  const includeKept = options.includeKept === true;

  const filters: AssignmentFilters = {
    minConfidence: options.minConfidence ?? null,
    maxConfidence: options.maxConfidence ?? null,
    assignedBefore: options.assignedBefore ?? null,
    matchedBy: [REMATCHABLE_MATCHED_BY],
  };

  const context = await loadRematchContext(userId);

  const verdicts = emptyVerdicts();
  const actions = emptyActions();
  const rows: RematchPlanRow[] = [];
  const planned: PlannedWrite[] = [];
  let truncated = false;

  const scan = await evaluateAssignedTransactions(
    userId,
    filters,
    context,
    (evaluation) => {
      const verdict = evaluation.classification.verdict;
      verdicts[verdict]++;

      const action = decideAction(verdict, clearUnconfirmed);
      actions[action]++;

      if (action === "reassign" || action === "clear") {
        planned.push({ evaluation, action });
      }

      if (action === "keep" && !includeKept) return;
      if (rows.length >= limit) {
        truncated = true;
        return;
      }

      const top = evaluation.classification.topCandidate;
      rows.push({
        ...toRematchRow(evaluation, context),
        action,
        targetPartnerId:
          action === "reassign" ? evaluation.classification.wouldAssignPartnerId : null,
        createsLocalPartner: action === "reassign" && Boolean(top?.wouldCreateLocalPartner),
      });
    }
  );

  const base: RematchAssignedPartnersResult = {
    dryRun,
    applied: false,
    autoApplyThreshold: AUTO_APPLY_THRESHOLD,
    scan,
    verdicts,
    actions,
    transactionsWritten: 0,
    localPartnersCreated: 0,
    truncated,
    rows,
    filters: {
      matchedBy: filters.matchedBy,
      minConfidence: filters.minConfidence,
      maxConfidence: filters.maxConfidence,
      assignedBefore: filters.assignedBefore,
      clearUnconfirmed,
      maxWrites,
      limit,
    },
    ...(scan.scanLimitReached ? { scanLimitReached: true as const } : {}),
  };

  if (dryRun || planned.length === 0) {
    return base;
  }

  // Refuse rather than half-apply: a partial sweep leaves the account in a state
  // no report described, and the caller cannot tell which half ran.
  if (planned.length > maxWrites) {
    throw new Error(
      `Planned ${planned.length} writes, above the maxWrites cap of ${maxWrites}. ` +
      "Re-run with a higher maxWrites once the dry run looks right — nothing was written."
    );
  }

  const writeOperations: PartnerMatchWriteOperation[] = [];
  /** globalPartnerId -> local id, so two rows hitting the same preset localise once. */
  const localisedThisRun = new Map<string, string>();
  let localPartnersCreated = 0;
  let localisationFailures = 0;

  for (const { evaluation, action } of planned) {
    const { txDoc, stored, classification } = evaluation;
    const previousName =
      context.partnerContext.partnerNameMap.get(stored.partnerId) ?? null;

    if (action === "clear") {
      writeOperations.push({
        ref: txDoc.ref,
        updates: buildClearUpdates(
          stored.partnerId,
          previousName,
          classification.candidates
        ),
      });
      continue;
    }

    const top = classification.topCandidate!;
    let targetId = top.partnerId;

    if (top.wouldCreateLocalPartner) {
      // Same localisation the write path performs, so a preset match lands as a
      // user partner rather than a dangling global reference.
      const alreadyLocalised = localisedThisRun.get(top.partnerId);
      if (alreadyLocalised) {
        targetId = alreadyLocalised;
      } else {
        try {
          targetId = await createLocalPartnerFromGlobal(userId, top.partnerId);
          localisedThisRun.set(top.partnerId, targetId);
          localPartnersCreated++;
        } catch (error) {
          console.error(
            `[rematchAssignedPartners] Failed to localise global partner ${top.partnerId} ` +
            `for transaction ${txDoc.id}; leaving the assignment untouched:`,
            error
          );
          localisationFailures++;
          continue;
        }
      }
    }

    writeOperations.push({
      ref: txDoc.ref,
      updates: buildReassignUpdates(
        stored.partnerId,
        previousName,
        targetId,
        context.partnerContext.partnerNameMap.get(targetId) ?? top.partnerName,
        top.confidence,
        classification.candidates
      ),
    });
  }

  await applyPartnerMatchUpdates(writeOperations);

  console.log(
    `[rematchAssignedPartners] user=${userId} wrote ${writeOperations.length} transactions ` +
    `(reassign=${actions.reassign}, clear=${actions.clear}, ` +
    `localPartnersCreated=${localPartnersCreated}, localisationFailures=${localisationFailures})`
  );

  return {
    ...base,
    applied: writeOperations.length > 0,
    transactionsWritten: writeOperations.length,
    localPartnersCreated,
    // Planned but not written, because the preset could not be localised. Never
    // silent: `actions.reassign` counts the plan, this counts what fell out.
    ...(localisationFailures > 0 ? { localisationFailures } : {}),
  };
}
