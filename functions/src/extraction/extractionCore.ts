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
  createExtractionService,
  extractionProvenanceFields,
} from "./documentExtractor";
import { logAIUsage } from "../utils/ai-usage-logger";
import { MODELS } from "../utils/models";

const db = getFirestore();

/** The stored reason for a File its RKSV Code marks as a training receipt (#166). */
export const RKSV_TRAINING_RECEIPT_REASON =
  "RKSV training receipt (Trainingsbeleg): the till marks it as not a sale";

import { ExtractedEntity, ExtractedLineItem } from "../types/extraction";
import type { RecipientIdentity } from "../matching/recipientIdentity";
import {
  determineCounterparty,
  getAllIdentityNames,
  identityNameMatches,
  matchEntityToIdentity,
  type InvoiceDirection,
  type UserIdentityData,
} from "../utils/identity-matcher";
import {
  consolidateLineItems,
  rateGroupTotals,
  reconcileLineItemsWithDocumentTotal,
  singleRateDocumentVat,
  totalWithoutPrintedTip,
  validateRateGroups,
} from "./lineItemReconciliation";
import { rateFromDocumentVat } from "./taxFacts";
import { rateGroupsFromRksv, rksvReceiptKindOf } from "./qrCodes";
// Re-exported so existing importers (tests included) keep their path; the
// implementations moved to lineItemReconciliation.ts, which stays free of the
// extraction pipeline's imports so the correction path can share them (#203).
export {
  reconcileLineItemsWithDocumentTotal,
  totalWithoutPrintedTip,
  validateRateGroups,
} from "./lineItemReconciliation";
export type { ReconciliationResult } from "./lineItemReconciliation";
import { pdfPageCount, splitSuggestionFor } from "../files/splitSuggestion";
import { applyFactChange } from "../fileFacts/applyFactChange";
import type {
  ExtractedCounterparty,
  ExtractedFacts,
  ExtractionReading,
} from "../fileFacts/extractionReading";

/**
 * Options for running extraction
 */
export interface ExtractionOptions {
  /** Skip two-phase classification (user has overridden AI classification) */
  skipClassification?: boolean;
  /** Gemini model to use */
  geminiModel?: string;
  /**
   * The forced re-extraction: overwrite a Hand Correction instead of being
   * refused (#184, #639). Decided per File by whoever asked for the run.
   */
  overwriteCorrections?: boolean;
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

