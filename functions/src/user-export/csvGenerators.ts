/**
 * CSV generation helpers for user data export.
 * Generates CSV content from Firestore documents.
 */

import { Timestamp } from "firebase-admin/firestore";

/**
 * Convert a value to CSV-safe string
 */
function csvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }

  if (Array.isArray(value)) {
    // JSON encode arrays
    return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
  }

  if (typeof value === "object") {
    // JSON encode objects
    return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
  }

  const str = String(value);
  // Escape quotes and wrap in quotes if contains comma, quote, or newline
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generate CSV from array of objects with specified columns
 */
export function generateCsv<T extends Record<string, unknown>>(
  data: T[],
  columns: Array<{ key: string; header: string }>
): string {
  // Header row
  const headerRow = columns.map((col) => col.header).join(",");

  // Data rows
  const dataRows = data.map((row) =>
    columns
      .map((col) => {
        const keys = col.key.split(".");
        let value: unknown = row;
        for (const k of keys) {
          if (value && typeof value === "object") {
            value = (value as Record<string, unknown>)[k];
          } else {
            value = undefined;
            break;
          }
        }
        return csvValue(value);
      })
      .join(",")
  );

  return [headerRow, ...dataRows].join("\n");
}

/**
 * Sources CSV columns
 */
export const sourcesColumns = [
  { key: "id", header: "id" },
  { key: "name", header: "name" },
  { key: "accountKind", header: "accountKind" },
  { key: "iban", header: "iban" },
  { key: "type", header: "type" },
  { key: "currency", header: "currency" },
  { key: "cardLast4", header: "cardLast4" },
  { key: "cardBrand", header: "cardBrand" },
  { key: "linkedSourceId", header: "linkedSourceId" },
  { key: "fieldMappings", header: "fieldMappings" },
  { key: "isActive", header: "isActive" },
  { key: "createdAt", header: "createdAt" },
  { key: "updatedAt", header: "updatedAt" },
];

/**
 * Transactions CSV columns
 */
export const transactionsColumns = [
  { key: "id", header: "id" },
  { key: "sourceId", header: "sourceId" },
  { key: "date", header: "date" },
  { key: "amount", header: "amount" },
  { key: "currency", header: "currency" },
  { key: "name", header: "name" },
  { key: "description", header: "description" },
  { key: "partner", header: "partner" },
  { key: "reference", header: "reference" },
  { key: "partnerIban", header: "partnerIban" },
  { key: "dedupeHash", header: "dedupeHash" },
  { key: "isComplete", header: "isComplete" },
  { key: "fileIds", header: "fileIds" },
  { key: "rejectedFileIds", header: "rejectedFileIds" },
  { key: "partnerId", header: "partnerId" },
  { key: "partnerType", header: "partnerType" },
  { key: "partnerMatchConfidence", header: "partnerMatchConfidence" },
  { key: "partnerMatchedBy", header: "partnerMatchedBy" },
  { key: "noReceiptCategoryId", header: "noReceiptCategoryId" },
  { key: "noReceiptCategoryTemplateId", header: "noReceiptCategoryTemplateId" },
  { key: "noReceiptCategoryMatchedBy", header: "noReceiptCategoryMatchedBy" },
  { key: "vatRate", header: "vatRate" },
  { key: "vatAmount", header: "vatAmount" },
  { key: "_original.date", header: "_original_date" },
  { key: "_original.amount", header: "_original_amount" },
  { key: "_original.rawRow", header: "_original_rawRow" },
  { key: "importJobId", header: "importJobId" },
  { key: "csvRowIndex", header: "csvRowIndex" },
  { key: "createdAt", header: "createdAt" },
  { key: "updatedAt", header: "updatedAt" },
];

/**
 * Files CSV columns
 */
