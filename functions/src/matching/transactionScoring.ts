/**
 * Shared Transaction Scoring Module
 *
 * Contains scoring logic used by:
 * - matchFileTransactions.ts (auto-triggered on file upload)
 * - findTransactionMatches.ts (callable for UI dialog)
 */

import { Timestamp } from "firebase-admin/firestore";
import { assessImpliedFx, isSameCurrency } from "../fx/fxPlausibility";
import {
  readBankOriginalAmount,
  type BankOriginalAmount,
} from "../fx/bankOriginalAmount";
import { selectEffectiveCycleForAmount, ResolvedEffectiveCycle } from "./billingCycle";
import type { DocumentType, DocumentationState } from "../documents/types";

// === Configuration ===

export const SCORING_CONFIG = {
  /** Minimum confidence for auto-matching (creates connection) */
  AUTO_MATCH_THRESHOLD: 85,
  /**
   * Bonus when the two hard financial facts agree on their own: a cent-exact
   * amount (same currency) AND the same day. 40 + 25 + 20 = 85, so this pair
   * clears AUTO_MATCH_THRESHOLD without needing partner corroboration (#78).
   */
  HARD_FACTS_BONUS_SAME_DAY: 20,
  /**
   * Bonus for a cent-exact amount within 3 days. 40 + 22 + 15 = 77: a strong
   * suggestion, but auto-connect still needs one more signal (any partner
   * text match >= 12 pushes it over 85).
   */
  HARD_FACTS_BONUS_CLOSE: 15,
  /** Minimum confidence to show as suggestion */
  SUGGESTION_THRESHOLD: 50,
  /** Days to search before/after file date */
  DATE_RANGE_DAYS: 30,
  /** Max suggestions to store per file */
  MAX_SUGGESTIONS: 5,
  /** Max results to return from callable */
  MAX_RESULTS: 20,
};

// === Types ===

export type TransactionMatchSource =
  | "amount_exact"
  | "amount_close"
  | "date_exact"
  | "date_close"
  | "partner"
  | "iban"
  | "reference"
  | "precision_hint";

export interface ScoreBreakdown {
  amount: number;
  date: number;
  partner: number;
  iban: number;
  reference: number;
  hint: number;
  /** Combination bonus for exact amount + exact/close date (see HARD_FACTS_BONUS_*) */
  hardFacts: number;
}

export interface TransactionPreview {
  date: Timestamp;
  amount: number;
  currency: string;
  name: string;
  partner: string | null;
}

/** What the target's existing documentation did to this pair (#104). */
export type DocumentationOutcome = "clear" | "upgrade" | "capped" | "suppressed";

export type DocumentationReason =
  /** The target holds nothing, or only a no-receipt category. */
  | "target-undocumented"
  /** The one case suppression must never hide: it closes the VAT gap. */
  | "invoice-upgrades-receipt-only"
  /** The target already holds a document of this class. */
  | "duplicate-document-class"
  /** A payment confirmation against a line that already has its Rechnung. */
  | "receipt-against-invoice"
  /** This candidate's own type is not established. */
  | "candidate-unclassified"
  /** The target's attached documents are not classified. */
  | "target-documents-unclassified";

export interface DocumentationAssessment {
  outcome: DocumentationOutcome;
  reason: DocumentationReason;
  /** The score before the rule touched it, so a suppression is inspectable. */
  confidenceBefore: number;
}

export interface TransactionMatchScore {
  transactionId: string;
  confidence: number;
  matchSources: TransactionMatchSource[];
  breakdown: ScoreBreakdown;
  preview: TransactionPreview;
  /**
   * Present only when the caller supplied the target's documentation state.
   * Absent means the rule did not run, not that the pair is clear (#104).
   */
  documentation?: DocumentationAssessment;
}

export interface FileMatchingData {
  extractedAmount?: number | null;
  /**
   * Freiwilliges Trinkgeld printed on the document (#172). Not part of the
   * VAT base, but part of what the card was charged — see filePaymentTotal.
   */
  extractedTipAmount?: number | null;
  extractedCurrency?: string | null;
  extractedDate?: Timestamp | null;
  extractedPartner?: string | null;
  extractedIban?: string | null;
  extractedText?: string | null;
  partnerId?: string | null;
  precisionSearchHint?: {
    transactionId: string;
    matchConfidence?: number;
  } | null;
  /**
   * This document's §11 classification (#104). Absent on a file extracted
   * before the classifier existed, which is treated as "not established"
   * rather than as any particular type.
   */
  documentType?: DocumentType | null;
}

