/**
 * Shared extraction logic used by both:
 * - extractFileData (onDocumentCreated trigger for new files)
 * - retryExtraction (onCall function for manual retries)
 *
 * This prevents code duplication and ensures consistent behavior.
 */

import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import {
  extractDocument,
  getDefaultProvider,
} from "./documentExtractor";
import { logAIUsage } from "../utils/ai-usage-logger";
import { MODELS } from "../utils/models";

const db = getFirestore();

import { ExtractedEntity, ExtractedLineItem, ExtractedRateGroup } from "../types/extraction";
import { applyVatDowngradeGuard } from "./vatSourceGuard";
import type { RecipientIdentity } from "../matching/recipientIdentity";
import {
  determineCounterparty,
  getAllIdentityNames,
  identityNameMatches,
  matchEntityToIdentity,
  type InvoiceDirection,
  type UserIdentityData,
} from "../utils/identity-matcher";
import { classifyFileRecord, documentTypeFields } from "../documents/adapter";
import { reviewFileRecordVatRates, vatRateReviewFields } from "../documents/vatRateReview";
import { classifyDocumentType } from "../documents/classifyDocumentType";
import { syncDocumentationStateForTransactions } from "../documents/syncDocumentationState";
import { computeDirectionReviewFields } from "../documents/syncDirectionReview";
import { directionReviewFields } from "../documents/directionReview";

/**
 * Options for running extraction
 */
export interface ExtractionOptions {
  /** Anthropic API key (only needed for vision-claude provider) */
  anthropicApiKey?: string;
  /** Skip two-phase classification (user has overridden AI classification) */
  skipClassification?: boolean;
  /** Gemini model to use */
  geminiModel?: string;
}

/**
 * Fetch the user's identity data from Firestore.
 *
 * Returned as stored: the shared identity matcher reads both the current
 * format (personalEntity + companies[]) and the deprecated flat fields itself,
 * so there is nothing to flatten here. Flattening is what let this copy drift
 * from the one in onUserDataUpdate (issue #232).
 */
async function getUserData(userId: string): Promise<UserIdentityData | null> {
  try {
    const doc = await db
      .collection("users")
      .doc(userId)
      .collection("settings")
      .doc("userData")
      .get();

    if (!doc.exists) {
      return null;
    }

    return doc.data() as UserIdentityData;
  } catch (error) {
    console.warn("[UserData] Failed to fetch user data:", error);
    return null;
  }
}

/**
 * Legacy direction detection, used when the extractor produced no issuer or
 * recipient entities and all we have is a partner name.
 * - Partner matches the user: the user issued it, so the invoice is outgoing
 * - Partner does not match: incoming
 * - No partner or no user data: unknown
 */
function determineInvoiceDirection(
  extractedPartner: string | null,
  userData: UserIdentityData | null
): InvoiceDirection {
  if (!extractedPartner || !userData) {
    return "unknown";
  }

  for (const identityName of getAllIdentityNames(userData)) {
    if (identityNameMatches(identityName, extractedPartner)) {
      return "outgoing";
    }
  }

  return "incoming";
}

/**
 * Fetch IBANs from user's connected bank accounts (sources)
 */
async function getSourceIbans(userId: string): Promise<string[]> {
  try {
    const sourcesSnapshot = await db
      .collection("sources")
      .where("userId", "==", userId)
      .where("isActive", "==", true)
      .get();

    return sourcesSnapshot.docs
      .map((doc) => doc.data().iban as string | undefined)
      .filter((iban): iban is string => !!iban)
      .map((iban) => iban.toUpperCase().replace(/\s/g, ""));
  } catch (error) {
    console.warn("[SourceIbans] Failed to fetch source IBANs:", error);
    return [];
  }
}

function normalizeExtractedLineItems(
  lineItems: ExtractedLineItem[] | null | undefined
): ExtractedLineItem[] {
  if (!Array.isArray(lineItems)) {
    return [];
  }

  return lineItems
    .map((item, index): ExtractedLineItem | null => {
      if (!item || typeof item.amount !== "number" || !Number.isFinite(item.amount)) {
        return null;
      }

      const normalizedVatPercent = typeof item.vatPercent === "number" &&
        Number.isFinite(item.vatPercent) &&
        item.vatPercent >= 0 &&
        item.vatPercent <= 100
        ? item.vatPercent
        : null;

      const normalizedVatAmount = typeof item.vatAmount === "number" && Number.isFinite(item.vatAmount)
        ? Math.round(item.vatAmount)
        : 0;

      const normalizedQuantity = typeof item.quantity === "number" && Number.isFinite(item.quantity)
        ? item.quantity
        : null;

      const normalizedUnitPrice = typeof item.unitPrice === "number" && Number.isFinite(item.unitPrice)
        ? Math.round(item.unitPrice)
        : null;

      return {
        description: item.description?.trim() || `Item ${index + 1}`,
        quantity: normalizedQuantity,
        unitPrice: normalizedUnitPrice,
        vatPercent: normalizedVatPercent,
        vatAmount: normalizedVatAmount,
        amount: Math.round(item.amount),
      };
    })
    .filter((item): item is ExtractedLineItem => item !== null);
}