      return {
        description: item.description?.trim() || `Item ${index + 1}`,
        vatPercent: normalizedVatPercent,
        vatAmount: normalizedVatAmount,
        amount: Math.round(item.amount),
      };
    })
    .filter((item): item is ExtractedLineItem => item !== null);
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

  // #550: the page count is what a split suggestion is checked against, and
  // what the Split dialog shows. Null for an image or an unreadable PDF.
  const pageCount = await pdfPageCount(fileBuffer);

  // Get provider and model config
  const geminiModel = options.geminiModel || process.env.GEMINI_MODEL || MODELS.geminiLite;
  const userId = fileData.userId as string;

  // #161: the one seam where the File's bytes reach an Extraction Service,
  // the built-in Gemini or the deployment's external one. Whichever answers,
  // everything below is FiBuKI's own and runs the same.
  const service = createExtractionService({
    fileBuffer,
    fileType: fileData.fileType as string,
    fileName: fileData.fileName as string | undefined,
    geminiModel,
    logUsage: async ({ unpriced, ...usage }) => {
      if (!userId) return;
      await logAIUsage(userId, { ...usage, ...(unpriced ? { unpriced } : {}), metadata: { fileId } });
    },
  });
  console.log(`[+${Date.now() - t0}ms] Starting extraction (Gemini model if built-in: ${geminiModel})`);

  // ============================================================
  // PHASE 1: Classification (unless skipped by user override)
  // ============================================================
  if (!options.skipClassification) {
    console.log(`[+${Date.now() - t0}ms] Phase 1: Classification...`);
    const tClassify = Date.now();
    const classification = await service.classify();
    console.log(`[+${Date.now() - t0}ms] Classification complete (took ${Date.now() - tClassify}ms): isInvoice=${classification.isInvoice}`);

    // Save classification result immediately (enables "Analyzing..." → result transition)
    await fileRef.update({
      classificationComplete: true,
      isNotInvoice: !classification.isInvoice,
      notInvoiceReason: classification.isInvoice ? null : (classification.reason || "Not an invoice"),
      updatedAt: Timestamp.now(),
    });
    console.log(`[+${Date.now() - t0}ms] Classification saved to Firestore`);

    // If not an invoice, we're done - no extraction needed. Every fact is
    // cleared through the File facts module, which owns that list (#639).
    if (!classification.isInvoice) {
      await writeReading(fileId, fileData, options, t0, {
        kind: "not-invoice",
        reason: classification.reason || "Not an invoice",
        run: {
          extractionComplete: true,
          extractionError: null,
          ...extractionProvenanceFields(service.provenance()),
          extractionConfidence: Math.round(classification.confidence * 100),
          extractedText: "(classification only - not an invoice)",
          extractedFields: [],
          pageCount,
          splitSuggestion: null,
        },
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
  // Already classified above, or overridden by the user. Token usage is
  // logged by the service.
  const result = await service.transcribe();
  const t4 = Date.now();

  console.log(`[+${t4 - t0}ms] Extraction complete (${result.provider}) - API took ${t4 - t3}ms`, {
    textLength: result.text.length,
    date: result.extracted.date,
    amount: result.extracted.amount,
    partner: result.extracted.partner,
    confidence: result.extracted.confidence,
    isNotInvoice: result.isNotInvoice,
  });

  // Determine counterparty and invoice direction based on user data
  let invoiceDirection: InvoiceDirection = "unknown";
  let matchedUserAccount: "issuer" | "recipient" | null = null;
  let recipientIdentityMatch: RecipientIdentity = "unknown";
  let counterparty: ExtractedEntity | null = null;

  // Get extracted entities (from Gemini) or null (from legacy Claude parser)
  const extractedIssuer = result.extracted.issuer;
  const extractedRecipient = result.extracted.recipient;
  // The Invoicing Agent is stored and nothing else: it is not offered to
  // `determineCounterparty`, so it can never become the Partner (#156,
  // ADR-0003).
  const extractedInvoicingAgent = result.extracted.invoicingAgent ?? null;

  if (userId && !result.isNotInvoice) {
    const userData = await getUserData(userId);
    const sourceIbans = await getSourceIbans(userId);

    console.log(`[+${Date.now() - t0}ms] Determining counterparty...`);
    console.log(`  [CounterpartyMatch] Issuer: ${extractedIssuer?.name || "(none)"}, VAT: ${extractedIssuer?.vatId || "(none)"}`);
    console.log(`  [CounterpartyMatch] Recipient: ${extractedRecipient?.name || "(none)"}, VAT: ${extractedRecipient?.vatId || "(none)"}`);
    if (extractedInvoicingAgent) {
      console.log(
        `  [CounterpartyMatch] Invoicing Agent: ${extractedInvoicingAgent.name || "(none)"}, ` +
        `VAT: ${extractedInvoicingAgent.vatId || "(none)"} — recorded only, never a Partner (#156)`
      );
    }

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

  // The fields of this run that are no fact of the document. The facts go to
  // the File facts module as a reading, and it writes them (#639).
  const run: Record<string, unknown> = {
    extractedText: result.text,
    extractionConfidence: Math.round(result.extracted.confidence * 100),
    // #161: which Extraction Service produced this reading.
    ...extractionProvenanceFields(service.provenance()),
    extractionComplete: true,
    extractionError: null,
    extractedFields: [], // Bounding box overlays removed - using text search instead
    classificationComplete: true,
    pageCount,
    // #550: read in the same call, stored as a suggestion only. Written on
    // every pass, so a re-extraction that reads one document clears an old
    // suggestion, and a dismissed File never gets a new one.
    splitSuggestion: splitSuggestionFor(
      result.splitSegments,
      pageCount,
      fileData.splitSuggestionDismissed === true
    ),
  };

  const counterpartyFacts: ExtractedCounterparty = {
    invoiceDirection,
    matchedUserAccount,
    // #229: whether the recipient this document names is the user, decided
    // here where the identity data is loaded and read by the § 11 classifier.
    // The legacy no-entity path leaves it "unknown", which is honest: that
    // path never looked at a recipient at all.
    recipientIdentityMatch,
    // Stored for future re-calculation
    issuer: extractedIssuer || null,
    recipient: extractedRecipient || null,
  };

  // #166: a till marks a training receipt in its RKSV Code. It is never a
  // sale, whatever the page looks like, so it gets the classifier's own "not
  // an invoice" verdict. Not when the user overrode the classification: they
  // already said this document is an invoice, and unmarking must stay possible.
  const trainingReceipt =
    !options.skipClassification &&
    !result.isNotInvoice &&
    rksvReceiptKindOf(result.extracted.qrCodes ?? []) === "training";

  let reading: ExtractionReading;

  // Handle "not an invoice" classification: the module clears any
  // hallucinated extracted data.
  if (result.isNotInvoice || trainingReceipt) {
    const reason = trainingReceipt
      ? RKSV_TRAINING_RECEIPT_REASON
      : result.notInvoiceReason || "Not an invoice";
    reading = {
      kind: "not-invoice",
      reason,
      counterparty: counterpartyFacts,
      run: { ...run, splitSuggestion: null },
    };
    console.log(`[+${Date.now() - t0}ms] Classified as NOT an invoice: ${reason}`);
  } else {
    const extracted = result.extracted;

    // #172: the printed Trinkgeld is its own figure and stays out of every
    // total below.
    const tipAmount = extracted.tipAmount ?? null;
    const documentTotal = totalWithoutPrintedTip(
      extracted.amount,
      tipAmount,
      extracted.rateGroups
    );

    // #540: the printed VAT total, stored as read.
    const documentVatAmount = extracted.documentVatAmount ?? null;

    // #540: one stored shape whatever the layout. A document that prints a
    // VAT amount and no rate ("Tax 11,25") gets the one rate that reproduces
    // that amount to the cent, and from there the same single-rate split as
    // a document that printed the rate (#511). A mixed-rate total matches no
    // single rate and stays rate-less: nothing is averaged.
    const documentVatPercent =
      extracted.vatPercent ?? rateFromDocumentVat(documentTotal, documentVatAmount);
    if (extracted.vatPercent == null && documentVatPercent != null) {
      console.log(
        `[+${Date.now() - t0}ms] Document VAT ${documentVatAmount} on ${documentTotal} ` +
        `is ${documentVatPercent}% (no rate printed)`
      );
    }
    // An RKSV code is the till's own per-rate block in machine form. Used only
    // when the page printed no block, and only when its buckets add up to the
    // document total to the cent, which a misread code does not (#540). A
    // bucket that names no single rate is decided by the printed VAT total or
    // not at all (#166).
    const rksvGroups =
      extracted.rateGroups && extracted.rateGroups.length > 0
        ? null
        : rateGroupsFromRksv(extracted.qrCodes ?? [], documentTotal, documentVatAmount);
    if (rksvGroups) {
      console.log(`[+${Date.now() - t0}ms] Rate groups read from the RKSV code: ${rksvGroups.map((g) => g.rate).join(", ")}%`);
    }
    const printedRateGroups = rksvGroups ?? extracted.rateGroups;

    const figures = readFigures(
      normalizeExtractedLineItems(extracted.lineItems),
      documentTotal,
      printedRateGroups,
      documentVatPercent,
      documentVatAmount
    );

    // Use counterparty data if available, otherwise fall back to legacy
    // extracted.partner, so the Partner is always the counterparty (not the
    // user's own company). Both sources are the same party, so a field one of
    // them lacks is not borrowed from the other (#376). Names are already
    // decoded (#299).
    const party = counterparty ?? extracted;

    const facts: ExtractedFacts = {
      ...(extracted.date ? { date: extracted.date } : {}),
      ...(extracted.currency ? { currency: extracted.currency } : {}),
      ...figures,
      tipAmount,
      documentVatAmount,
      qrCodes: extracted.qrCodes && extracted.qrCodes.length > 0 ? extracted.qrCodes : null,
      // #166: where the stored Rate Groups came from. A later reader cannot
      // otherwise tell a till-attested split from a transcribed one.
      rateGroupsSource:
        Array.isArray(figures.rateGroups) && figures.rateGroups.length > 0
          ? rksvGroups
            ? "rksvCode"
            : "document"
          : null,
      // #540: the counterparty's country decides which tax rules apply.
      country: counterparty?.country ?? null,
      partner: (counterparty ? counterparty.name : extracted.partner) || null,
      vatId: party.vatId || null,
      iban: party.iban || null,
      address: party.address || null,
      website: party.website || null,
      ...(result.extractedRaw
        ? { raw: counterpartyRawText(result.extractedRaw, counterparty, extractedIssuer) }
        : {}),
      // The rows the Due Date and Debit Date are read from (#236, #136).
      additionalFields:
        result.additionalFields && result.additionalFields.length > 0 ? result.additionalFields : null,
      // Transcribed, not inferred (#104), and written unconditionally, so a
      // document that prints no heading or number records an absence.
      selfDesignation: extracted.selfDesignation ?? null,
      invoiceNumber: extracted.invoiceNumber ?? null,
      // #564: the invoice a credit note corrects.
      referencedInvoiceNumber: extracted.referencedInvoiceNumber ?? null,
      // #571: the invoice a Receipt confirms payment for.
      paidInvoiceNumber: extracted.paidInvoiceNumber ?? null,
      // #206: the figure the document itself designates as due.
      payableAmount: extracted.payableAmount ?? null,
      // #615: the deposit, part payments or schedule the document prints.
      instalments: extracted.instalments ?? null,
      // #156: recorded only, never a Partner.
      invoicingAgent: extractedInvoicingAgent,
    };
    if (facts.additionalFields) {
      console.log(`[+${Date.now() - t0}ms] Read ${facts.additionalFields.length} additional fields`);
    }

    reading = {
      kind: "invoice",
      facts,
      counterparty: counterpartyFacts,
      repairAmbiguousFields: result.repairAmbiguousFields ?? [],
      run,
    };
  }

  const t6 = Date.now();
  await writeReading(fileId, fileData, options, t0, reading);

  const tEnd = Date.now();
  console.log(`[+${tEnd - t0}ms] DONE - Firestore write took ${tEnd - t6}ms | Total: ${tEnd - t0}ms`);

  return { success: true, duration: tEnd - t0 };
}

type Figures = Pick<
  ExtractedFacts,
  | "amount"
  | "vatAmount"
  | "vatPercent"
  | "lineItems"
  | "rateGroups"
  | "lineItemsUnreconciled"
  | "unreconciledRates"
>;

/**
 * The stored figures of one reading: the rows reconciled with the document
 * total, and the total and VAT that follow from them. This is Extraction's
 * own reading of the document; what is derived from it is the File facts
 * module's.
 */
function readFigures(
  lineItems: ExtractedLineItem[],
  documentTotal: number | null | undefined,
  printedRateGroups: Parameters<typeof reconcileLineItemsWithDocumentTotal>[2],
  documentVatPercent: number | null,
  documentVatAmount: number | null
): Figures {
  if (lineItems.length > 0) {
    const reconciled = reconcileLineItemsWithDocumentTotal(
      lineItems,
      documentTotal,
      printedRateGroups,
      documentVatPercent
    );
    const rows = {
      lineItems: reconciled.lineItems,
      rateGroups: reconciled.rateGroups,
      lineItemsUnreconciled: reconciled.unreconciled,
      unreconciledRates: reconciled.unreconciledRates.length > 0 ? reconciled.unreconciledRates : null,
    };

    if (reconciled.unreconciled) {
      // The item sum contradicts the document total — keep the document's
      // own top-level extraction and let the flagged items wait for a human
      // repair (fork #64, spec §6).
      if (reconciled.rateGroups) {
        // Fork #67: the printed VAT summary is a SECOND reading of the
        // document, not a derivation from the broken rows — it survives a
        // line-item failure and still carries the document's VAT.
        const totals = rateGroupTotals(reconciled.rateGroups);
        return {
          ...rows,
          amount: documentTotal ?? null,
          vatAmount: totals.totalVatAmount,
          vatPercent: totals.consolidatedVatPercent ?? documentVatPercent,
        };
      }
      // #511: a single-rate document's VAT is its total at that rate,
      // whatever its rows say. Only a mixed-rate or rate-less document loses
      // its VAT with its rows, and keeps the VAT total it printed when it
      // printed one (#540).
      const singleRate = singleRateDocumentVat(reconciled.lineItems, documentTotal, documentVatPercent);
      return {
        ...rows,
        amount: documentTotal ?? null,
        vatAmount: singleRate?.vatAmount ?? documentVatAmount,
        vatPercent: documentVatPercent,
      };
    }

    const consolidated = consolidateLineItems(reconciled.lineItems, documentTotal);
    if (reconciled.rateGroups) {
      // Both readings agree: prefer the printed block's VAT, which is one
      // transcribed number per rate rather than a sum of N item rows.
      const totals = rateGroupTotals(reconciled.rateGroups);
      return {
        ...rows,
        amount: consolidated.totalAmount,
        vatAmount: totals.totalVatAmount,
        vatPercent: totals.consolidatedVatPercent,
      };
    }
    return {
      ...rows,
      amount: consolidated.totalAmount,
      vatAmount: consolidated.totalVatAmount,
      vatPercent: consolidated.consolidatedVatPercent,
    };
  }

  // No itemisation — but a receipt can still print its VAT summary block,
  // and that alone is a §11-sufficient record (fork #67).
  const validatedGroups = validateRateGroups(printedRateGroups, documentTotal);
  const rows = {
    lineItems: null,
    rateGroups: validatedGroups,
    lineItemsUnreconciled: false,
    unreconciledRates: null,
    amount: documentTotal ?? null,
  };
  if (validatedGroups) {
    const totals = rateGroupTotals(validatedGroups);
    return {
      ...rows,
      vatAmount: totals.totalVatAmount,
      vatPercent: totals.consolidatedVatPercent ?? documentVatPercent,
    };
  }
  // #540: the VAT total the document printed, when it printed one. Not
  // derived from the rate: a derivation here would be stored as if read.
  return { ...rows, vatAmount: documentVatAmount, vatPercent: documentVatPercent };
}

type RawText = NonNullable<ExtractedFacts["raw"]>;

/**
 * The raw text values for PDF search and highlight. When the counterparty
 * came from the entities, the partner's raw values are that party's own.
 */
function counterpartyRawText(
  extractedRaw: RawText,
  counterparty: ExtractedEntity | null,
  extractedIssuer: ExtractedEntity | null | undefined
): RawText {
  const rawData = { ...extractedRaw };
  if (counterparty) {
    const counterpartyRaw =
      counterparty === extractedIssuer ? extractedRaw.issuer : extractedRaw.recipient;
    if (counterpartyRaw) {
      rawData.partner = counterpartyRaw.name || rawData.partner;
      rawData.vatId = counterpartyRaw.vatId || rawData.vatId;
      rawData.iban = counterpartyRaw.iban || rawData.iban;
      rawData.address = counterpartyRaw.address || rawData.address;
      rawData.website = counterpartyRaw.website || rawData.website;
    }
  }
  return rawData;
}

/**
 * Hand one reading to the File facts module and let its applier write it
 * (#639). The module derives every field that follows from the facts, and
 * the applier re-derives the Documentation State of connected Transactions
 * when the Document Type moved (#104).
 *
 * A File that took a Hand Correction while this run was reading it is
 * refused (#184): its facts stay as the person left them. The run is still
 * finished, so the File does not wait forever, and the classification this
 * run wrote on its way is put back as the run found it.
 */
async function writeReading(
  fileId: string,
  fileData: Record<string, unknown>,
  options: ExtractionOptions,
  t0: number,
  reading: ExtractionReading
): Promise<void> {
  const applied = await applyFactChange(db, {
    fileId,
    userId: fileData.userId as string,
    change: { origin: "extraction", forced: options.overwriteCorrections === true, reading },
  });

  if (applied.refused) {
    if (applied.code === "NOT_FOUND") {
      console.warn(`[ExtractionCore] ${fileId} is gone; nothing to write`);
      return;
    }
    console.warn(`[ExtractionCore] ${fileId}: Extraction refused, nothing written. ${applied.message}`);
    await db.collection("files").doc(fileId).update({
      extractionComplete: true,
      extractionError: null,
      isNotInvoice: fileData.isNotInvoice ?? null,
      notInvoiceReason: fileData.notInvoiceReason ?? null,
      updatedAt: Timestamp.now(),
    });
    return;
  }

  const { update } = applied;
  if (update.vatSourceDowngraded === true) {
    console.warn(
      `[ExtractionCore] VAT evidence downgraded for ${fileId}. ` +
      (update.vatFieldsPreserved === true
        ? "Kept the previous VAT fields; the rest of the extraction was written."
        : "Document total moved too, so the previous VAT fields do not describe this reading — " +
          "wrote the weaker record and flagged it for review.")
    );
  }
  if (update.needsRepairReview === true) {
    console.warn(
      `[ExtractionCore] ${fileId} carries a repaired escape sequence in ` +
      `${(update.repairAmbiguousFields as string[]).join(", ")}; the stored text may not be ` +
      "what the document prints. Flagged for review."
    );
  }
  if (update.needsRksvCodeReview === true) {
    console.warn(
      `[ExtractionCore] ${fileId}: the printed Rate Group block and the RKSV Code ` +
      `disagree at ${(update.rksvCodeDisagreeingRates as number[]).join(", ")}%. ` +
      "Kept the printed block; flagged for review."
    );
  }
  if (update.needsVatRateReview === true) {
    console.warn(
      `[ExtractionCore] ${fileId} prints VAT rate(s) outside the Austrian set: ` +
      `${(update.vatRatesOutsideSet as number[]).join(", ")}. Flagged for review.`
    );
  }
  console.log(
    `[+${Date.now() - t0}ms] Document type: ${update.documentType} ` +
    `(${(update.documentTypeBasis as { reason?: string })?.reason})`
  );
}