export interface TransactionData {
  id: string;
  amount: number;
  date: Timestamp;
  currency?: string;
  /**
   * The preserved import row. Read only for the bank-stated original amount
   * (#112) — see readBankOriginalAmount. Optional because the precision-search
   * and remap paths build a TransactionData without it.
   */
  _original?: { rawRow?: Record<string, string> | null } | null;
  name?: string;
  partner?: string;
  partnerName?: string;
  partnerId?: string;
  partnerIban?: string;
  reference?: string;
  /**
   * How this transaction is already documented (#104). When omitted the
   * suppression rule does not run at all, so every existing caller keeps its
   * exact scores.
   */
  documentationState?: DocumentationState | null;
}

// === Utility Functions ===

export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

/**
 * Normalize a name for comparison (lowercase, remove common suffixes, trim)
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*(gmbh|ag|kg|ohg|ug|\be\.?k\.?|inc\.?|ltd\.?|llc|co\.?)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if two names match (fuzzy comparison)
 * Scoring rationale:
 * - Exact match = 25 pts (same as partner ID match - high trust)
 * - Contains match = 18 pts (e.g., "Amazon" vs "Amazon EU S.a.r.l.")
 * - Word overlap = 12-15 pts (partial confidence)
 */
export function namesMatch(
  name1: string,
  name2: string
): { match: boolean; score: number } {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);

  // Exact match after normalization - treat as strong as partner ID match
  if (n1 === n2) {
    return { match: true, score: 25 };
  }

  // One contains the other (for partial matches like "Amazon" vs "Amazon EU S.a.r.l.")
  if (n1.includes(n2) || n2.includes(n1)) {
    return { match: true, score: 18 };
  }

  // Check for significant word overlap (at least 2 words match)
  const words1 = n1.split(" ").filter((w) => w.length > 2);
  const words2 = n2.split(" ").filter((w) => w.length > 2);
  const matchingWords = words1.filter((w) =>
    words2.some((w2) => w === w2 || w.includes(w2) || w2.includes(w))
  );

  if (matchingWords.length >= 2) {
    return { match: true, score: 15 };
  }
  if (matchingWords.length >= 1 && (words1.length <= 2 || words2.length <= 2)) {
    return { match: true, score: 12 };
  }

  return { match: false, score: 0 };
}

// === Scoring Functions ===

/**
 * The cent-exact-then-tolerance ladder for two amounts already known to be in
 * the same currency. Tolerance is relative to the FILE amount, which is why it
 * is asymmetric — see the characterization tests.
 *
 * Extracted (#112) so the bank-original path and the same-currency path score
 * identically instead of growing a second, drifting copy.
 */
function scoreSameCurrencyLadder(
  absFile: number,
  absOther: number
): { score: number; source: TransactionMatchSource | null } {
  if (absFile === absOther) return { score: 40, source: "amount_exact" };

  const difference = Math.abs(absFile - absOther);
  const tolerance = absFile;

  if (difference <= tolerance * 0.01) return { score: 38, source: "amount_close" };
  if (difference <= tolerance * 0.05) return { score: 30, source: "amount_close" };
  if (difference <= tolerance * 0.1) return { score: 20, source: "amount_close" };
  return { score: 0, source: null };
}

