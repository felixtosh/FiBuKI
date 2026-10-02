"use client";

import { useState, useCallback } from "react";
import { Timestamp } from "firebase/firestore";
import { callFunction } from "@/lib/firebase/callable";
import { TransactionSource } from "@/types/source";
import { FieldMapping, CSVAnalysis } from "@/types/import";
import { parseDate } from "@/lib/import/date-parsers";
import { parseAmount, getAmountParserConfig } from "@/lib/import/amount-parsers";
import { parseCSV } from "@/lib/import/csv-parser";
import { normalizeTradeType, detectAssetType } from "@/lib/import/investment-trade-utils";
import { useAuth } from "@/components/auth";

const BATCH_SIZE = 500;

export type InvestmentImportStep = "upload" | "mapping" | "preview" | "importing" | "complete";

export interface InvestmentImportState {
  step: InvestmentImportStep;
  file: File | null;
  analysis: CSVAnalysis | null;
  mappings: FieldMapping[];
  isMatching: boolean;
  progress: number;
  results: {
    total: number;
    imported: number;
    skipped: number;
    errors: number;
    errorDetails: { row: number; message: string }[];
  } | null;
  error: string | null;
  csvContent: string | null;
}

export function useInvestmentImport(source: TransactionSource | null) {
  const { userId } = useAuth();

  const [state, setState] = useState<InvestmentImportState>({
    step: "upload",
    file: null,
    analysis: null,
    mappings: [],
    isMatching: false,
    progress: 0,
    results: null,
    error: null,
    csvContent: null,
  });

  const handleFileAnalyzed = useCallback(
    async (analysis: CSVAnalysis, file: File) => {
      if (!source) return;

      const csvContent = await file.text();

      setState((s) => ({
        ...s,
        file,
        analysis,
        csvContent,
        error: null,
        isMatching: true,
      }));

      try {
        // Use saved mappings if available, otherwise auto-match with AI
        let mappings: FieldMapping[];

        if (source?.fieldMappings) {
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
          // AI auto-match using investment column matcher
          const result = await callFunction<
            { headers: string[]; sampleRows: Record<string, string>[] },
            { mappings: { csvColumn: string; targetField: string | null; confidence: number }[]; suggestedDateFormat: string | null; suggestedAmountFormat: string | null }
          >("matchInvestmentColumns", {
            headers: analysis.headers,
            sampleRows: analysis.sampleRows.slice(0, 10),
          });

          mappings = result.mappings.map((m) => ({
            csvColumn: m.csvColumn,
            targetField: m.targetField,
            confidence: m.confidence,
            userConfirmed: false,
            keepAsMetadata: !m.targetField,
            format:
              m.targetField === "date" ? result.suggestedDateFormat || undefined :
              ["quantity", "pricePerUnit", "grossAmount", "fees"].includes(m.targetField || "")
                ? result.suggestedAmountFormat || undefined : undefined,
          }));
        }

        setState((s) => ({
          ...s,
          mappings,
          isMatching: false,
          step: "mapping",
        }));
      } catch (error) {
        console.error("Column matching failed:", error);
        setState((s) => ({
          ...s,
          isMatching: false,
          error: `Column matching failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        }));
      }
    },
    [source]
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

  const updateMappingFormat = useCallback((index: number, format: string) => {
    setState((s) => ({
      ...s,
      mappings: s.mappings.map((m, i) =>
        i === index ? { ...m, format, userConfirmed: true } : m
      ),
    }));
  }, []);

  const goToPreview = useCallback(() => {
    // Check required fields
    const mapped = new Set(state.mappings.filter((m) => m.targetField).map((m) => m.targetField));
    const required = ["date", "tradeType", "ticker", "grossAmount"];
    const missing = required.filter((r) => !mapped.has(r));

    if (missing.length > 0) {
      setState((s) => ({
        ...s,
        error: `Missing required fields: ${missing.join(", ")}`,
      }));
      return;
    }

    setState((s) => ({ ...s, step: "preview", error: null }));
  }, [state.mappings]);

  const executeImport = useCallback(async () => {
    if (!source || !state.analysis || !state.csvContent || !userId) return;

    setState((s) => ({ ...s, step: "importing", progress: 0, error: null }));

    const dateMapping = state.mappings.find((m) => m.targetField === "date");
    const dateFormat = dateMapping?.format || "de";

    const amountMappings = state.mappings.filter((m) =>
      ["quantity", "pricePerUnit", "grossAmount", "fees"].includes(m.targetField || "")
    );
    const amountFormat = amountMappings[0]?.format || "simple";
    const amountConfig = getAmountParserConfig(amountFormat);

    if (!amountConfig) {
      setState((s) => ({ ...s, error: "Invalid amount format", step: "preview" }));
      return;
    }

    const importJobId = `trade_import_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    // Parse full CSV
    let rows: Record<string, string>[];
    if (state.analysis.sampleRows.length === state.analysis.totalRows) {
      rows = state.analysis.sampleRows;
    } else {
      const { rows: allRows } = parseCSV(state.csvContent, state.analysis.options);
      rows = allRows;
    }

    // Build mapping lookup
    const fieldMap = new Map<string, string>();
    for (const mapping of state.mappings) {
      if (mapping.targetField) {
        fieldMap.set(mapping.csvColumn, mapping.targetField);
      }
    }

    // Prepare trades
    const trades: Record<string, unknown>[] = [];
    const errors: { row: number; message: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        const values: Record<string, string | null> = {};
        for (const [csvCol, targetField] of fieldMap) {
          values[targetField] = row[csvCol] || null;
        }

        // Validate required fields
        if (!values.date || !values.tradeType || !values.ticker || !values.grossAmount) {
          errors.push({ row: i + 1, message: "Missing required field" });
          continue;
        }

        const parsedDate = parseDate(values.date, dateFormat);
        if (!parsedDate) {
          errors.push({ row: i + 1, message: `Invalid date: ${values.date}` });
          continue;
        }

        const grossAmount = parseAmount(values.grossAmount, amountConfig);
        if (grossAmount === null) {
          errors.push({ row: i + 1, message: `Invalid amount: ${values.grossAmount}` });
          continue;
        }

        const quantity = values.quantity ? parseAmount(values.quantity, amountConfig) ?? 0 : 0;
        const pricePerUnit = values.pricePerUnit ? parseAmount(values.pricePerUnit, amountConfig) ?? 0 : 0;
        const fees = values.fees ? Math.abs(parseAmount(values.fees, amountConfig) ?? 0) : 0;
        const netAmount = grossAmount - fees;

        const tradeType = normalizeTradeType(values.tradeType);
        const assetType = detectAssetType(
          values.ticker,
          values.isin,
          values.assetName
        );

        trades.push({
          sourceId: source.id,
          date: parsedDate.toISOString(),
          tradeType,
          assetType,
          ticker: values.ticker,
          isin: values.isin || null,
          assetName: values.assetName || values.ticker,
          quantity: Math.abs(quantity),
          pricePerUnit: Math.abs(pricePerUnit),
          grossAmount: Math.abs(grossAmount),
          fees,
          netAmount: Math.abs(netAmount),
          currency: values.currency || source.currency,
          importJobId,
          csvRowIndex: i,
          _original: {
            date: values.date,
            quantity: values.quantity || "0",
            pricePerUnit: values.pricePerUnit || "0",
            grossAmount: values.grossAmount,
            fees: values.fees || "0",
            rawRow: row,
          },
        });
      } catch (err) {
        errors.push({
          row: i + 1,
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }

      setState((s) => ({ ...s, progress: Math.round(((i + 1) / rows.length) * 50) }));
    }

    // Send to Cloud Function in batches
    let importedCount = 0;
    for (let i = 0; i < trades.length; i += BATCH_SIZE) {
      const chunk = trades.slice(i, i + BATCH_SIZE);

      await callFunction("bulkCreateTrades", {
        trades: chunk,
        sourceId: source.id,
      });

      importedCount += chunk.length;
      setState((s) => ({
        ...s,
        progress: 50 + Math.round(((i + chunk.length) / trades.length) * 40),
      }));
    }

    // Trigger FIFO calculation after import
    if (importedCount > 0) {
      callFunction("calculateFifo", { sourceId: source.id }).catch((err) => {
        console.error("FIFO calculation failed:", err);
      });
    }

    setState((s) => ({
      ...s,
      step: "complete",
      progress: 100,
      results: {
        total: rows.length,
        imported: importedCount,
        skipped: rows.length - importedCount - errors.length,
        errors: errors.length,
        errorDetails: errors,
      },
    }));
  }, [source, state.analysis, state.mappings, state.csvContent, userId]);

  const reset = useCallback(() => {
    setState({
      step: "upload",
      file: null,
      analysis: null,
      mappings: [],
      isMatching: false,
      progress: 0,
      results: null,
      error: null,
      csvContent: null,
    });
  }, []);

  return {
    state,
    handleFileAnalyzed,
    updateMapping,
    updateMappingFormat,
    goToPreview,
    executeImport,
    reset,
  };
}
