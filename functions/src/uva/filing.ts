/**
 * The filing record: what actually goes to the Steuerberater (#85).
 *
 * `calculateUva` answers "what are the figures". A filing has to answer three
 * more questions before a human signs it, and all three were being carried on
 * session notes instead of on the filing:
 *
 *  1. Which cent of Vorsteuer rests on which document, and which rests on none.
 *     § 12 Abs 1 Z 1 deducts tax invoiced under § 11 — a claim with no invoice
 *     behind it is not a rounding difference, it is an unsupported deduction.
 *  2. Which exceptions this quarter carries and on what basis. An undocumented
 *     exception silently repeats next quarter, which is exactly how one gets
 *     rediscovered as a surprise instead of applied as a decision.
 *  3. Which open items were resolved and which were deferred, and what each
 *     one moves if acted on. A deferral without a stated effect is a hole.
 *
 * Exceptions are DERIVED, never typed in: a non-claimable marker (#203) and a
 * foreign-currency conversion (fork #87) are both already data on the run, so
 * the filing reads them off rather than asking a human to remember them. Open
 * items cannot be derived — nothing in the corpus knows that a POS receipt's
 * 10/20 split has to be read off the paper — so they are declared, and a
 * declaration with no rationale or no stated effect is a blocker, not a note.
 *
 * Nothing here submits anything. `UvaFilingHandover` has no "submitted" state
 * to reach: FinanzOnline submission is a separate, human-triggered path
 * (submitUvaCallable), and a prepared filing must not be able to claim it
 * happened.
 */

import type {
  FxConversionEntry,
  NonClaimableVatReason,
  DerivationStep,
  UvaReportResult,
} from "./types";
import type { UvaReconciliation } from "./reconcile";

/** One claimed input-VAT figure and the documents it rests on. */
export interface VorsteuerTraceEntry {
  transactionId: string;
  date: string;
  partner: string | null;
  /** Input VAT this transaction contributed, cents. */
  vat: number;
  step: DerivationStep;
  fileIds: string[];
}

/**
 * Why a claimed input-VAT figure has no document under it. Only the first is a
 * problem; the other two are deductions the law sources somewhere other than a
 * supplier invoice, and they are listed so that is visible rather than assumed.
 *
 *  - no-document        a rate was resolved without a receipt (the manual
 *                       override lane). Nothing supports the deduction.
 *  - self-assessed      reverse charge §19 / ig. Erwerb Art 1 BMR: the same
 *                       cents are booked as output VAT in this run, so the pair
 *                       nets to zero and no supplier invoice carries the tax.
 *  - import-declaration Einfuhrumsatzsteuer, evidenced by the customs
 *                       declaration rather than by a §11 invoice.
 */
export type UntracedBasis = "no-document" | "self-assessed" | "import-declaration";

export interface UntracedVorsteuerEntry extends Omit<VorsteuerTraceEntry, "step"> {
  step: DerivationStep | null;
  basis: UntracedBasis;
}

export interface VorsteuerTrace {
  traced: VorsteuerTraceEntry[];
  untraced: UntracedVorsteuerEntry[];
  tracedVat: number;
  untracedVat: number;
  /** Input VAT claimed with nothing at all behind it — the subset that is a defect. */
  undocumentedVat: number;
  /** traced + untraced === the run's totalInputVat. False is a bug, not a tolerance. */
  reconciles: boolean;
}

export type FilingExceptionKind = "non-claimable-vat" | "fx-effective-rate";

/**
 * An exception the filing carries, with the reasoning that justifies it. The
 * basis text is on the record on purpose — next quarter reads it here instead
 * of re-deriving it from a chat log.
 */