export function calculateAmountScore(
  fileAmount: number,
  txAmount: number,
  fileCurrency?: string | null,
  txCurrency?: string | null,
  txOriginal?: BankOriginalAmount | null
): { score: number; source: TransactionMatchSource | null; currencyMismatch: boolean } {
  const absFile = Math.abs(fileAmount);
  const absTx = Math.abs(txAmount);

  if (absFile === 0 || absTx === 0) {
    return { score: 0, source: null, currencyMismatch: false };
  }

  // Ground truth beats plausibility (#112). When the document is in one
  // currency and the bank line in another, the bank usually still states what
  // it charged BEFORE settling — "Original Amount 24, Original Currency USD"
  // against a EUR 20.77 row. That figure is in the document's own currency, so
  // the two can be compared directly: no rate, no tolerance, no FX band.
  //
  // Scored on the same-currency ladder and reported with currencyMismatch
  // false, because in the currency that matters this is NOT a mismatched pair
  // — it is a cent-exact one, and it should earn the hard-facts bonus (#78)
  // exactly as the equivalent domestic payment does. Only the settlement
  // differs, and the settlement is not what identifies a payment.
  if (txOriginal && !isSameCurrency(fileCurrency, txCurrency)) {
    if (isSameCurrency(fileCurrency, txOriginal.currency)) {
      const ladder = scoreSameCurrencyLadder(absFile, Math.abs(txOriginal.amount));
      if (ladder.source !== null) {
        return { ...ladder, currencyMismatch: false };
      }
      // The bank stated an original in the document's currency and the two
      // still disagree by more than 10%. That is a real disagreement about
      // real numbers, not an FX artefact, so fall through to nothing rather
      // than letting the rate-plausibility path award points for it.
      return { score: 0, source: null, currencyMismatch: false };
    }
  }

  // Currency mismatch (fork #87): the raw numbers are in different units, so
  // comparing them is meaningless — USD 24.00 vs EUR 20.86 is the SAME
  // payment and used to score 0 (13% apart, outside the 10% band), while
  // USD 10.00 vs EUR 10.00 is a different payment and used to score 20.
  // Score the plausibility of the implied exchange rate instead. It is
  // deliberately capped below a same-currency exact match (40) and never
  // sets source amount_exact, so it cannot earn the hard-facts bonus:
  // a foreign-currency file still needs partner or date corroboration.
  const fx = assessImpliedFx(fileAmount, fileCurrency, txAmount, txCurrency);
  if (fx.mismatch && fx.referenceRate !== null) {
    if (fx.band === "tight") return { score: 30, source: "amount_close", currencyMismatch: true };
    if (fx.band === "loose") return { score: 20, source: "amount_close", currencyMismatch: true };
    return { score: 0, source: null, currencyMismatch: true };
  }
  // A mismatched pair with no anchor (unknown/garbled code — often a
  // mis-tagged EUR document) keeps the pre-#87 behaviour: numeric ladder,
  // halved. It still never reports amount_exact as a hard fact.

  // Same currency: cent-exact, then tolerance ladder relative to the FILE amount
  let { score, source } = scoreSameCurrencyLadder(absFile, absTx);

  if (fx.mismatch && score > 0) {
    score = Math.round(score * 0.5);
  }

  return { score, source, currencyMismatch: fx.mismatch };
}

export interface BillingCycleHint {
  invoiceToTransactionDelay?: number;
  delayVariance?: number;
  /** Days between charges of this recurrence — enables the period-penalty below. */
  frequencyDays?: number;
}

