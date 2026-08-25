import {
  collection,
  query,
  where,
  getDocs,
  doc,
  updateDoc,
  writeBatch,
  Timestamp,
} from "firebase/firestore";
import { Transaction } from "@/types/transaction";
import {
  FieldMapping,
  CSVParseOptions,
  AmountFormatConfig,
  RemapPreview,
  RemapPreviewRow,
  RemapFieldChange,
} from "@/types/import";
import { OperationsContext } from "./types";
import {
  parseDate,
  findDateColumnConflict,
  getDateParserName,
} from "@/lib/import/date-parsers";
import { parseAmount, getAmountParserConfig } from "@/lib/import/amount-parsers";
import { generateDedupeHash } from "@/lib/import/deduplication";

const TRANSACTIONS_COLLECTION = "transactions";
const BATCH_SIZE = 500;

/**
 * Fields that are preserved during remapping (user-provided data)
 */
const PRESERVED_FIELDS = [
  "partnerId",
  "partnerType",
  "partnerMatchedBy",
  "partnerMatchConfidence",
  "partnerSuggestions",
  "fileIds",
  "description",
  "noReceiptCategoryId",
  "noReceiptCategoryTemplateId",
  "noReceiptCategoryMatchedBy",
  "noReceiptCategoryConfidence",
  "categorySuggestions",
  "receiptLostEntry",
  "isComplete",
] as const;

/**
 * Get all transactions for an import, indexed by csvRowIndex
 */
export async function getTransactionsByImport(
  ctx: OperationsContext,
  importJobId: string
): Promise<Map<number, Transaction>> {
  const q = query(
    collection(ctx.db, TRANSACTIONS_COLLECTION),
    where("importJobId", "==", importJobId),
    where("userId", "==", ctx.userId)
  );

  const snapshot = await getDocs(q);
  const rowToTransaction = new Map<number, Transaction>();

  for (const docSnap of snapshot.docs) {
    const tx = { id: docSnap.id, ...docSnap.data() } as Transaction;
    if (tx.csvRowIndex !== undefined) {
      rowToTransaction.set(tx.csvRowIndex, tx);
    }
  }

  return rowToTransaction;
}

/**
 * Parse a single row using the provided mappings
 */
function parseRowWithMappings(
  row: Record<string, string>,
  mappings: FieldMapping[],
  sourceIban: string | null,
  sourceId: string
): {
  date: Date | null;
  amount: number | null;
  name: string;
  partner: string | null;
  reference: string | null;
  partnerIban: string | null;
  dateFormat: string;
  amountConfig: AmountFormatConfig | null;
  error: string | null;
} {
  // Build mapping lookup
  const fieldMap = new Map<string, { column: string; format?: string }>();
  for (const mapping of mappings) {
    if (mapping.targetField) {
      fieldMap.set(mapping.targetField, {
        column: mapping.csvColumn,
        format: mapping.format,
      });
    }
  }

  // Extract values
  let dateValue: string | null = null;
  let amountValue: string | null = null;
  let nameValue: string | null = null;
  let partnerValue: string | null = null;
  let referenceValue: string | null = null;
  let partnerIbanValue: string | null = null;
  let dateFormat = "de";
  let amountFormat = "de";

  for (const [targetField, { column, format }] of fieldMap) {
    const value = row[column];
    if (!value) continue;

    switch (targetField) {
      case "date":
        dateValue = value;
        if (format) dateFormat = format;
        break;
      case "amount":
        amountValue = value;
        if (format) amountFormat = format;
        break;
      case "name":
        nameValue = value;
        break;
      case "partner":
        partnerValue = value;
        break;
      case "reference":
        referenceValue = value;
        break;
      case "partnerIban":
        partnerIbanValue = value;
        break;
    }
  }

  // Validate required fields
  if (!dateValue || !amountValue) {
    return {
      date: null,
      amount: null,
      name: nameValue || partnerValue || "",
      partner: partnerValue,
      reference: referenceValue,
      partnerIban: partnerIbanValue,
      dateFormat,
      amountConfig: null,
      error: `Missing required field: ${!dateValue ? "date" : "amount"}`,
    };
  }

  if (!nameValue && !partnerValue) {
    return {
      date: null,
      amount: null,
      name: "",
      partner: null,
      reference: referenceValue,
      partnerIban: partnerIbanValue,
      dateFormat,
      amountConfig: null,
      error: "Missing required field: description or partner",
    };
  }

  // Parse date
  const parsedDate = parseDate(dateValue, dateFormat);
  if (!parsedDate) {
    return {
      date: null,
      amount: null,
      name: nameValue || partnerValue || "",
      partner: partnerValue,
      reference: referenceValue,
      partnerIban: partnerIbanValue,
      dateFormat,
      amountConfig: null,
      error: `Invalid date: ${dateValue}`,
    };
  }

  // Parse amount
  const amountConfig = getAmountParserConfig(amountFormat);
  if (!amountConfig) {
    return {
      date: parsedDate,
      amount: null,
      name: nameValue || partnerValue || "",
      partner: partnerValue,
      reference: referenceValue,
      partnerIban: partnerIbanValue,
      dateFormat,
      amountConfig: null,
      error: `Invalid amount format: ${amountFormat}`,
    };
  }

  const parsedAmount = parseAmount(amountValue, amountConfig);
  if (parsedAmount === null) {
    return {
      date: parsedDate,
      amount: null,
      name: nameValue || partnerValue || "",
      partner: partnerValue,
      reference: referenceValue,
      partnerIban: partnerIbanValue,
      dateFormat,
      amountConfig,
      error: `Invalid amount: ${amountValue}`,
    };
  }

  return {
    date: parsedDate,
    amount: parsedAmount,
    name: nameValue || partnerValue || "",
    partner: partnerValue,
    reference: referenceValue,
    partnerIban: partnerIbanValue,
    dateFormat,
    amountConfig,
    error: null,
  };
}

