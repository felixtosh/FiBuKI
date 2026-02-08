"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Timestamp } from "firebase/firestore";
import { functions } from "@/lib/firebase/config";
import { httpsCallable } from "firebase/functions";
import { callFunction } from "@/lib/firebase/callable";
import { Transaction } from "@/types/transaction";
import { FieldMapping, CSVAnalysis, AmountFormatConfig, ImportRecord } from "@/types/import";
import { TransactionSource } from "@/types/source";
import { parseDate } from "@/lib/import/date-parsers";
import { parseAmount, getAmountParserConfig } from "@/lib/import/amount-parsers";
import {
  generateDedupeHash,
  checkDuplicatesBatch,
} from "@/lib/import/deduplication";
import { autoMatchColumns, validateMappings } from "@/lib/import/field-matcher";
import { parseCSV } from "@/lib/import/csv-parser";
import { uploadImportCSV } from "@/lib/operations";
import { computeCsvHash } from "@/lib/import/csv-hash";
import { useAuth } from "@/components/auth";

const BATCH_SIZE = 500; // Firestore batch limit
const MAPPINGS_SAVE_DEBOUNCE_MS = 1000; // Debounce time for auto-saving mappings

export type ImportStep = "upload" | "mapping" | "preview" | "importing" | "complete";

export interface ImportState {
  // Step is only used for transient states (importing, complete)
  // For navigable states, use URL params
  transientStep: "importing" | "complete" | null;
  file: File | null;
  /** Filename - stored separately for when file object is not available (draft resumption) */
  fileName: string | null;
  analysis: CSVAnalysis | null;
  mappings: FieldMapping[];
  isMatching: boolean; // True while AI is analyzing columns
  progress: number;
  results: {
    total: number;
    imported: number;
    skipped: number;
    errors: number;
    errorDetails: { row: number; message: string; rowData: Record<string, string> }[];
    overLimitCount: number;
    balanceDetected?: {
      openingBalance: number;
      openingBalanceDate: string;
      latestBalance: number;
      latestBalanceDate: string;
    };
  } | null;
  error: string | null;
  /** Full CSV content stored for re-mapping later */
  csvContent: string | null;
  /** Draft import ID - set after CSV is uploaded */
  draftImportId: string | null;
  /** True if an existing draft was found with the same CSV hash */
  existingDraftFound: boolean;
}

export interface UseImportOptions {
  /** Existing draft to resume (loaded by useDraftImport hook) */
  initialDraft?: ImportRecord | null;
  /** Pre-loaded CSV content from draft */
  initialCsvContent?: string | null;
}