export function calculateDateScore(
  fileDate: Date,
  txDate: Date,
  billingCycle?: BillingCycleHint
): { score: number; source: TransactionMatchSource | null } {
  const daysDiff = Math.abs(
    Math.floor(
      (fileDate.getTime() - txDate.getTime()) / (1000 * 60 * 60 * 24)
    )
  );

  // If billing cycle has a learned invoice-to-transaction delay, check against it
  // This handles cases like "Telekom invoice Dec 1 → bank debit Dec 15" where
  // daysDiff=14 normally scores 8, but the learned delay makes it a strong match
  if (billingCycle?.invoiceToTransactionDelay != null) {
    const expectedDelay = billingCycle.invoiceToTransactionDelay;
    const variance = billingCycle.delayVariance ?? 3;
    const actualDelay = Math.floor(
      (txDate.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    const delayDiff = Math.abs(actualDelay - expectedDelay);

    // Checked before the near/close bands below, not after: for a short
    // frequency (e.g. weekly, 7d) with a loose delayVariance (e.g. 5d),
    // variance*2 (10) can exceed frequencyDays (7), so a same-amount
    // candidate exactly one period away would otherwise land in the "close"
    // band by raw delay proximity alone. This is the INCW9PTA bug: a
    // same-amount receipt from a neighbouring period must lose here, not
    // fall through to a proximity check that can't tell periods apart.
    //
    // Tolerance is `variance` itself (the same delay noise that governs the
    // near/close bands below), clamped to at most half a period. Without the
    // clamp, a loose variance relative to a short frequency would make this
    // check true for almost any delayDiff past the period midpoint — not
    // just delays that actually land near a period boundary — swallowing
    // same-period-but-late matches into a false rejection.
    if (billingCycle.frequencyDays) {
      const periodsAway = Math.round(delayDiff / billingCycle.frequencyDays);
      if (periodsAway >= 1) {
        const periodVariance = Math.min(variance, Math.floor(billingCycle.frequencyDays / 2));
        const distanceFromPeriod = Math.abs(
          delayDiff - periodsAway * billingCycle.frequencyDays
        );
        if (distanceFromPeriod <= periodVariance) {
          return { score: 0, source: null };
        }
      }
    }

    if (delayDiff <= variance) return { score: 25, source: "date_exact" };
    if (delayDiff <= variance * 2) return { score: 22, source: "date_close" };
  }

  // Standard date proximity scoring
  if (daysDiff === 0) return { score: 25, source: "date_exact" };
  if (daysDiff <= 3) return { score: 22, source: "date_close" };
  if (daysDiff <= 7) return { score: 15, source: "date_close" };
  if (daysDiff <= 14) return { score: 8, source: "date_close" };
  if (daysDiff <= 30) return { score: 3, source: "date_close" };

  return { score: 0, source: null };
}

export function calculateReferenceScore(
  extractedText: string,
  reference: string,
  currentDateScore: number
): {
  score: number;
  dateBonus: number;
  source: TransactionMatchSource | null;
} {
  if (!reference || reference.length < 3) {
    return { score: 0, dateBonus: 0, source: null };
  }

  const normalizedText = extractedText.toLowerCase();
  const normalizedRef = reference.toLowerCase();

  if (normalizedText.includes(normalizedRef)) {
    const dateBonus = currentDateScore < 15 ? 10 : 0;
    return { score: 5, dateBonus, source: "reference" };
  }

  return { score: 0, dateBonus: 0, source: null };
}

/**
 * Calculate partner score with multiple matching strategies:
 * 1. Partner ID match (strongest signal)
 * 2. Partner text match (file's extractedPartner vs transaction's name/partner)
 * 3. Partner alias match (check if transaction name matches any alias of file's assigned partner)
 */
export function calculatePartnerScore(
  fileData: FileMatchingData,
  txData: TransactionData,
  partnerAliases?: string[]
): { score: number; source: TransactionMatchSource | null } {
  // 1. Direct partner ID match (strongest - both have partnerId assigned)
  if (
    fileData.partnerId &&
    txData.partnerId &&
    fileData.partnerId === txData.partnerId
  ) {
    return { score: 25, source: "partner" };
  }

  // Get transaction's text name (could be in 'name', 'partner', or 'partnerName' field)
  const txName = txData.name || txData.partner || txData.partnerName || "";
  if (!txName) {
    return { score: 0, source: null };
  }

  // 2. Check file's extracted partner text against transaction name
  if (fileData.extractedPartner) {
    const result = namesMatch(fileData.extractedPartner, txName);
    if (result.match) {
      return { score: result.score, source: "partner" };
    }
  }

  // 3. Check partner aliases against transaction name
  if (partnerAliases && partnerAliases.length > 0) {
    for (const alias of partnerAliases) {
      const result = namesMatch(alias, txName);
      if (result.match) {
        return { score: result.score, source: "partner" };
      }
    }
  }

  return { score: 0, source: null };
}

/**
 * What the target's existing documentation says about this candidate (#104).
 *
 * Suppression happens HERE, at scoring, rather than in the candidate query.
 * Filtering out documented transactions up front is simpler and would kill
 * all 25 false proposals seen on 2026-08-17 — but it also kills the
 * invoice-after-receipt upgrade, which is the one case that must survive.
 * Keeping the decision in the scorer also makes a suppressed pair an
 * inspectable judgement rather than a row that silently never existed.
 *
 * This rule is deliberately independent of the dismissal list. Dismissal
 * means "this pair is wrong"; suppression means "this document is redundant
 * here". Two different facts, and these pairs are right.
 */
export function assessDocumentation(
  documentType: DocumentType | null | undefined,
  documentationState: DocumentationState
): { outcome: DocumentationOutcome; reason: DocumentationReason } {
  // Nothing to be redundant with. A no-receipt category is how a line with no
  // document is resolved, so attaching a real one there is always an upgrade.
  if (documentationState === "undocumented" || documentationState === "no-receipt-category") {
    return { outcome: "clear", reason: "target-undocumented" };
  }

  // The target holds documents we could not classify. Suppressing would risk
  // hiding the invoice that closes the gap; proposing at full score would
  // auto-connect on missing information. Neither — send it to a human.
  if (documentationState === "unknown") {
    return { outcome: "capped", reason: "target-documents-unclassified" };
  }

  // The candidate's own type is not established, against a documented target.
  if (documentType !== "invoice" && documentType !== "receipt") {
    return { outcome: "capped", reason: "candidate-unclassified" };
  }

  if (documentationState === "receipt-only") {
    return documentType === "invoice"
      ? { outcome: "upgrade", reason: "invoice-upgrades-receipt-only" }
      : { outcome: "suppressed", reason: "duplicate-document-class" };
  }

  // documentationState === "invoice"
  return documentType === "receipt"
    ? { outcome: "suppressed", reason: "receipt-against-invoice" }
    : { outcome: "suppressed", reason: "duplicate-document-class" };
}

/** Apply the assessment to a score. Never raises one. */
function applyDocumentationOutcome(
  confidence: number,
  outcome: DocumentationOutcome
): number {
  if (outcome === "suppressed") return 0;
  if (outcome === "capped") {
    return Math.min(confidence, SCORING_CONFIG.AUTO_MATCH_THRESHOLD - 1);
  }
  return confidence;
}

export interface ScoringOptions {
  /** Per-partner weight multipliers for scoring factors */
  weights?: {
    amountWeight: number;
    dateWeight: number;
    partnerWeight: number;
  };
  /** Billing cycle data for improved date scoring */
  billingCycle?: BillingCycleHint;
}

/**
 * Resolve the billing-cycle band + weights for one candidate transaction into
 * a `ScoringOptions`. Shared by every caller that scores a partner's
 * transactions against its `billingCycle.effective` bands (live matching,
 * bulk re-scoring) so band selection and hint assembly can't drift between
 * them.
 */
export function buildScoringOptions(
  effective: ResolvedEffectiveCycle[],
  weights: ScoringOptions["weights"] | undefined,
  amount: number
): ScoringOptions | undefined {
  const band = selectEffectiveCycleForAmount(effective, amount);
  if (!band && !weights) return undefined;

  const options: ScoringOptions = {};
  if (band) {
    options.billingCycle = {
      invoiceToTransactionDelay: band.invoiceToTransactionDelay,
      delayVariance: band.delayVariance,
      frequencyDays: band.frequencyDays,
    };
  }
  if (weights) options.weights = weights;
  return options;
}

/**
 * What the bank was charged for a document: the VAT-bearing total plus any
 * printed Trinkgeld (#172).
 *
 * `extractedAmount` is the Summe the printed rate groups add up to, which is
 * deliberately NOT the figure on the bank line for a restaurant Beleg with a
 * terminal-added tip. Every comparison against a bank amount goes through
 * here so the two readings cannot drift apart.
 */
export function filePaymentTotal(
  extractedAmount: number | null | undefined,
  extractedTipAmount: number | null | undefined
): number | null {
  if (extractedAmount == null) return null;
  const tip = extractedTipAmount ?? 0;
  if (tip <= 0) return extractedAmount;
  // A credit note carries the sign on the document total; the tip follows it.
  return extractedAmount < 0 ? extractedAmount - tip : extractedAmount + tip;
}

/** Map a transaction Firestore doc's data into the shape `scoreTransaction` expects. */
export function toTransactionData(
  id: string,
  data: FirebaseFirestore.DocumentData
): TransactionData {
  return {
    id,
    amount: data.amount,
    date: data.date,
    currency: data.currency,
    // Carries the bank-stated original amount for #112.
    _original: data._original,
    name: data.name,
    partner: data.partner,
    partnerName: data.partnerName,
    partnerId: data.partnerId,
    partnerIban: data.partnerIban,
    reference: data.reference,
    // #104: what the target already holds decides whether this file is a
    // duplicate to suppress or the invoice that upgrades the line.
    documentationState: data.documentationState,
  };
}

/** Map a file Firestore doc's data into the shape `scoreTransaction` expects. */
export function toFileMatchingData(data: FirebaseFirestore.DocumentData): FileMatchingData {
  return {
    extractedAmount: data.extractedAmount,
    extractedTipAmount: data.extractedTipAmount,
    extractedCurrency: data.extractedCurrency,
    extractedDate: data.extractedDate,
    extractedPartner: data.extractedPartner,
    extractedIban: data.extractedIban,
    extractedText: data.extractedText,
    partnerId: data.partnerId,
    precisionSearchHint: data.precisionSearchHint,
    documentType: data.documentType,
  };
}

/** Partner name + aliases, as `calculatePartnerScore` wants them. */
export function derivePartnerAliases(partnerData: FirebaseFirestore.DocumentData): string[] {
  return [partnerData.name, ...(partnerData.aliases || [])].filter(Boolean);
}

/** A partner's learned per-factor weight multipliers, if any. */
export function deriveScoringWeights(
  partnerData: FirebaseFirestore.DocumentData
): ScoringOptions["weights"] | undefined {
  const sw = partnerData.scoringWeights;
  if (!sw) return undefined;
  return {
    amountWeight: sw.amountWeight,
    dateWeight: sw.dateWeight,
    partnerWeight: sw.partnerWeight,
  };
}

/**
 * Score a transaction against file data
 */
export function scoreTransaction(
  fileData: FileMatchingData,
  txData: TransactionData,
  partnerAliases?: string[],
  options?: ScoringOptions
): TransactionMatchScore {
  let amountScore = 0;
  let dateScore = 0;
  let partnerScore = 0;
  let ibanScore = 0;
  let referenceScore = 0;
  let hintScore = 0;
  let hardFactsScore = 0;
  const matchSources: TransactionMatchSource[] = [];

  // 1. Amount scoring (0-40; a currency-mismatched pair scores FX plausibility, max 30)
  // amountExact is only true for a cent-exact match in a shared currency
  // (score 40). A currency-mismatched pair reaches that only through the bank's
  // own stated original amount (#112), which is a real same-currency
  // comparison; an FX-plausibility score never reports amount_exact.
  let amountExact = false;
  // #172: the bank was charged Summe + Trinkgeld, so that is the figure the
  // bank line is scored against — not the VAT-bearing total on its own.
  const filePayment = filePaymentTotal(fileData.extractedAmount, fileData.extractedTipAmount);
  if (filePayment != null) {
    const result = calculateAmountScore(
      filePayment,
      txData.amount,
      fileData.extractedCurrency,
      txData.currency,
      readBankOriginalAmount(txData._original?.rawRow)
    );
    amountScore = result.score;
    amountExact = result.source === "amount_exact" && !result.currencyMismatch;
    if (result.source) matchSources.push(result.source);
  }

  // 2. Date scoring (0-25, boosted when partner matches)
  let rawDateScore = 0;
  if (fileData.extractedDate) {
    const result = calculateDateScore(
      fileData.extractedDate.toDate(),
      txData.date.toDate(),
      options?.billingCycle
    );
    dateScore = result.score;
    rawDateScore = result.score;
    if (result.source) matchSources.push(result.source);
  }

  // 2b. Hard-facts combination bonus (#78)
  // Exact amount + exact date used to cap at 65 (< AUTO_MATCH_THRESHOLD 85), so
  // auto-connect was gated on partner identity rather than on the two facts that
  // actually identify a payment. Uses the RAW date score, before the partner
  // boost in 3b, so the bonus does not depend on partner signals.
  if (amountExact) {
    if (rawDateScore >= 25) {
      hardFactsScore = SCORING_CONFIG.HARD_FACTS_BONUS_SAME_DAY;
    } else if (rawDateScore >= 22) {
      hardFactsScore = SCORING_CONFIG.HARD_FACTS_BONUS_CLOSE;
    }
  }

  // 3. Partner scoring (0-25 for ID match, 0-15 for text match)
  const partnerResult = calculatePartnerScore(fileData, txData, partnerAliases);
  partnerScore = partnerResult.score;
  if (partnerResult.source) matchSources.push(partnerResult.source);

  // 3b. Date boost for partner matches (recurring transaction disambiguation)
  // When partner matches, date becomes critical for distinguishing monthly invoices.
  // Boost date score by 50% (max +12.5 pts) to prioritize correct month matching.
  // Also apply a date penalty when date is poor but partner matches - this prevents
  // a wrong-month transaction from scoring high just because partner/amount match.
  if (partnerScore >= 15 && fileData.extractedDate) {
    if (dateScore >= 15) {
      // Good date match + partner match: boost date by 50%
      dateScore = Math.min(37, Math.round(dateScore * 1.5));
    } else if (dateScore <= 3) {
      // Poor date match + partner match: likely wrong month, apply penalty
      // Reduce partner score to discourage matching wrong-month transactions
      partnerScore = Math.round(partnerScore * 0.6);
    }
  }

  // 4. IBAN scoring (0-10)
  if (fileData.extractedIban && txData.partnerIban) {
    const fileIban = normalizeIban(fileData.extractedIban);
    const txIban = normalizeIban(txData.partnerIban);
    if (fileIban === txIban) {
      ibanScore = 10;
      matchSources.push("iban");
    }
  }

  // 5. Reference scoring (0-5, with date bonus)
  if (fileData.extractedText && txData.reference) {
    const result = calculateReferenceScore(
      fileData.extractedText,
      txData.reference,
      dateScore
    );
    referenceScore = result.score;
    if (result.dateBonus) {
      dateScore = Math.min(25, dateScore + result.dateBonus);
    }
    if (result.source) matchSources.push(result.source);
  }

  // 6. Precision search hint scoring (0-40)
  if (
    fileData.precisionSearchHint &&
    fileData.precisionSearchHint.transactionId === txData.id
  ) {
    const searchConfidence = fileData.precisionSearchHint.matchConfidence;
    if (searchConfidence && searchConfidence >= 50) {
      hintScore = 40;
    } else if (searchConfidence && searchConfidence >= 25) {
      hintScore = 30;
    } else {
      hintScore = 25;
    }
    matchSources.push("precision_hint");
  }

  // Apply per-partner weight adjustments if provided
  const w = options?.weights;
  const weightedAmount = w ? amountScore * w.amountWeight : amountScore;
  const weightedDate = w ? dateScore * w.dateWeight : dateScore;
  const weightedPartner = w ? partnerScore * w.partnerWeight : partnerScore;

  const rawConfidence =
    weightedAmount +
    weightedDate +
    weightedPartner +
    ibanScore +
    referenceScore +
    hintScore +
    hardFactsScore;
  // Cap at 100 (multiple strong signals shouldn't exceed 100%)
  const scoredConfidence = Math.min(100, Math.round(rawConfidence));

  // 7. Documentation-aware suppression (#104). Runs only when the caller
  // supplied the target's state, so a caller that does not know it keeps the
  // pre-#104 score exactly.
  let confidence = scoredConfidence;
  let documentation: DocumentationAssessment | undefined;
  if (txData.documentationState) {
    const assessment = assessDocumentation(fileData.documentType, txData.documentationState);
    confidence = applyDocumentationOutcome(scoredConfidence, assessment.outcome);
    documentation = { ...assessment, confidenceBefore: scoredConfidence };
  }

  return {
    transactionId: txData.id,
    confidence,
    matchSources,
    ...(documentation ? { documentation } : {}),
    breakdown: {
      amount: amountScore,
      date: dateScore,
      partner: partnerScore,
      iban: ibanScore,
      reference: referenceScore,
      hint: hintScore,
      hardFacts: hardFactsScore,
    },
    preview: {
      date: txData.date,
      amount: txData.amount,
      currency: txData.currency || "EUR",
      name: txData.name || "",
      partner: txData.partner || null,
    },
  };
}

/**
 * Format score breakdown for logging
 */
export function formatScoreBreakdown(breakdown: ScoreBreakdown): string {
  const parts: string[] = [];
  if (breakdown.amount > 0) parts.push(`amt:${breakdown.amount}`);
  if (breakdown.date > 0) parts.push(`date:${breakdown.date}`);
  if (breakdown.partner > 0) parts.push(`partner:${breakdown.partner}`);
  if (breakdown.iban > 0) parts.push(`iban:${breakdown.iban}`);
  if (breakdown.reference > 0) parts.push(`ref:${breakdown.reference}`);
  if (breakdown.hint > 0) parts.push(`hint:${breakdown.hint}`);
  if (breakdown.hardFacts > 0) parts.push(`facts:${breakdown.hardFacts}`);
  return parts.join(" + ");
}