export const filesColumns = [
  { key: "id", header: "id" },
  { key: "fileName", header: "fileName" },
  { key: "fileType", header: "fileType" },
  { key: "fileSize", header: "fileSize" },
  { key: "storagePath", header: "storagePath" },
  { key: "contentHash", header: "contentHash" },
  { key: "sourceType", header: "sourceType" },
  { key: "extractedDate", header: "extractedDate" },
  { key: "extractedAmount", header: "extractedAmount" },
  { key: "extractedCurrency", header: "extractedCurrency" },
  { key: "extractedPartner", header: "extractedPartner" },
  { key: "extractedVatId", header: "extractedVatId" },
  { key: "extractedIban", header: "extractedIban" },
  { key: "extractedIssuer", header: "extractedIssuer" },
  { key: "extractedRecipient", header: "extractedRecipient" },
  { key: "extractionConfidence", header: "extractionConfidence" },
  { key: "extractionComplete", header: "extractionComplete" },
  { key: "transactionIds", header: "transactionIds" },
  { key: "partnerId", header: "partnerId" },
  { key: "partnerType", header: "partnerType" },
  { key: "partnerMatchedBy", header: "partnerMatchedBy" },
  { key: "isNotInvoice", header: "isNotInvoice" },
  { key: "notInvoiceReason", header: "notInvoiceReason" },
  { key: "invoiceDirection", header: "invoiceDirection" },
  { key: "deletedAt", header: "deletedAt" },
  { key: "uploadedAt", header: "uploadedAt" },
  { key: "createdAt", header: "createdAt" },
  { key: "updatedAt", header: "updatedAt" },
];

/**
 * Partners CSV columns
 */
export const partnersColumns = [
  { key: "id", header: "id" },
  { key: "name", header: "name" },
  { key: "aliases", header: "aliases" },
  { key: "globalPartnerId", header: "globalPartnerId" },
  { key: "vatId", header: "vatId" },
  { key: "viesVerified", header: "viesVerified" },
  { key: "ibans", header: "ibans" },
  { key: "website", header: "website" },
  { key: "street", header: "street" },
  { key: "city", header: "city" },
  { key: "postalCode", header: "postalCode" },
  { key: "country", header: "country" },
  { key: "notes", header: "notes" },
  { key: "defaultCategoryId", header: "defaultCategoryId" },
  { key: "emailDomains", header: "emailDomains" },
  { key: "learnedPatterns", header: "learnedPatterns" },
  { key: "fileSourcePatterns", header: "fileSourcePatterns" },
  { key: "manualRemovals", header: "manualRemovals" },
  { key: "resolutionPreference", header: "resolutionPreference" },
  { key: "isActive", header: "isActive" },
  { key: "createdAt", header: "createdAt" },
  { key: "updatedAt", header: "updatedAt" },
];

/**
 * Categories CSV columns
 */
export const categoriesColumns = [
  { key: "id", header: "id" },
  { key: "name", header: "name" },
  { key: "nameDE", header: "nameDE" },
  { key: "color", header: "color" },
  { key: "icon", header: "icon" },
  { key: "taxCode", header: "taxCode" },
  { key: "isDeductible", header: "isDeductible" },
  { key: "parentId", header: "parentId" },
  { key: "sortOrder", header: "sortOrder" },
  { key: "isActive", header: "isActive" },
  { key: "createdAt", header: "createdAt" },
];

/**
 * NoReceiptCategories CSV columns
 */
export const noReceiptCategoriesColumns = [
  { key: "id", header: "id" },
  { key: "templateId", header: "templateId" },
  { key: "name", header: "name" },
  { key: "description", header: "description" },
  { key: "helperText", header: "helperText" },
  { key: "matchedPartnerIds", header: "matchedPartnerIds" },
  { key: "learnedPatterns", header: "learnedPatterns" },
  { key: "manualRemovals", header: "manualRemovals" },
  { key: "transactionCount", header: "transactionCount" },
  { key: "isActive", header: "isActive" },
  { key: "createdAt", header: "createdAt" },
  { key: "updatedAt", header: "updatedAt" },
];

/**
 * FileConnections CSV columns
 */
export const fileConnectionsColumns = [
  { key: "id", header: "id" },
  { key: "fileId", header: "fileId" },
  { key: "transactionId", header: "transactionId" },
  { key: "connectionType", header: "connectionType" },
  { key: "matchSources", header: "matchSources" },
  { key: "matchConfidence", header: "matchConfidence" },
  { key: "createdAt", header: "createdAt" },
];
