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

import { ExtractedEntity, ExtractedLineItem } from "../types/extraction";
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
import {
  consolidateLineItems,
  rateGroupTotals,
  reconcileLineItemsWithDocumentTotal,
  totalWithoutPrintedTip,
  validateRateGroups,
} from "./lineItemReconciliation";
// Re-exported so existing importers (tests included) keep their path; the
// implementations moved to lineItemReconciliation.ts, which stays free of the
// extraction pipeline's imports so the correction path can share them (#203).
export {
  reconcileLineItemsWithDocumentTotal,
  totalWithoutPrintedTip,
  validateRateGroups,
} from "./lineItemReconciliation";
export type { ReconciliationResult } from "./lineItemReconciliation";
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
        extractedPayableAmount: null,
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
    updateData.extractedPayableAmount = null;
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

    // #206: the figure the document itself designates as due, transcribed
    // beside the total rather than replacing it. Written unconditionally, so
    // "designates no figure as due" is recorded as an absence rather than
    // left indistinguishable from a record written before the field existed.
    updateData.extractedPayableAmount = extracted.payableAmount ?? null;

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