/**
 * Generate a preview of what will change when remapping
 */
export async function generateRemapPreview(
  ctx: OperationsContext,
  importJobId: string,
  newMappings: FieldMapping[],
  parsedRows: Record<string, string>[],
  sourceIban: string | null,
  sourceId: string
): Promise<RemapPreview> {
  // Get existing transactions
  const existingTransactions = await getTransactionsByImport(ctx, importJobId);

  const matchedRows: RemapPreviewRow[] = [];
  const warnings: string[] = [];
  let totalChanges = 0;

  // Remapping re-reads every row with the chosen date format, so it can swap
  // day and month across a whole import just as the first import could (#70).
  // The preview is where that has to be visible.
  const dateMapping = newMappings.find((m) => m.targetField === "date");
  if (dateMapping) {
    if (!dateMapping.format) {
      warnings.push(
        `No date format is set for column "${dateMapping.csvColumn}" — dates will be read as ` +
          `${getDateParserName("de")}, which may not be the file's order.`
      );
    } else {
      const dateColumn = parsedRows
        .map((row) => row[dateMapping.csvColumn])
        .filter((value): value is string => Boolean(value));
      const conflict = findDateColumnConflict(dateColumn, dateMapping.format);

      if (conflict) {
        const offending = conflict.offendingValue ? ` (for example "${conflict.offendingValue}")` : "";
        warnings.push(
          `The date column${offending} does not match the selected format ` +
            `(${getDateParserName(dateMapping.format)})` +
            (conflict.suggestedParserId
              ? ` — it reads as ${getDateParserName(conflict.suggestedParserId)}.`
              : ` — day and month order is inconsistent across the column.`)
        );
      }
    }
  }

  // Check for row count mismatch
  if (parsedRows.length !== existingTransactions.size) {
    warnings.push(
      `Row count mismatch: CSV has ${parsedRows.length} rows, but ${existingTransactions.size} transactions exist. ` +
        `Some rows may be skipped duplicates or failed during original import.`
    );
  }

  // Process each CSV row
  for (let i = 0; i < parsedRows.length; i++) {
    const row = parsedRows[i];
    const existingTx = existingTransactions.get(i);

    if (!existingTx) {
      // No matching transaction - skip (was probably a duplicate or error row)
      continue;
    }

    // Parse the row with new mappings
    const parsed = parseRowWithMappings(row, newMappings, sourceIban, sourceId);

    if (parsed.error) {
      warnings.push(`Row ${i + 1}: ${parsed.error}`);
      continue;
    }

    // Compare with existing transaction
    const changes: RemapFieldChange[] = [];

    // Check date change
    if (parsed.date && existingTx.date) {
      const existingDate = existingTx.date.toDate();
      if (existingDate.getTime() !== parsed.date.getTime()) {
        changes.push({
          field: "date",
          oldValue: existingDate.toISOString().split("T")[0],
          newValue: parsed.date.toISOString().split("T")[0],
        });
      }
    }

    // Check amount change
    if (parsed.amount !== null && existingTx.amount !== parsed.amount) {
      changes.push({
        field: "amount",
        oldValue: existingTx.amount,
        newValue: parsed.amount,
      });
    }

    // Check name change
    if (parsed.name !== existingTx.name) {
      changes.push({
        field: "name",
        oldValue: existingTx.name,
        newValue: parsed.name,
      });
    }

    // Check partner change
    if (parsed.partner !== existingTx.partner) {
      changes.push({
        field: "partner",
        oldValue: existingTx.partner,
        newValue: parsed.partner,
      });
    }

    // Check reference change
    if (parsed.reference !== existingTx.reference) {
      changes.push({
        field: "reference",
        oldValue: existingTx.reference,
        newValue: parsed.reference,
      });
    }

    // Check partnerIban change
    if (parsed.partnerIban !== existingTx.partnerIban) {
      changes.push({
        field: "partnerIban",
        oldValue: existingTx.partnerIban,
        newValue: parsed.partnerIban,
      });
    }

    // Build list of preserved fields that have values
    const preservedFields: string[] = [];
    for (const field of PRESERVED_FIELDS) {
      const value = existingTx[field as keyof Transaction];
      if (value !== null && value !== undefined) {
        if (Array.isArray(value) && value.length > 0) {
          preservedFields.push(field);
        } else if (!Array.isArray(value)) {
          preservedFields.push(field);
        }
      }
    }

    totalChanges += changes.length;

    matchedRows.push({
      csvRowIndex: i,
      existingTransactionId: existingTx.id,
      changes,
      preservedFields,
    });
  }

  // Find orphaned transactions (exist but no matching CSV row)
  const orphanedTransactionIds: string[] = [];
  for (const [rowIndex, tx] of existingTransactions) {
    if (rowIndex >= parsedRows.length) {
      orphanedTransactionIds.push(tx.id);
    }
  }

  if (orphanedTransactionIds.length > 0) {
    warnings.push(
      `${orphanedTransactionIds.length} transaction(s) have no matching CSV row and will not be updated.`
    );
  }

  return {
    matchedRows,
    totalChanges,
    warnings,
    orphanedTransactionIds,
  };
}