export function useImport(
  source: TransactionSource | null,
  options: UseImportOptions = {}
) {
  const { initialDraft, initialCsvContent } = options;
  const { userId } = useAuth();

  // Initialize state from draft if provided
  const getInitialState = (): ImportState => {
    if (initialDraft && initialCsvContent) {
      // Parse the CSV content using saved options
      const parseOptions = initialDraft.parseOptions || {
        encoding: "UTF-8",
        delimiter: ",",
        hasHeader: true,
        skipRows: 0,
      };

      return {
        transientStep: null,
        file: null, // File object not available when resuming
        fileName: initialDraft.fileName || null,
        analysis: {
          options: parseOptions,
          headers: initialDraft.detectedHeaders || [],
          sampleRows: initialDraft.sampleRows || [],
          totalRows: initialDraft.totalRows || 0,
        },
        mappings: initialDraft.fieldMappings || [],
        isMatching: false,
        progress: 0,
        results: null,
        error: null,
        csvContent: initialCsvContent,
        draftImportId: initialDraft.id,
        existingDraftFound: false,
      };
    }

    return {
      transientStep: null,
      file: null,
      fileName: null,
      analysis: null,
      mappings: [],
      isMatching: false,
      progress: 0,
      results: null,
      error: null,
      csvContent: null,
      draftImportId: null,
      existingDraftFound: false,
    };
  };

  const [state, setState] = useState<ImportState>(getInitialState);

  // Update state when draft data becomes available (async loading)
  useEffect(() => {
    if (initialDraft && initialCsvContent && !state.draftImportId) {
      const parseOptions = initialDraft.parseOptions || {
        encoding: "UTF-8",
        delimiter: ",",
        hasHeader: true,
        skipRows: 0,
      };

      setState({
        transientStep: null,
        file: null,
        fileName: initialDraft.fileName || null,
        analysis: {
          options: parseOptions,
          headers: initialDraft.detectedHeaders || [],
          sampleRows: initialDraft.sampleRows || [],
          totalRows: initialDraft.totalRows || 0,
        },
        mappings: initialDraft.fieldMappings || [],
        isMatching: false,
        progress: 0,
        results: null,
        error: null,
        csvContent: initialCsvContent,
        draftImportId: initialDraft.id,
        existingDraftFound: false,
      });
    }
  }, [initialDraft, initialCsvContent, state.draftImportId]);

  // Debounce timer ref for auto-saving mappings
  const saveMappingsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-save mappings to draft when they change
  useEffect(() => {
    if (!state.draftImportId || state.mappings.length === 0) return;

    // Clear existing timeout
    if (saveMappingsTimeoutRef.current) {
      clearTimeout(saveMappingsTimeoutRef.current);
    }

    // Debounced save
    saveMappingsTimeoutRef.current = setTimeout(async () => {
      try {
        // Sanitize mappings for Firestore
        const sanitizedMappings = state.mappings.map((m) => ({
          csvColumn: m.csvColumn,
          targetField: m.targetField,
          confidence: m.confidence,
          userConfirmed: m.userConfirmed,
          keepAsMetadata: m.keepAsMetadata,
          format: m.format ?? null,
        }));

        await callFunction("updateDraftMappings", {
          importId: state.draftImportId,
          fieldMappings: sanitizedMappings,
        });
        console.log("[useImport] Auto-saved mappings to draft");
      } catch (error) {
        console.error("[useImport] Failed to auto-save mappings:", error);
        // Non-fatal - user can still complete import
      }
    }, MAPPINGS_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveMappingsTimeoutRef.current) {
        clearTimeout(saveMappingsTimeoutRef.current);
      }
    };
  }, [state.draftImportId, state.mappings]);

  // Returns draft import ID when file is ready to proceed to mapping step
  // Returns null if there was an error
  const handleFileAnalyzed = useCallback(
    async (
      analysis: CSVAnalysis,
      file: File
    ): Promise<{ importId: string; existingDraft: boolean } | null> => {
      if (!source || !userId) {
        setState((s) => ({ ...s, error: "Source or user not available" }));
        return null;
      }

      // Read the full CSV content
      const csvContent = await file.text();

      setState((s) => ({
        ...s,
        file,
        fileName: file.name,
        analysis,
        csvContent,
        error: null,
        isMatching: true,
      }));

      try {
        // 1. Compute CSV hash for duplicate detection
        const csvHash = await computeCsvHash(csvContent);

        // 2. Upload CSV to storage
        const importJobId = `import_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const csvUploadResult = await uploadImportCSV(
          userId,
          importJobId,
          csvContent
        );

        // 3. Create draft import
        const draftResult = await callFunction<
          {
            sourceId: string;
            fileName: string;
            csvHash: string;
            csvStoragePath: string;
            csvDownloadUrl: string;
            parseOptions: typeof analysis.options;
            detectedHeaders: string[];
            sampleRows: Record<string, string>[];
            totalRows: number;
          },
          {
            success: boolean;
            importId: string;
            existingDraftId?: string;
          }
        >("createDraftImport", {
          sourceId: source.id,
          fileName: file.name,
          csvHash,
          csvStoragePath: csvUploadResult.storagePath,
          csvDownloadUrl: csvUploadResult.downloadUrl,
          parseOptions: analysis.options,
          detectedHeaders: analysis.headers,
          sampleRows: analysis.sampleRows,
          totalRows: analysis.totalRows,
        });

        const existingDraftFound = !!draftResult.existingDraftId;
        const draftImportId = draftResult.importId;

        // 4. Auto-match columns using AI or use saved mappings
        let mappings: FieldMapping[];

        if (source?.fieldMappings) {
          // Use saved mappings from source
          const savedMappings = source.fieldMappings.mappings;
          mappings = analysis.headers.map((header) => ({
            csvColumn: header,
            targetField: savedMappings[header] || null,
            confidence: savedMappings[header] ? 1 : 0,
            userConfirmed: !!savedMappings[header],
            keepAsMetadata: !savedMappings[header],
            format: source.fieldMappings?.formats?.[header],
          }));
        } else {
          // Auto-match columns using AI
          mappings = await autoMatchColumns(analysis.headers, analysis.sampleRows);
        }

        setState((s) => ({
          ...s,
          mappings,
          isMatching: false,
          draftImportId,
          existingDraftFound,
        }));

        return { importId: draftImportId, existingDraft: existingDraftFound };
      } catch (error) {
        console.error("Draft creation or column matching failed:", error);
        setState((s) => ({
          ...s,
          isMatching: false,
          error: `Import preparation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        }));
        return null;
      }
    },
    [source, userId]
  );

  const updateMapping = useCallback(
    (index: number, targetField: string | null) => {
      setState((s) => ({
        ...s,
        mappings: s.mappings.map((m, i) =>
          i === index
            ? { ...m, targetField, userConfirmed: true, keepAsMetadata: !targetField }
            : m
        ),
      }));
    },
    []
  );

  const deleteMapping = useCallback((index: number) => {
    setState((s) => ({
      ...s,
      mappings: s.mappings.map((m, i) =>
        i === index
          ? { ...m, targetField: null, keepAsMetadata: false, format: undefined }
          : m
      ),
    }));
  }, []);

  const updateMappingFormat = useCallback((index: number, format: string) => {
    setState((s) => ({
      ...s,
      mappings: s.mappings.map((m, i) =>
        i === index ? { ...m, format, userConfirmed: true } : m
      ),
    }));
  }, []);

  // Returns true if validation passes, false otherwise
  // Page handles URL navigation
  const validateForPreview = useCallback((): boolean => {
    const validation = validateMappings(state.mappings);
    if (!validation.isValid) {
      setState((s) => ({
        ...s,
        error: `Missing required fields: ${validation.missingFields.join(", ")}`,
      }));
      return false;
    }
    setState((s) => ({ ...s, error: null }));
    return true;
  }, [state.mappings]);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  const executeImport = useCallback(async () => {
    // For draft imports, we have analysis and csvContent but may not have file object
    if (!source || !state.analysis || !userId) return;
    if (!state.file && !state.csvContent) return;

    setState((s) => ({ ...s, transientStep: "importing", progress: 0, error: null }));

    // Get date, amount, and balance mappings with their formats
    const dateMapping = state.mappings.find((m) => m.targetField === "date");
    const amountMapping = state.mappings.find((m) => m.targetField === "amount");
    const balanceMapping = state.mappings.find((m) => m.targetField === "balance");

    const dateFormat = dateMapping?.format || "de";
    const amountFormat = amountMapping?.format || "de";
    const balanceFormat = balanceMapping?.format || amountFormat;

    const amountConfig = getAmountParserConfig(amountFormat);
    if (!amountConfig) {
      setState((s) => ({
        ...s,
        error: "Invalid amount format",
        transientStep: null, // Will fall back to URL step
      }));
      return;
    }

    // Use existing draft ID or generate new one
    const importJobId =
      state.draftImportId ||
      `import_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    // Parse the full CSV file for import
    let rows: Record<string, string>[];
    if (state.analysis.sampleRows.length === state.analysis.totalRows) {
      // Small file - sample has all rows
      rows = state.analysis.sampleRows;
    } else {
      // Large file - need to parse the full file
      // Use csvContent if available (draft resumption), otherwise read from file
      const text = state.csvContent || (await state.file?.text());
      if (!text) {
        setState((s) => ({
          ...s,
          error: "CSV content not available",
          transientStep: null,
        }));
        return;
      }
      const { rows: allRows } = parseCSV(text, state.analysis.options);
      rows = allRows;
    }

    // Build mapping lookup
    const fieldMap = new Map<string, string>();
    for (const mapping of state.mappings) {
      if (mapping.targetField) {
        fieldMap.set(mapping.csvColumn, mapping.targetField);
      }
    }

    // Balance format config (may be null if no balance column mapped)
    const balanceConfig = balanceMapping ? getAmountParserConfig(balanceFormat) : null;

    // Balance tracking: track first and last row with balance data to derive opening balance
    let firstBalanceRow: { date: Date; balance: number; amount: number } | null = null;
    let lastBalanceRow: { date: Date; balance: number; amount: number } | null = null;

    // Prepare transactions
    const transactions: Omit<Transaction, "id">[] = [];
    const hashes: string[] = [];
    const errors: { row: number; message: string; rowData: Record<string, string> }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Extract mapped values
        let dateValue: string | null = null;
        let amountValue: string | null = null;
        let nameValue: string | null = null;
        let partnerValue: string | null = null;
        let referenceValue: string | null = null;
        let partnerIbanValue: string | null = null;
        let balanceValue: string | null = null;

        for (const [csvCol, targetField] of fieldMap) {
          const value = row[csvCol];
          if (!value) continue;

          switch (targetField) {
            case "date":
              dateValue = value;
              break;
            case "amount":
              amountValue = value;
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
            case "balance":
              balanceValue = value;
              break;
          }
        }

        // Validate required fields
        // Description (name) OR partner is required - having one of them is sufficient
        const missingFields: string[] = [];
        if (!dateValue) missingFields.push("date");
        if (!amountValue) missingFields.push("amount");
        if (!nameValue && !partnerValue) missingFields.push("description or partner");

        if (missingFields.length > 0) {
          errors.push({
            row: i + 1,
            message: `Missing: ${missingFields.join(", ")}`,
            rowData: row,
          });
          continue;
        }

        // Parse date (dateValue is validated above)
        const parsedDate = parseDate(dateValue!, dateFormat);
        if (!parsedDate) {
          errors.push({ row: i + 1, message: `Invalid date: ${dateValue}`, rowData: row });
          continue;
        }

        // Parse amount (amountValue is validated above)
        const parsedAmount = parseAmount(amountValue!, amountConfig);
        if (parsedAmount === null) {
          errors.push({ row: i + 1, message: `Invalid amount: ${amountValue}`, rowData: row });
          continue;
        }

        // Track balance data for opening balance derivation
        if (balanceValue && balanceConfig) {
          const parsedBalance = parseAmount(balanceValue, balanceConfig);
          if (parsedBalance !== null) {
            const balanceRow = { date: parsedDate, balance: parsedBalance, amount: parsedAmount };
            if (!firstBalanceRow) {
              firstBalanceRow = balanceRow;
            }
            lastBalanceRow = balanceRow;
          }
        }

        // Generate dedupe hash (use sourceId as fallback for sources without IBAN like credit cards)
        const hash = await generateDedupeHash(
          parsedDate,
          parsedAmount,
          source.iban ?? source.id,
          referenceValue
        );

        hashes.push(hash);

        // Create transaction object
        const now = Timestamp.now();
        transactions.push({
          sourceId: source.id,
          date: Timestamp.fromDate(parsedDate),
          amount: parsedAmount,
          currency: source.currency,
          _original: {
            date: dateValue!,
            amount: amountValue!,
            rawRow: row,
          },
          name: nameValue || partnerValue || "",
          description: null,
          partner: partnerValue,
          reference: referenceValue,
          partnerIban: partnerIbanValue,
          dedupeHash: hash,
          fileIds: [],
          isComplete: false,
          // Partner fields - explicitly null for Firestore query compatibility
          partnerId: null,
          partnerType: null,
          partnerMatchedBy: null,
          partnerMatchConfidence: null,
          partnerSuggestions: [],
          importJobId,
          csvRowIndex: i, // Row index for re-mapping feature
          userId: userId,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        errors.push({
          row: i + 1,
          message: err instanceof Error ? err.message : "Unknown error",
          rowData: row,
        });
      }

      // Update progress
      setState((s) => ({
        ...s,
        progress: Math.round(((i + 1) / rows.length) * 50),
      }));
    }

    // Check for duplicates
    const existingHashes = await checkDuplicatesBatch(hashes, source.id);

    // Filter out duplicates
    const newTransactions = transactions.filter(
      (t) => !existingHashes.has(t.dedupeHash)
    );
    const skippedCount = transactions.length - newTransactions.length;

    // Derive opening balance from CSV balance column if available
    let balanceInfo: {
      openingBalance: number;
      openingBalanceDate: string;
      latestBalance: number;
      latestBalanceDate: string;
    } | undefined;

    if (firstBalanceRow && lastBalanceRow) {
      // Determine CSV ordering: first row date vs last row date
      const isAscending = firstBalanceRow.date <= lastBalanceRow.date;
      const earliest = isAscending ? firstBalanceRow : lastBalanceRow;
      const latest = isAscending ? lastBalanceRow : firstBalanceRow;

      // Opening balance = balance of earliest row MINUS the transaction amount of that row
      // (because the balance shown is AFTER the transaction)
      const openingBalance = earliest.balance - earliest.amount;

      balanceInfo = {
        openingBalance,
        openingBalanceDate: earliest.date.toISOString(),
        latestBalance: latest.balance,
        latestBalanceDate: latest.date.toISOString(),
      };
    }

    // Batch write transactions using Cloud Function
    let importedCount = 0;
    const transactionIds: string[] = [];
    const overLimitTransactionIds: string[] = [];

    for (let i = 0; i < newTransactions.length; i += BATCH_SIZE) {
      const chunk = newTransactions.slice(i, i + BATCH_SIZE);

      // Convert Timestamps to ISO strings for Cloud Function
      const transactionsForCF = chunk.map((t) => ({
        ...t,
        date: (t.date as Timestamp).toDate().toISOString(),
        createdAt: (t.createdAt as Timestamp).toDate().toISOString(),
        updatedAt: (t.updatedAt as Timestamp).toDate().toISOString(),
      }));

      // Include balanceInfo only on the first batch
      const result = await callFunction<
        { transactions: typeof transactionsForCF; sourceId: string; balanceInfo?: typeof balanceInfo },
        { transactionIds: string[]; quotaExceeded?: boolean; overLimitCount?: number; overLimitTransactionIds?: string[] }
      >("bulkCreateTransactions", {
        transactions: transactionsForCF,
        sourceId: source.id,
        ...(i === 0 && balanceInfo ? { balanceInfo } : {}),
      });

      transactionIds.push(...result.transactionIds);
      if (result.overLimitTransactionIds) {
        overLimitTransactionIds.push(...result.overLimitTransactionIds);
      }
      importedCount += chunk.length;

      setState((s) => ({
        ...s,
        progress: 50 + Math.round(((i + chunk.length) / newTransactions.length) * 50),
      }));
    }

    // Run partner matching in batch (non-blocking)
    if (transactionIds.length > 0) {
      const matchPartners = httpsCallable(functions, "matchPartners");
      matchPartners({ transactionIds }).catch((error) => {
        console.error("Failed to match partners after import:", error);
      });
    }

    // Upload CSV to storage for re-mapping feature (skip if already uploaded for draft)
    let csvStoragePath: string | undefined;
    let csvDownloadUrl: string | undefined;
    if (!state.draftImportId && state.csvContent && userId) {
      // Only upload if this is not a draft (draft already has CSV uploaded)
      try {
        const csvUploadResult = await uploadImportCSV(
          userId,
          importJobId,
          state.csvContent
        );
        csvStoragePath = csvUploadResult.storagePath;
        csvDownloadUrl = csvUploadResult.downloadUrl;
      } catch (err) {
        console.error("Failed to upload CSV for re-mapping:", err);
        // Non-fatal - continue with import record creation
      }
    }

    // Sanitize mappings to convert undefined to null (Firestore rejects undefined)
    const sanitizedMappings = state.mappings?.map((m) => ({
      csvColumn: m.csvColumn,
      targetField: m.targetField,
      confidence: m.confidence,
      userConfirmed: m.userConfirmed,
      keepAsMetadata: m.keepAsMetadata,
      format: m.format ?? null, // Convert undefined to null
    })) ?? [];

    // Create import record using Cloud Function
    await callFunction("createImportRecord", {
      importJobId,
      sourceId: source.id,
      fileName: state.fileName || "import.csv",
      importedCount,
      skippedCount,
      errorCount: errors.length,
      totalRows: rows.length,
      csvStoragePath: csvStoragePath ?? null,
      csvDownloadUrl: csvDownloadUrl ?? null,
      parseOptions: state.analysis?.options ?? null,
      fieldMappings: sanitizedMappings,
    });

    // Update results
    setState((s) => ({
      ...s,
      transientStep: "complete",
      progress: 100,
      results: {
        total: rows.length,
        imported: importedCount,
        skipped: skippedCount,
        errors: errors.length,
        errorDetails: errors,
        overLimitCount: overLimitTransactionIds.length,
        balanceDetected: balanceInfo,
      },
    }));
  }, [source, state.file, state.analysis, state.mappings, state.csvContent, userId]);

  const reset = useCallback(() => {
    setState({
      transientStep: null,
      file: null,
      fileName: null,
      analysis: null,
      mappings: [],
      isMatching: false,
      progress: 0,
      results: null,
      error: null,
      csvContent: null,
      draftImportId: null,
      existingDraftFound: false,
    });
  }, []);

  return {
    state,
    handleFileAnalyzed,
    updateMapping,
    updateMappingFormat,
    deleteMapping,
    validateForPreview,
    clearError,
    executeImport,
    reset,
  };
}