export interface UvaFilingException {
  kind: FilingExceptionKind;
  /** Non-claimable only: which reason from the closed set (#203). */
  reason?: NonClaimableVatReason;
  /** What was done. */
  statement: string;
  /** Why it is allowed — statute and method. */
  basis: string;
  /** Documents the exception covers. */
  fileIds: string[];
  /**
   * Cents the exception governs: VAT kept out of Vorsteuer (non-claimable), or
   * input VAT read through a converted rate (fx).
   */
  amount: number;
  /**
   * The bounded uncertainty the method admits, cents. Null when the method has
   * none — an exclusion is exact, a conversion is not.
   */
  exposure: { low: number; high: number } | null;
}

/**
 * Card-issuer FX markup band. The effective rate the payment carries includes
 * it, so a claim converted at that rate runs high by roughly this much against
 * a BMF/ECB Tageskurs. Bounding it is what lets the method be used knowingly
 * rather than defended after the fact.
 */
export const FX_MARKUP_LOW = 0.01;
export const FX_MARKUP_HIGH = 0.03;

const NON_CLAIMABLE_BASIS: Record<NonClaimableVatReason, string> = {
  "insurance-tax":
    "Insurance is VAT-exempt under § 6 Abs 1 Z 9 lit. c UStG, so the percentage " +
    "printed on a policy is Versicherungssteuer — a different tax, which no " +
    "§ 12 deduction reaches.",
  levy:
    "A public charge printed in the VAT column is not Umsatzsteuer, so § 12 " +
    "Abs 1 Z 1 does not apply to it.",
  "discount-to-zero":
    "§ 12 Abs 1 Z 1 deducts the tax owed on the supply. A 100% discount leaves " +
    "nothing due, so there is no tax to deduct even though the document still " +
    "prints a rate.",
  private:
    "Privately consumed, so not for the business — § 12 Abs 2 UStG denies the " +
    "deduction.",
};

const FX_BASIS =
  "§ 20 Abs 6 UStG method 3: the Tageskurs, where the amounts are evidenced by " +
  "a Bankmitteilung — here the card statement, whose settled EUR amount over " +
  "the document's own total IS the rate the payment carried on the payment " +
  "date. The issuer's markup sits inside that rate, so the claim runs high by " +
  "the bounded exposure below rather than by an unknown amount.";

/**
 * Something the filing knows it has not settled. Declared by the operator: the
 * corpus cannot tell that a POS receipt's rate split has to be read off paper.
 */
export interface UvaOpenItem {
  /** Corpus reference — file id, transaction id, or document number. */
  ref: string;
  summary: string;
  disposition: "resolved" | "deferred";
  /** Why. A deferral without one is how the same item repeats next quarter. */
  rationale: string;
  /**
   * What acting on it moves in the figures, cents. Zero is a statement too —
   * "this one costs nothing" is exactly the thing worth writing down.
   */
  effect: { inputVat: number; outputVat: number };
}

/**
 * Handover state. There is deliberately no "submitted" member: this repo
 * prepares filings and hands them to a Steuerberater, and nothing files
 * autonomously.
 */
export type UvaFilingHandover =
  | { state: "prepared" }
  | {
      state: "handed-over";
      /** Who received it. */
      to: string;
      /** ISO date of the handover — supplied, never read off a clock here. */
      at: string;
      /** How it went out (e-mail, shared folder, portal…). */
      via: string;
    };

export type FilingBlockerCode =
  /** Input VAT claimed with no document and no statutory alternative source. */
  | "vorsteuer-undocumented"
  /** The trace does not add up to the run's own input-VAT total. */
  | "vorsteuer-does-not-reconcile"
  /** A declared open item carries no rationale. */
  | "open-item-unexplained"
  /** A supplied reconciliation leaves part of the delta unowned. */
  | "reconciliation-unaccounted"
  /** A supplied reconciliation is against a different period. */
  | "reconciliation-not-comparable"
  /** The recorded handover covered a run whose totals this one no longer has. */
  | "handover-stale";

export interface FilingBlocker {
  code: FilingBlockerCode;
  detail: string;
}

