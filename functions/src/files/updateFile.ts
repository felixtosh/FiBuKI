/**
 * Update a file's metadata
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { cancelPartnerWorkersForFile } from "../utils/cancelWorkers";
import { ExtractedLineItem } from "../types/extraction";
import { classifyFileRecord, documentTypeFields } from "../documents/adapter";
import { computeDirectionReviewFields } from "../documents/syncDirectionReview";
import { syncDocumentationStateForTransactions } from "../documents/syncDocumentationState";
import { buildCorrectionProvenance } from "./extractionProvenanceOps";

interface UpdateFileRequest {
  fileId: string;
  data: {
    // Basic metadata
    fileName?: string;
    thumbnailUrl?: string;
    // Partner assignment
    partnerId?: string | null;
    partnerType?: "user" | "global" | null;
    partnerMatchedBy?: "manual" | "suggestion" | "auto" | null;
    partnerMatchConfidence?: number | null;
    // Invoice status
    isNotInvoice?: boolean;
    notInvoiceReason?: string | null;
    invoiceDirection?: "incoming" | "outgoing" | "unknown" | null;
    // Extraction override
    extractedDate?: string | null; // ISO date string
    extractedAmount?: number | null; // in cents
    extractedPartner?: string | null;
    extractedVatPercent?: number | null;
    extractedVatAmount?: number | null; // in cents
    extractedLineItems?: ExtractedLineItem[] | null;
    extractedVatId?: string | null;
    extractedIban?: string | null;
    extractedAddress?: string | null;
  };
}

interface UpdateFileResponse {
  success: boolean;
}

function normalizeExtractedLineItems(lineItems: ExtractedLineItem[] | null | undefined): ExtractedLineItem[] {
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
    totalAmount = distanceToNetPlusVat < distanceToAsIs ? totalAmountFromNetPlusVat : totalAmountFromItems;
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

export const updateFileCallable = createCallable<
  UpdateFileRequest,
  UpdateFileResponse
>(
  { name: "updateFile" },
  async (ctx, request) => {
    const { fileId, data } = request;

    if (!fileId) {
      throw new HttpsError("invalid-argument", "fileId is required");
    }

    // Verify ownership
    const fileRef = ctx.db.collection("files").doc(fileId);
    const fileSnap = await fileRef.get();

    if (!fileSnap.exists) {
      throw new HttpsError("not-found", "File not found");
    }

    if (fileSnap.data()!.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    // Cancel running partner automation when user manually assigns or accepts suggestion
    const isManualPartnerAssignment =
      data.partnerId &&
      (data.partnerMatchedBy === "manual" || data.partnerMatchedBy === "suggestion");

    if (isManualPartnerAssignment) {
      cancelPartnerWorkersForFile(ctx.userId, fileId).catch((err) => {
        console.error("[updateFile] Failed to cancel partner workers:", err);
      });
    }

    // Build update object, converting dates and filtering undefined
    const updateData: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;

      // Handle date conversion
      if (key === "extractedDate" && value) {
        const dateObj = new Date(value as string);
        if (!isNaN(dateObj.getTime())) {
          updateData.extractedDate = Timestamp.fromDate(dateObj);
        }
      } else {
        updateData[key] = value;
      }
    }

    if (Array.isArray(data.extractedLineItems)) {
      const normalizedLineItems = normalizeExtractedLineItems(data.extractedLineItems);
      if (normalizedLineItems.length > 0) {
        const consolidated = consolidateLineItems(normalizedLineItems, data.extractedAmount);
        updateData.extractedLineItems = normalizedLineItems;
        updateData.extractedAmount = consolidated.totalAmount;
        updateData.extractedVatAmount = consolidated.totalVatAmount;
        updateData.extractedVatPercent = consolidated.consolidatedVatPercent;
      } else {
        updateData.extractedLineItems = null;
      }
    }

    // #233: the direction is a read of the document, and until now setting it
    // through this callable left everything downstream stale — the § 11
    // classification (which asks whether the user issued the document), the
    // direction review flags, and the provenance a re-extraction reads before
    // it overwrites a person's work.
    if (data.invoiceDirection !== undefined) {
      // Null stores `unknown` rather than removing the field: the review rule
      // reads an absent direction and an explicit unknown identically.
      updateData.invoiceDirection = data.invoiceDirection ?? "unknown";

      // #184: a hand-set direction is a correction like any other, so a later
      // re-extraction has to refuse the file rather than quietly undo it.
      Object.assign(
        updateData,
        buildCorrectionProvenance(fileSnap.data(), ["invoiceDirection"])
      );

      const next = { ...fileSnap.data()!, ...updateData };
      Object.assign(updateData, documentTypeFields(classifyFileRecord(next)));
      Object.assign(updateData, await computeDirectionReviewFields(ctx.db, next));
    }

    updateData.updatedAt = FieldValue.serverTimestamp();

    await fileRef.update(updateData);

    // A file's classification changing is invisible to onTransactionUpdate —
    // nothing on the transaction document moved — so the propagation happens
    // here, through the same derivation the trigger uses (#104).
    const connectedTransactionIds = (fileSnap.data()?.transactionIds as string[] | undefined) ?? [];
    if (
      updateData.documentType !== undefined &&
      updateData.documentType !== fileSnap.data()?.documentType &&
      connectedTransactionIds.length > 0
    ) {
      await syncDocumentationStateForTransactions(ctx.db, connectedTransactionIds);
    }

    console.log(`[updateFile] Updated file ${fileId}`, {
      userId: ctx.userId,
      fields: Object.keys(updateData),
    });

    return { success: true };
  }
);