function isLikelyNonBillableLine(description: string): boolean {
  const normalized = description.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  const patterns: RegExp[] = [
    /^subtotal\b/,
    /^total\b/,
    /^total excluding tax\b/,
    /^amount paid\b/,
    /^payment history\b/,
    /^vat\b/,
    /^tax\b/,
    /^first\s+\d+/,
    /\band above\b/,
    /^description\b/,
    /^qty\b/,
    /^unit price\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function inferLineItemAmountsAreNet(lineItems: ExtractedLineItem[]): boolean {
  let comparedItems = 0;
  let netInterpretationError = 0;
  let grossInterpretationError = 0;

  for (const item of lineItems) {
    if (
      item.vatPercent === null ||
      !Number.isFinite(item.vatPercent) ||
      item.vatPercent <= 0 ||
      !Number.isFinite(item.vatAmount)
    ) {
      continue;
    }

    const rate = item.vatPercent;
    const expectedVatIfNet = Math.round((item.amount * rate) / 100);
    const expectedVatIfGross = Math.round((item.amount * rate) / (100 + rate));

    netInterpretationError += Math.abs(expectedVatIfNet - item.vatAmount);
    grossInterpretationError += Math.abs(expectedVatIfGross - item.vatAmount);
    comparedItems += 1;
  }

  if (comparedItems === 0) {
    return false;
  }

  return netInterpretationError < grossInterpretationError;
}


function consolidateLineItems(
  lineItems: ExtractedLineItem[],
  extractedDocumentAmount?: number | null
): {
  totalAmount: number;
  totalVatAmount: number;
  consolidatedVatPercent: number | null;
} {
  const totalAmountFromItems = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const totalVatAmount = lineItems.reduce((sum, item) => sum + item.vatAmount, 0);
  const totalAmountFromNetPlusVat = totalAmountFromItems + totalVatAmount;

  const firstRate = lineItems[0]?.vatPercent ?? null;
  const hasSingleRate = firstRate !== null && lineItems.every((item) =>
    item.vatPercent !== null && Math.abs(item.vatPercent - firstRate) < 0.0001
  );

  let totalAmount = totalAmountFromItems;

  if (typeof extractedDocumentAmount === "number" && Number.isFinite(extractedDocumentAmount)) {
    const distanceToAsIs = Math.abs(totalAmountFromItems - extractedDocumentAmount);
    const distanceToNetPlusVat = Math.abs(totalAmountFromNetPlusVat - extractedDocumentAmount);

    if (distanceToNetPlusVat < distanceToAsIs) {
      totalAmount = totalAmountFromNetPlusVat;
    } else {
      totalAmount = totalAmountFromItems;
    }
  } else {
    const amountsLookNet = totalVatAmount > 0 && inferLineItemAmountsAreNet(lineItems);
    totalAmount = amountsLookNet ? totalAmountFromNetPlusVat : totalAmountFromItems;
  }

  return {
    totalAmount,
    totalVatAmount,
    consolidatedVatPercent: hasSingleRate ? firstRate : null,
  };
}

/** Reconciliation tolerance for a figure: 5 cents or 0.5%, whichever is larger. */
function amountTolerance(amount: number): number {
  return Math.max(5, Math.round(amount * 0.005));
}

/**
 * Validate the document's printed VAT summary block (fork #67, spec §6
 * item 3) before anything is allowed to trust it.
 *
 * The block earns its authority from being PRINTED, so a transcription we
 * cannot verify is worth less than no block at all — a hallucinated
 * summary would silently become the VAT truth for the whole document.
 * Three gates, all-or-nothing across the block:
 *
 *  1. each row is internally consistent (net + vat = gross, and vat is
 *     what the row's own rate implies),
 *  2. the rows sum to the document total,
 *  3. no negative or empty figures.
 *
 * A block that fails any gate is discarded, and the caller falls back to
 * whole-document reconciliation exactly as before fork #67.
 */
export function validateRateGroups(
  rateGroups: ExtractedRateGroup[] | null | undefined,
  extractedAmount: number | null | undefined
): ExtractedRateGroup[] | null {
  if (!Array.isArray(rateGroups) || rateGroups.length === 0) {
    return null;
  }

  for (const g of rateGroups) {
    if (
      typeof g?.rate !== "number" || !Number.isFinite(g.rate) ||
      g.rate < 0 || g.rate > 100 ||
      typeof g.net !== "number" || !Number.isFinite(g.net) ||
      typeof g.vat !== "number" || !Number.isFinite(g.vat) ||
      typeof g.gross !== "number" || !Number.isFinite(g.gross)
    ) {
      return null;
    }
    if (g.net < 0 || g.vat < 0 || g.gross <= 0) {
      return null;
    }
    // net + vat = gross, allowing per-row cent rounding.
    if (Math.abs(g.net + g.vat - g.gross) > 2) {
      return null;
    }
    // The printed vat must be what the printed rate implies for the
    // printed net — this is what catches a column read off the wrong row.
    const impliedVat = Math.round((g.net * g.rate) / 100);
    if (Math.abs(g.vat - impliedVat) > Math.max(2, Math.round(g.gross * 0.002))) {
      return null;
    }
  }

  if (typeof extractedAmount === "number" && Number.isFinite(extractedAmount) && extractedAmount > 0) {
    const summed = rateGroups.reduce((sum, g) => sum + g.gross, 0);
    if (Math.abs(summed - extractedAmount) > amountTolerance(extractedAmount)) {
      console.warn(
        `[ExtractionCore] Printed rate groups sum to ${summed} cents but the ` +
        `document total is ${extractedAmount}. Discarding the block.`
      );
      return null;
    }
  }

  return rateGroups;
}

/**
 * The VAT-bearing Summe, once a printed Trinkgeld is out of it (#172).
 *
 * A restaurant Beleg paid by card prints three figures — Summe, Trinkgeld,
 * Gesamt — and only the Summe carries the printed rate groups. The prompt
 * asks for the Summe in `amount`, but when the model hands back the Gesamt
 * anyway the printed block is the arbiter: a block that reconciles against
 * `amount - tip` and NOT against `amount` says `amount` is the Gesamt.
 *
 * Nothing weaker moves the figure. Subtracting a tip on the model's word
 * alone would be the loose-tolerance fix this ticket exists to avoid — it
 * would let a hallucinated tip line eat 3,20 EUR of a real VAT base.
 */
export function totalWithoutPrintedTip(
  extractedAmount: number | null | undefined,
  tipAmount: number | null | undefined,
  rateGroups: ExtractedRateGroup[] | null | undefined
): number | null | undefined {
  if (typeof extractedAmount !== "number" || !Number.isFinite(extractedAmount)) {
    return extractedAmount;
  }
  if (typeof tipAmount !== "number" || tipAmount <= 0 || extractedAmount <= tipAmount) {
    return extractedAmount;
  }
  if (!Array.isArray(rateGroups) || rateGroups.length === 0) {
    return extractedAmount;
  }

  const summed = rateGroups.reduce((sum, g) => sum + (g?.gross ?? 0), 0);
  const withoutTip = extractedAmount - tipAmount;
  const fitsWithoutTip = Math.abs(summed - withoutTip) <= amountTolerance(withoutTip);
  const fitsTotal = Math.abs(summed - extractedAmount) <= amountTolerance(extractedAmount);
  if (fitsWithoutTip && !fitsTotal) {
    console.warn(
      `[ExtractionCore] Document total ${extractedAmount} includes the printed ` +
      `tip of ${tipAmount}; the rate groups sum to ${summed}. Reading ${withoutTip} ` +
      "as the VAT-bearing total."
    );
    return withoutTip;
  }
  return extractedAmount;
}

/**
 * Do the line items carrying `rate` reproduce the printed group total?
 *
 * Line item `amount` is gross on most extractions and net on some, and the
 * interpretation can differ between groups on the same receipt — so each
 * group is tested against both readings independently. That is precisely
 * the case a single global net-or-gross decision gets wrong.
 */
function rateGroupReconciles(
  group: ExtractedRateGroup,
  itemsAtRate: ExtractedLineItem[]
): boolean {
  if (itemsAtRate.length === 0) {
    return false;
  }
  const summedAmount = itemsAtRate.reduce((sum, item) => sum + item.amount, 0);
  const summedVat = itemsAtRate.reduce((sum, item) => sum + item.vatAmount, 0);
  const tolerance = amountTolerance(group.gross);

  return (
    Math.abs(summedAmount - group.gross) <= tolerance ||
    Math.abs(summedAmount + summedVat - group.gross) <= tolerance
  );
}

export interface ReconciliationResult {
  lineItems: ExtractedLineItem[];
  unreconciled: boolean;
  /**
   * The VAT rates whose printed group the line items failed to reproduce.
   * Empty while `unreconciled` is true means the damage could not be
   * localised and the whole document is suspect.
   */
  unreconciledRates: number[];
  /** The printed VAT summary block, once validated; null when unusable. */
  rateGroups: ExtractedRateGroup[] | null;
}

/**
 * Convert NET line items to the gross form every consumer of
 * `extractedLineItems` assumes (fork #137).
 *
 * A row's `amount` is read as gross throughout: UVA derivation builds a rate
 * group as `gross = amount`, `net = amount - vatAmount`, and the file view
 * shows the row as billed. Documents that itemise net and add VAT once at the
 * bottom — every outgoing invoice does — therefore have to be converted here,
 * or the file either loses its VAT entirely (rows with no rate at all) or
 * silently reports a net figure as gross (rows that carry their own VAT).
 *
 * Nothing is invented. Three shapes are accepted, each proved by arithmetic the
 * document itself printed:
 *
 *  1. every row carries its own VAT, and net + VAT is what hits the document
 *     total while the raw sum does not;
 *  2. every row carries a rate but the VAT read off it was the gross reading,
 *     so re-reading it as VAT on top of a net row is what closes;
 *  3. no row carries a rate at all, the document states a single top-level
 *     rate, and grossing the rows up at exactly that rate hits the total.
 *
 * A mixed bag (some rows rated, some not) is a structural disagreement rather
 * than a net/gross reading, and is left to the caller to flag. So is any case
 * where none of the three closes: this returns null and the document goes down
 * the ordinary reconciliation path unchanged.
 *
 * The rounding residual (at most a few cents, since the gate is the tolerance)
 * lands on the largest row, so the converted rows sum to the document total
 * exactly rather than to within a cent of it.
 */
function grossUpNetLineItems(
  lineItems: ExtractedLineItem[],
  extractedAmount: number,
  documentVatPercent: number | null | undefined
): ExtractedLineItem[] | null {
  const netSum = lineItems.reduce((sum, item) => sum + item.amount, 0);
  if (netSum <= 0 || netSum >= extractedAmount) {
    return null;
  }

  const allRated = lineItems.every((item) => item.vatPercent !== null);
  const noneRated = lineItems.every((item) => item.vatPercent === null && item.vatAmount === 0);

  // Candidate readings of "the VAT that sits on top of these rows", tried in
  // order of how much of it the document actually stated.
  const candidates: Array<{ vats: number[]; fallbackRate: number | null }> = [];
  if (allRated) {
    candidates.push({ vats: lineItems.map((item) => item.vatAmount), fallbackRate: null });
    candidates.push({
      vats: lineItems.map((item) => Math.round((item.amount * (item.vatPercent as number)) / 100)),
      fallbackRate: null,
    });
  } else if (
    noneRated &&
    typeof documentVatPercent === "number" &&
    Number.isFinite(documentVatPercent) &&
    documentVatPercent > 0
  ) {
    candidates.push({
      vats: lineItems.map((item) => Math.round((item.amount * documentVatPercent) / 100)),
      fallbackRate: documentVatPercent,
    });
  }

  let largest = 0;
  for (let i = 1; i < lineItems.length; i++) {
    if (lineItems[i].amount > lineItems[largest].amount) {
      largest = i;
    }
  }

  for (const candidate of candidates) {
    const vats = [...candidate.vats];
    const vatSum = vats.reduce((sum, vat) => sum + vat, 0);
    if (vatSum <= 0) continue;
    if (Math.abs(netSum + vatSum - extractedAmount) > amountTolerance(extractedAmount)) continue;

    vats[largest] += extractedAmount - (netSum + vatSum);
    if (vats.some((vat) => vat < 0)) continue;

    return lineItems.map((item, i) => ({
      ...item,
      vatPercent: item.vatPercent ?? candidate.fallbackRate,
      vatAmount: vats[i],
      amount: item.amount + vats[i],
    }));
  }

  return null;
}

export function reconcileLineItemsWithDocumentTotal(
  lineItems: ExtractedLineItem[],
  extractedAmount: number | null | undefined,
  rateGroups?: ExtractedRateGroup[] | null,
  documentVatPercent?: number | null
): ReconciliationResult {
  const validatedGroups = validateRateGroups(rateGroups, extractedAmount);

  if (lineItems.length === 0) {
    return { lineItems: [], unreconciled: false, unreconciledRates: [], rateGroups: validatedGroups };
  }

  const filtered = lineItems.filter((item) =>
    item.amount > 0 && !isLikelyNonBillableLine(item.description)
  );
  const candidateLineItems = filtered.length > 0 ? filtered : lineItems;

  if (typeof extractedAmount !== "number" || !Number.isFinite(extractedAmount) || extractedAmount <= 0) {
    return {
      lineItems: candidateLineItems,
      unreconciled: false,
      unreconciledRates: [],
      rateGroups: validatedGroups,
    };
  }

  // Fork #137: the rows may be NET on a document whose total is gross. That
  // is not an extraction error — it is what an outgoing invoice prints — but
  // the rows have to be converted before anything downstream reads them.
  // Only attempted when the raw sum genuinely disagrees with the total, so a
  // document that already itemises gross is never touched.
  const rawSum = candidateLineItems.reduce((sum, item) => sum + item.amount, 0);
  if (
    Math.abs(rawSum - extractedAmount) > amountTolerance(extractedAmount) &&
    (!validatedGroups || validatedGroups.length === 0)
  ) {
    const grossedUp = grossUpNetLineItems(candidateLineItems, extractedAmount, documentVatPercent);
    if (grossedUp) {
      console.log(
        `[ExtractionCore] Line items were net (sum ${rawSum} against document total ` +
        `${extractedAmount}); converted to gross at the document's own rate.`
      );
      return {
        lineItems: grossedUp,
        unreconciled: false,
        unreconciledRates: [],
        rateGroups: null,
      };
    }
  }

  const consolidated = consolidateLineItems(candidateLineItems, extractedAmount);
  const mismatch = Math.abs(consolidated.totalAmount - extractedAmount);

  if (mismatch <= amountTolerance(extractedAmount)) {
    return {
      lineItems: candidateLineItems,
      unreconciled: false,
      unreconciledRates: [],
      rateGroups: validatedGroups,
    };
  }

  // Fork #67 (spec §6 item 2): before giving up on the whole document, try
  // to reconcile each printed rate group on its own. OCR noise lands in one
  // group; the per-group totals the receipt prints are §11-sufficient on
  // their own and can clear the groups the noise never touched.
  const perGroup = reconcilePerRateGroup(candidateLineItems, validatedGroups);
  if (perGroup) {
    if (perGroup.length === 0) {
      console.log(
        "[ExtractionCore] Document total missed by the global item sum but " +
        "every printed rate group reconciles — treating as reconciled."
      );
      return {
        lineItems: candidateLineItems,
        unreconciled: false,
        unreconciledRates: [],
        rateGroups: validatedGroups,
      };
    }
    console.warn(
      `[ExtractionCore] Line items mismatch document total by ${mismatch} cents; ` +
      `localised to rate group(s) ${perGroup.join(", ")}%. Keeping items and ` +
      "flagging only those rates."
    );
    return {
      lineItems: candidateLineItems,
      unreconciled: true,
      unreconciledRates: perGroup,
      rateGroups: validatedGroups,
    };
  }

  // Fork #64 (spec §6): keep the extracted items and flag the file instead
  // of destroying them with a single document-rate fallback line — the old
  // behavior collapsed exactly the multi-rate receipts the UVA calculation
  // needs. Downstream, an unreconciled file is never trusted for VAT
  // derivation (review bucket), but a human can repair one line instead of
  // re-keying the whole receipt.
  console.warn(
    `[ExtractionCore] Line items mismatch document total by ${mismatch} cents ` +
    `(lineItems=${consolidated.totalAmount}, extractedAmount=${extractedAmount}). ` +
    `Keeping items and flagging lineItemsUnreconciled.`
  );

  return {
    lineItems: candidateLineItems,
    unreconciled: true,
    unreconciledRates: [],
    rateGroups: validatedGroups,
  };
}

/**
 * Per-rate-group reconciliation, or null when the document does not
 * support it — no validated printed block, an item without a rate, or an
 * item at a rate the printed block never mentions. Those are structural
 * disagreements between the two readings of the document, not localised
 * OCR noise, so the caller falls back to flagging the whole document.
 *
 * Returns the failing rates; an empty array means every group reconciled.
 */
function reconcilePerRateGroup(
  lineItems: ExtractedLineItem[],
  validatedGroups: ExtractedRateGroup[] | null
): number[] | null {
  if (!validatedGroups || validatedGroups.length === 0) {
    return null;
  }
  if (lineItems.some((item) => item.vatPercent === null)) {
    return null;
  }

  const groupRates = new Set(validatedGroups.map((g) => g.rate));
  if (lineItems.some((item) => !groupRates.has(item.vatPercent as number))) {
    return null;
  }

  return validatedGroups
    .filter((group) => !rateGroupReconciles(
      group,
      lineItems.filter((item) => item.vatPercent === group.rate)
    ))
    .map((group) => group.rate);
}

/** Document-level totals implied by the printed VAT summary block. */
function rateGroupTotals(groups: ExtractedRateGroup[]): {
  totalVatAmount: number;
  consolidatedVatPercent: number | null;
} {
  return {
    totalVatAmount: groups.reduce((sum, g) => sum + g.vat, 0),
    consolidatedVatPercent: groups.length === 1 ? groups[0].rate : null,
  };
}

/**
 * Run extraction for a file and save results to Firestore.
 * This is the shared core logic used by both extractFileData and retryExtraction.
 *
 * Two-phase process for real-time loading states:
 * 1. Classification phase: Determine if document is an invoice → save classificationComplete
 * 2. Extraction phase: Extract data from invoice → save extractionComplete
 */
export async function runExtraction(
  fileId: string,
  fileData: Record<string, unknown>,
  options: ExtractionOptions
): Promise<{ success: boolean; duration: number }> {
  const t0 = Date.now();
  const fileRef = db.collection("files").doc(fileId);

  // Download file from Firebase Storage
  const storagePath = fileData.storagePath as string;
  if (!storagePath) {
    throw new Error("No storage path found for file");
  }

  const storage = getStorage();
  const bucket = storage.bucket();
  const file = bucket.file(storagePath);

  const t1 = Date.now();
  const [fileBuffer] = await file.download();
  const t2 = Date.now();
  console.log(`[+${t2 - t0}ms] Downloaded file: ${fileBuffer.length} bytes (download took ${t2 - t1}ms)`);

  // Get provider and model config
  const provider = getDefaultProvider();
  const geminiModel = options.geminiModel || process.env.GEMINI_MODEL || MODELS.geminiLite;
  const userId = fileData.userId as string;
  console.log(`[+${Date.now() - t0}ms] Starting ${provider} extraction (model: ${geminiModel})`);

  // ============================================================
  // PHASE 1: Classification (unless skipped by user override)
  // ============================================================
  if (!options.skipClassification && provider === "gemini") {
    const { classifyDocument, DEFAULT_GEMINI_MODEL } = await import("./geminiParser");
    type GeminiModel = import("./geminiParser").GeminiModel;
    const model = (geminiModel || DEFAULT_GEMINI_MODEL) as GeminiModel;

    console.log(`[+${Date.now() - t0}ms] Phase 1: Classification...`);
    const tClassify = Date.now();
    const classification = await classifyDocument(fileBuffer, fileData.fileType as string, model);
    console.log(`[+${Date.now() - t0}ms] Classification complete (took ${Date.now() - tClassify}ms): isInvoice=${classification.isInvoice}`);

    // Log classification token usage
    if (classification.usage && userId) {
      await logAIUsage(userId, {
        function: "classification",
        model: classification.usage.model,
        inputTokens: classification.usage.inputTokens,
        outputTokens: classification.usage.outputTokens,
        metadata: { fileId },
      });
    }

    // Save classification result immediately (enables "Analyzing..." → result transition)
    await fileRef.update({
      classificationComplete: true,
      isNotInvoice: !classification.isInvoice,
      notInvoiceReason: classification.isInvoice ? null : (classification.reason || "Not an invoice"),
      updatedAt: Timestamp.now(),
    });
    console.log(`[+${Date.now() - t0}ms] Classification saved to Firestore`);

    // If not an invoice, we're done - no extraction needed
    if (!classification.isInvoice) {
      // Clear any existing extracted data and mark extraction complete
      await fileRef.update({
        extractionComplete: true,
        extractionError: null,
        extractionConfidence: Math.round(classification.confidence * 100),
        extractedDate: null,
        extractedAmount: null,
        extractedCurrency: null,
        extractedVatPercent: null,
        extractedVatAmount: null,
        extractedLineItems: null,
        extractedRateGroups: null,
        lineItemsUnreconciled: false,
        lineItemsUnreconciledRates: null,
        vatSourceDowngraded: false,
        vatFieldsPreserved: false,
        extractedPartner: null,
        extractedVatId: null,
        extractedIban: null,
        extractedAddress: null,
        extractedWebsite: null,
        extractedRaw: null,
        extractedAdditionalFields: null,
        extractedSelfDesignation: null,
        extractedInvoiceNumber: null,
        ...documentTypeFields(classifyDocumentType({ grossTotal: null, isNotInvoice: true })),
        // Every printed rate was just cleared, so there is nothing left to
        // review (#203).
        ...vatRateReviewFields({ ratesOutsideSet: [], needsReview: false }),
        // Nor a direction: a document that is not a financial document has
        // none to hold, so any flag it carried from an earlier pass goes (#233).
        ...directionReviewFields({
          needsReview: false,
          reason: null,
          conflictingTransactionIds: [],
          suggestedDirection: null,
        }),
        extractedText: "(classification only - not an invoice)",
        extractedFields: [],
        updatedAt: Timestamp.now(),
      });
      console.log(`[+${Date.now() - t0}ms] DONE - Not an invoice, skipping extraction`);
      return { success: true, duration: Date.now() - t0 };
    }
  } else if (options.skipClassification) {
    // User override - mark classification as complete (it's an invoice)
    await fileRef.update({
      classificationComplete: true,
      isNotInvoice: false,
      notInvoiceReason: null,
      updatedAt: Timestamp.now(),
    });
    console.log(`[+${Date.now() - t0}ms] Skip-Classification: User override, treating as invoice`);
  }

  // ============================================================
  // PHASE 2: Extraction (document is confirmed to be an invoice)
  // ============================================================
  console.log(`[+${Date.now() - t0}ms] Phase 2: Extraction...`);
  const t3 = Date.now();
  const result = await extractDocument(fileBuffer, fileData.fileType as string, {
    provider,
    anthropicApiKey: options.anthropicApiKey,
    geminiModel,
    skipClassification: true, // Already classified above
  });
  const t4 = Date.now();

  console.log(`[+${t4 - t0}ms] Extraction complete (${result.provider}) - API took ${t4 - t3}ms`, {
    textLength: result.text.length,
    date: result.extracted.date,
    amount: result.extracted.amount,
    partner: result.extracted.partner,
    confidence: result.extracted.confidence,
    isNotInvoice: result.isNotInvoice,
  });

  // Log extraction token usage
  if (result.usage && userId) {
    await logAIUsage(userId, {
      function: "extraction",
      model: result.usage.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      metadata: { fileId },
    });
  }

  // Determine counterparty and invoice direction based on user data
  let invoiceDirection: InvoiceDirection = "unknown";
  let matchedUserAccount: "issuer" | "recipient" | null = null;
  let recipientIdentityMatch: RecipientIdentity = "unknown";
  let counterparty: ExtractedEntity | null = null;

  // Get extracted entities (from Gemini) or null (from legacy Claude parser)
  const extractedIssuer = result.extracted.issuer;
  const extractedRecipient = result.extracted.recipient;

  if (userId && !result.isNotInvoice) {
    const userData = await getUserData(userId);
    const sourceIbans = await getSourceIbans(userId);

    console.log(`[+${Date.now() - t0}ms] Determining counterparty...`);
    console.log(`  [CounterpartyMatch] Issuer: ${extractedIssuer?.name || "(none)"}, VAT: ${extractedIssuer?.vatId || "(none)"}`);
    console.log(`  [CounterpartyMatch] Recipient: ${extractedRecipient?.name || "(none)"}, VAT: ${extractedRecipient?.vatId || "(none)"}`);

    // Use new determineCounterparty if we have entity data
    if (extractedIssuer || extractedRecipient) {
      // Which lane matched is the first thing to look at when a document lands
      // on the wrong direction, so log it before deciding.
      if (userData) {
        for (const [side, entity] of [
          ["Issuer", extractedIssuer],
          ["Recipient", extractedRecipient],
        ] as const) {
          const match = matchEntityToIdentity(entity, userData, sourceIbans);
          console.log(
            match
              ? `  [CounterpartyMatch] ${side} is the user via ${match.lane}: "${match.entityValue}" ~ "${match.identityValue}"`
              : `  [CounterpartyMatch] ${side} is not the user`
          );
        }
      } else {
        console.log("  [CounterpartyMatch] No user data configured, defaulting to issuer");
      }

      const counterpartyResult = determineCounterparty(
        extractedIssuer,
        extractedRecipient,
        userData,
        sourceIbans
      );
      counterparty = counterpartyResult.counterparty;
      matchedUserAccount = counterpartyResult.matchedUserAccount;
      invoiceDirection = counterpartyResult.invoiceDirection;
      recipientIdentityMatch = counterpartyResult.recipientIdentityMatch;
      console.log(`[+${Date.now() - t0}ms] Counterparty: "${counterparty?.name || "(none)"}", matchedUserAccount: ${matchedUserAccount}, direction: ${invoiceDirection}`);
    } else {
      // Fall back to legacy direction detection if no entities available
      invoiceDirection = determineInvoiceDirection(result.extracted.partner, userData);
      console.log(`[+${Date.now() - t0}ms] (Legacy) Invoice direction: ${invoiceDirection} (partner: "${result.extracted.partner}")`);
    }
  }

  // Build update data for Firestore
  const updateData: Record<string, unknown> = {
    extractedText: result.text,
    extractionConfidence: Math.round(result.extracted.confidence * 100),
    extractionProvider: result.provider,
    extractionComplete: true,
    extractionError: null,
    extractedFields: [], // Bounding box overlays removed - using text search instead
    invoiceDirection,
    matchedUserAccount,
    // #229: whether the recipient this document names is the user, decided
    // here where the identity data is loaded and read by the § 11 classifier
    // below. The legacy no-entity path leaves it "unknown", which is honest:
    // that path never looked at a recipient at all.
    recipientIdentityMatch,
    // Store extracted entities for future re-calculation
    extractedIssuer: extractedIssuer || null,
    extractedRecipient: extractedRecipient || null,
    // Ensure classificationComplete is set (for vision-claude provider which doesn't have separate classification)
    classificationComplete: true,
    isNotInvoice: false, // If we got here, it's confirmed to be an invoice
    notInvoiceReason: null,
    updatedAt: Timestamp.now(),
  };

  // Handle "not an invoice" classification
  if (result.isNotInvoice) {
    updateData.isNotInvoice = true;
    updateData.notInvoiceReason = result.notInvoiceReason || "Not an invoice";
    // Clear any hallucinated extracted data for non-invoices
    updateData.extractedDate = null;
    updateData.extractedAmount = null;
    updateData.extractedTipAmount = null;
    updateData.extractedCurrency = null;
    updateData.extractedVatPercent = null;
    updateData.extractedVatAmount = null;
    updateData.extractedLineItems = null;
    updateData.extractedRateGroups = null;
    updateData.lineItemsUnreconciled = false;
    updateData.lineItemsUnreconciledRates = null;
    updateData.vatSourceDowngraded = false;
    updateData.vatFieldsPreserved = false;
    updateData.extractedPartner = null;
    updateData.extractedVatId = null;
    updateData.extractedIban = null;
    updateData.extractedAddress = null;
    updateData.extractedWebsite = null;
    updateData.extractedRaw = null;
    updateData.extractedAdditionalFields = null;
    updateData.extractedSelfDesignation = null;
    updateData.extractedInvoiceNumber = null;
    console.log(`[+${Date.now() - t0}ms] Classified as NOT an invoice: ${result.notInvoiceReason}`);
  } else {
    // Add extracted fields if found
    const extracted = result.extracted;

    if (extracted.date) {
      // Parse ISO date string to Timestamp
      const dateParts = extracted.date.split("-");
      if (dateParts.length === 3) {
        const date = new Date(
          parseInt(dateParts[0]),
          parseInt(dateParts[1]) - 1,
          parseInt(dateParts[2])
        );
        updateData.extractedDate = Timestamp.fromDate(date);
      }
    }

    if (extracted.currency) {
      updateData.extractedCurrency = extracted.currency;
    }

    // Transcribed, not inferred (#104). Written unconditionally — a document
    // that prints no heading and no invoice number must record that as an
    // absence, or the §11 classifier reads the record as merely legacy.
    updateData.extractedSelfDesignation = extracted.selfDesignation ?? null;
    updateData.extractedInvoiceNumber = extracted.invoiceNumber ?? null;

    // #172: the printed Trinkgeld is its own figure and stays out of every
    // total below. Written unconditionally, like the §11 transcriptions — a
    // document that prints no tip line must record that as an absence rather
    // than leave a stale figure from an earlier pass standing.
    const tipAmount = extracted.tipAmount ?? null;
    updateData.extractedTipAmount = tipAmount;
    const documentTotal = totalWithoutPrintedTip(
      extracted.amount,
      tipAmount,
      extracted.rateGroups
    );

    const normalizedLineItems = normalizeExtractedLineItems(extracted.lineItems);
    if (normalizedLineItems.length > 0) {
      const reconciled = reconcileLineItemsWithDocumentTotal(
        normalizedLineItems,
        documentTotal,
        extracted.rateGroups,
        extracted.vatPercent
      );
      updateData.extractedLineItems = reconciled.lineItems;
      updateData.extractedRateGroups = reconciled.rateGroups;
      updateData.lineItemsUnreconciled = reconciled.unreconciled;
      updateData.lineItemsUnreconciledRates =
        reconciled.unreconciledRates.length > 0 ? reconciled.unreconciledRates : null;

      if (reconciled.unreconciled) {
        // The item sum contradicts the document total — keep the document's
        // own top-level extraction and let the flagged items wait for a
        // human repair (fork #64, spec §6).
        updateData.extractedAmount = documentTotal;
        if (reconciled.rateGroups) {
          // Fork #67: the printed VAT summary is a SECOND reading of the
          // document, not a derivation from the broken rows — it survives
          // a line-item failure and still carries the document's VAT.
          const totals = rateGroupTotals(reconciled.rateGroups);
          updateData.extractedVatAmount = totals.totalVatAmount;
          updateData.extractedVatPercent = totals.consolidatedVatPercent ?? extracted.vatPercent;
        } else {
          updateData.extractedVatAmount = null;
          updateData.extractedVatPercent = extracted.vatPercent;
        }
      } else if (reconciled.rateGroups) {
        // Both readings agree: prefer the printed block's VAT, which is one
        // transcribed number per rate rather than a sum of N item rows.
        const consolidated = consolidateLineItems(reconciled.lineItems, documentTotal);
        const totals = rateGroupTotals(reconciled.rateGroups);
        updateData.extractedAmount = consolidated.totalAmount;
        updateData.extractedVatAmount = totals.totalVatAmount;
        updateData.extractedVatPercent = totals.consolidatedVatPercent;
      } else {
        const consolidated = consolidateLineItems(reconciled.lineItems, documentTotal);
        updateData.extractedAmount = consolidated.totalAmount;
        updateData.extractedVatAmount = consolidated.totalVatAmount;
        updateData.extractedVatPercent = consolidated.consolidatedVatPercent;
      }
    } else {
      // No itemisation — but a receipt can still print its VAT summary
      // block, and that alone is a §11-sufficient record (fork #67).
      const validatedGroups = validateRateGroups(extracted.rateGroups, documentTotal);
      updateData.extractedLineItems = null;
      updateData.extractedRateGroups = validatedGroups;
      updateData.lineItemsUnreconciled = false;
      updateData.lineItemsUnreconciledRates = null;
      updateData.extractedAmount = documentTotal;
      if (validatedGroups) {
        const totals = rateGroupTotals(validatedGroups);
        updateData.extractedVatAmount = totals.totalVatAmount;
        updateData.extractedVatPercent = totals.consolidatedVatPercent ?? extracted.vatPercent;
      } else {
        updateData.extractedVatAmount = null;
        updateData.extractedVatPercent = extracted.vatPercent;
      }
    }

    // Use counterparty data if available, otherwise fall back to legacy extracted.partner
    // This ensures extractedPartner is always the counterparty (not the user's own company)
    if (counterparty) {
      // Use counterparty entity data
      if (counterparty.name) {
        updateData.extractedPartner = counterparty.name;
      }
      if (counterparty.vatId) {
        updateData.extractedVatId = counterparty.vatId;
      }
      if (counterparty.iban) {
        updateData.extractedIban = counterparty.iban;
      }
      if (counterparty.address) {
        updateData.extractedAddress = counterparty.address;
      }
      if (counterparty.website) {
        updateData.extractedWebsite = counterparty.website;
      }
    } else {
      // Fall back to legacy extracted fields (from Claude parser or when counterparty detection fails)
      if (extracted.partner) {
        updateData.extractedPartner = extracted.partner;
      }
      if (extracted.vatId) {
        updateData.extractedVatId = extracted.vatId;
      }
      if (extracted.iban) {
        updateData.extractedIban = extracted.iban;
      }
      if (extracted.address) {
        updateData.extractedAddress = extracted.address;
      }
      if (extracted.website) {
        updateData.extractedWebsite = extracted.website;
      }
    }

    // Store raw text values for PDF search/highlight
    if (result.extractedRaw) {
      // Update raw text to use counterparty's raw values if available
      const rawData = { ...result.extractedRaw };

      // If we determined counterparty from entities, use the appropriate raw text
      if (counterparty && result.extractedRaw) {
        const isCounterpartyIssuer = counterparty === extractedIssuer;
        const counterpartyRaw = isCounterpartyIssuer
          ? result.extractedRaw.issuer
          : result.extractedRaw.recipient;

        if (counterpartyRaw) {
          // Override partner raw fields with counterparty's raw values
          rawData.partner = counterpartyRaw.name || rawData.partner;
          rawData.vatId = counterpartyRaw.vatId || rawData.vatId;
          rawData.iban = counterpartyRaw.iban || rawData.iban;
          rawData.address = counterpartyRaw.address || rawData.address;
          rawData.website = counterpartyRaw.website || rawData.website;
        }
      }

      updateData.extractedRaw = rawData;
    }

    // Store additional fields extracted from the document
    if (result.additionalFields && result.additionalFields.length > 0) {
      updateData.extractedAdditionalFields = result.additionalFields;
      console.log(`[+${Date.now() - t0}ms] Stored ${result.additionalFields.length} additional fields`);
    }
  }

  // Fork #137: never let a weaker pass overwrite a stronger record's VAT.
  // Re-extraction is destructive by default, and a pass that comes back with
  // no derivable VAT source used to replace one that had it, silently and
  // invisibly.
  const vatGuard = applyVatDowngradeGuard(fileData, updateData);
  if (vatGuard.downgraded) {
    console.warn(
      `[ExtractionCore] VAT evidence downgraded ${vatGuard.from} -> ${vatGuard.to} for ${fileId}. ` +
      (vatGuard.preserved
        ? "Kept the previous VAT fields; the rest of the extraction was written."
        : "Document total moved too, so the previous VAT fields do not describe this reading — " +
          "wrote the weaker record and flagged it for review.")
    );
  }

  // §11 classification runs on the record as it will actually be stored —
  // after the VAT guard, which can keep the PREVIOUS VAT fields and so change
  // the answer. Persisted rather than recomputed at read time, so two readers
  // cannot disagree about the same document (#104).
  const storedRecord = { ...fileData, ...updateData };
  Object.assign(updateData, documentTypeFields(classifyFileRecord(storedRecord)));

  // #203: the same pass answers "does this document print a rate Austria does
  // not have". Reading it off the stored record rather than the raw parse means
  // the VAT guard above has already decided which figures survive, so the flag
  // describes the rates the derivation will actually see.
  const rateReview = reviewFileRecordVatRates(storedRecord);
  Object.assign(updateData, vatRateReviewFields(rateReview));

  // #233: extraction is where a file's direction is decided, so it is also
  // where the direction can start disagreeing with the transactions the file
  // is already attached to. Folded into this write rather than run after it —
  // the record is in hand and a second write would re-fire every file trigger.
  Object.assign(updateData, await computeDirectionReviewFields(db, storedRecord));
  if (rateReview.needsReview) {
    console.warn(
      `[ExtractionCore] ${fileId} prints VAT rate(s) outside the Austrian set: ` +
      `${rateReview.ratesOutsideSet.join(", ")}. Flagged for review.`
    );
  }
  console.log(
    `[+${Date.now() - t0}ms] Document type: ${updateData.documentType} ` +
    `(${(updateData.documentTypeBasis as { reason?: string })?.reason})`
  );

  // Save to Firestore
  const t6 = Date.now();
  const documentTypeChanged = fileData.documentType !== updateData.documentType;
  await db.collection("files").doc(fileId).update(updateData);

  // A file's classification changing is invisible to onTransactionUpdate —
  // nothing on the transaction document moved — so the propagation happens
  // here, through the same derivation the trigger uses (#104). Only on an
  // actual change: re-extraction that lands on the same type owes no writes.
  const connectedTransactionIds = (fileData.transactionIds as string[] | undefined) ?? [];
  if (documentTypeChanged && connectedTransactionIds.length > 0) {
    await syncDocumentationStateForTransactions(db, connectedTransactionIds);
  }

  const tEnd = Date.now();
  console.log(`[+${tEnd - t0}ms] DONE - Firestore write took ${tEnd - t6}ms | Total: ${tEnd - t0}ms`);

  return { success: true, duration: tEnd - t0 };
}