export interface UvaFiling {
  report: UvaReportResult;
  /**
   * Ist-Besteuerung throughout: the period is decided by when the money moved,
   * not by invoice date. It is not a switch — the derivation has no invoice
   * date to read — so it is stated here for the reader of the filing.
   */
  basis: "ist";
  vorsteuer: VorsteuerTrace;
  exceptions: UvaFilingException[];
  openItems: UvaOpenItem[];
  /** Comparison against an earlier run of the same period, when one was kept. */
  reconciliation: UvaReconciliation | null;
  handover: UvaFilingHandover;
  /** Empty means the filing can go out. */
  blockers: FilingBlocker[];
}

/**
 * Split the run's input VAT into what a document supports and what it does not.
 * Reads the per-transaction record the Kennzahlen were summed from, so it
 * cannot disagree with the figures it is tracing.
 */
export function buildVorsteuerTrace(result: UvaReportResult): VorsteuerTrace {
  const traced: VorsteuerTraceEntry[] = [];
  const untraced: UntracedVorsteuerEntry[] = [];

  for (const d of result.derivations) {
    if (d.inputVat === 0) continue;
    const base = {
      transactionId: d.transactionId,
      date: d.date,
      partner: d.partner,
      vat: d.inputVat,
      fileIds: d.fileIds,
    };
    if (d.fileIds.length > 0 && d.step && isDocumentStep(d.step)) {
      traced.push({ ...base, step: d.step });
      continue;
    }
    untraced.push({ ...base, step: d.step, basis: untracedBasis(d.step) });
  }

  const tracedVat = traced.reduce((s, e) => s + e.vat, 0);
  const untracedVat = untraced.reduce((s, e) => s + e.vat, 0);
  return {
    traced,
    untraced,
    tracedVat,
    untracedVat,
    undocumentedVat: untraced
      .filter((e) => e.basis === "no-document")
      .reduce((s, e) => s + e.vat, 0),
    reconciles: tracedVat + untracedVat === result.totalInputVat,
  };
}

/**
 * The exceptions this run carries, read off the data rather than remembered.
 * One entry per non-claimable reason present, plus one for the foreign-currency
 * method if any document was converted.
 */
export function deriveFilingExceptions(result: UvaReportResult): UvaFilingException[] {
  const exceptions: UvaFilingException[] = [];

  const byReason = new Map<NonClaimableVatReason, { fileIds: string[]; amount: number }>();
  for (const n of result.nonClaimableVat) {
    const acc = byReason.get(n.reason) ?? { fileIds: [], amount: 0 };
    if (!acc.fileIds.includes(n.fileId)) acc.fileIds.push(n.fileId);
    acc.amount += n.excludedVat;
    byReason.set(n.reason, acc);
  }
  for (const [reason, acc] of byReason) {
    exceptions.push({
      kind: "non-claimable-vat",
      reason,
      statement:
        `${acc.fileIds.length} document(s) print a VAT figure that was kept out of ` +
        `Vorsteuer on a recorded decision (${reason}). Their gross is booked at 0%.`,
      basis: NON_CLAIMABLE_BASIS[reason],
      fileIds: acc.fileIds,
      amount: acc.amount,
      exposure: null,
    });
  }

  if (result.fxConversions.length > 0) {
    const converted = fxConvertedInputVat(result);
    exceptions.push({
      kind: "fx-effective-rate",
      statement:
        `${result.fxConversions.length} foreign-currency document(s) were read at the ` +
        `effective rate the payment carried (${fxCurrencies(result.fxConversions).join(", ")}), ` +
        `not at a published daily rate.`,
      basis: FX_BASIS,
      fileIds: result.fxConversions.map((c) => c.fileId),
      amount: converted,
      exposure: {
        low: Math.round(converted * FX_MARKUP_LOW),
        high: Math.round(converted * FX_MARKUP_HIGH),
      },
    });
  }

  return exceptions;
}