/**
 * Apply remapping to existing transactions.
 * Preserves user-provided data (partners, files, descriptions, categories).
 * Updates parsed fields (date, amount, name, partner text, reference, partnerIban).
 */
export async function applyRemapping(
  ctx: OperationsContext,
  importJobId: string,
  newMappings: FieldMapping[],
  parsedRows: Record<string, string>[],
  sourceIban: string | null,
  sourceId: string,
  currency: string,
  onProgress?: (progress: number) => void
): Promise<{
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
}> {
  // Get existing transactions
  const existingTransactions = await getTransactionsByImport(ctx, importJobId);

  const updates: {
    txId: string;
    data: Partial<Transaction>;
  }[] = [];
  const errors: { row: number; message: string }[] = [];
  let skipped = 0;

  // Process each CSV row
  for (let i = 0; i < parsedRows.length; i++) {
    const row = parsedRows[i];
    const existingTx = existingTransactions.get(i);

    if (!existingTx) {
      // No matching transaction - skip
      skipped++;
      continue;
    }

    // Parse the row with new mappings
    const parsed = parseRowWithMappings(row, newMappings, sourceIban, sourceId);

    if (parsed.error || !parsed.date || parsed.amount === null) {
      errors.push({ row: i + 1, message: parsed.error || "Parse failed" });
      continue;
    }

    // Generate new dedupe hash
    const dedupeHash = await generateDedupeHash(
      parsed.date,
      parsed.amount,
      sourceIban ?? sourceId,
      parsed.reference
    );

    // Build update data (only fields that change)
    const updateData: Partial<Transaction> = {
      date: Timestamp.fromDate(parsed.date),
      amount: parsed.amount,
      currency,
      name: parsed.name,
      partner: parsed.partner,
      reference: parsed.reference,
      partnerIban: parsed.partnerIban,
      dedupeHash,
      _original: {
        date: row[newMappings.find((m) => m.targetField === "date")?.csvColumn || ""] || "",
        amount: row[newMappings.find((m) => m.targetField === "amount")?.csvColumn || ""] || "",
        rawRow: row,
      },
      updatedAt: Timestamp.now(),
    };

    updates.push({ txId: existingTx.id, data: updateData });

    if (onProgress) {
      onProgress(Math.round((i / parsedRows.length) * 50));
    }
  }

  // Batch update transactions
  let updated = 0;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = writeBatch(ctx.db);
    const chunk = updates.slice(i, i + BATCH_SIZE);

    for (const { txId, data } of chunk) {
      const docRef = doc(ctx.db, TRANSACTIONS_COLLECTION, txId);
      batch.update(docRef, data);
    }

    await batch.commit();
    updated += chunk.length;

    if (onProgress) {
      onProgress(50 + Math.round((updated / updates.length) * 50));
    }
  }

  return { updated, skipped, errors };
}

/**
 * Update the import record with new mappings after remapping
 */
export async function updateImportMappings(
  ctx: OperationsContext,
  importId: string,
  newMappings: FieldMapping[]
): Promise<void> {
  const docRef = doc(ctx.db, "imports", importId);
  await updateDoc(docRef, {
    fieldMappings: newMappings,
  });
}