export interface BuildFilingInput {
  report: UvaReportResult;
  /** Declared open items; every one needs a rationale and a stated effect. */
  openItems?: UvaOpenItem[];
  /** Comparison against the pre-sweep run of the same period, when kept. */
  reconciliation?: UvaReconciliation | null;
  /** Defaults to `{ state: "prepared" }` — a filing is never born handed over. */
  handover?: UvaFilingHandover;
  /**
   * The totals the recorded handover covered. A handover outlives the run it
   * was recorded against — it is kept per period, the run is re-derived — so a
   * later run that moves the figures would otherwise leave a record saying the
   * Steuerberater received THIS filing when he received a different one.
   */
  handoverCovers?: HandoverCoverage | null;
}

/** The figures a recorded handover went out with. */
export interface HandoverCoverage {
  totalInputVat: number;
  totalOutputVat: number;
  balance: number;
}

export function buildUvaFiling(input: BuildFilingInput): UvaFiling {
  const { report } = input;
  const openItems = input.openItems ?? [];
  const reconciliation = input.reconciliation ?? null;
  const vorsteuer = buildVorsteuerTrace(report);
  const exceptions = deriveFilingExceptions(report);

  const blockers: FilingBlocker[] = [];
  if (!vorsteuer.reconciles) {
    blockers.push({
      code: "vorsteuer-does-not-reconcile",
      detail:
        `Trace totals ${vorsteuer.tracedVat + vorsteuer.untracedVat} cents against a ` +
        `reported input VAT of ${report.totalInputVat} cents.`,
    });
  }
  if (vorsteuer.undocumentedVat !== 0) {
    blockers.push({
      code: "vorsteuer-undocumented",
      detail:
        `${vorsteuer.undocumentedVat} cents of input VAT rest on no document ` +
        `(${vorsteuer.untraced.filter((e) => e.basis === "no-document").length} transaction(s)).`,
    });
  }
  for (const item of openItems) {
    if (!item.rationale.trim()) {
      blockers.push({
        code: "open-item-unexplained",
        detail: `Open item ${item.ref} is ${item.disposition} with no rationale.`,
      });
    }
  }
  const handover = input.handover ?? { state: "prepared" };
  if (handover.state === "handed-over" && input.handoverCovers) {
    const covered = input.handoverCovers;
    if (
      covered.totalInputVat !== report.totalInputVat ||
      covered.totalOutputVat !== report.totalOutputVat ||
      covered.balance !== report.balance
    ) {
      blockers.push({
        code: "handover-stale",
        detail:
          `Handed over at a balance of ${covered.balance} cents; this run ` +
          `produces ${report.balance} cents. Re-hand it over or explain the move.`,
      });
    }
  }
  if (reconciliation) {
    if (!reconciliation.comparable) {
      blockers.push({
        code: "reconciliation-not-comparable",
        detail: `Baseline is for a different period than ${reconciliation.periodKey}.`,
      });
    }
    if (!reconciliation.accountedFor) {
      blockers.push({
        code: "reconciliation-unaccounted",
        detail: "Movements do not sum to the change in the totals.",
      });
    }
  }

  return {
    report,
    basis: "ist",
    vorsteuer,
    exceptions,
    openItems,
    reconciliation,
    handover,
    blockers,
  };
}

/** Input VAT claimed on transactions whose document was FX-converted. */
function fxConvertedInputVat(result: UvaReportResult): number {
  const txIds = new Set(result.fxConversions.map((c) => c.transactionId));
  return result.derivations
    .filter((d) => txIds.has(d.transactionId))
    .reduce((s, d) => s + d.inputVat, 0);
}

function fxCurrencies(conversions: FxConversionEntry[]): string[] {
  return [...new Set(conversions.map((c) => c.documentCurrency))].sort();
}

/** Rungs that read an actual document, as opposed to self-assessing a figure. */
function isDocumentStep(step: DerivationStep): boolean {
  return (
    step === "rate-groups" ||
    step === "line-items" ||
    step === "top-level" ||
    step === "invoice" ||
    step === "non-claimable"
  );
}

function untracedBasis(step: DerivationStep | null): UntracedBasis {
  if (step === "reverse-charge" || step === "eu-acquisition") return "self-assessed";
  if (step === "import") return "import-declaration";
  return "no-document";
}
