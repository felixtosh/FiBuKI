"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { db } from "@/lib/firebase/config";
import { ImportRecord, FieldMapping, RemapPreview } from "@/types/import";
import { TransactionSource } from "@/types/source";
import {
  getImportRecord,
  downloadImportCSV,
  generateRemapPreview,
  applyRemapping,
  OperationsContext,
} from "@/lib/operations";
import { parseCSV } from "@/lib/import/csv-parser";
import { useAuth } from "@/components/auth";

export type RemapStep = "loading" | "mapping" | "preview" | "applying" | "complete" | "error";

export interface RemapState {
  step: RemapStep;
  importRecord: ImportRecord | null;
  csvContent: string | null;
  parsedRows: Record<string, string>[];
  headers: string[];
  mappings: FieldMapping[];
  preview: RemapPreview | null;
  progress: number;
  results: {
    updated: number;
    skipped: number;
    errors: { row: number; message: string }[];
  } | null;
  error: string | null;
}

export function useRemapping(importId: string, source: TransactionSource | null) {
  const { userId } = useAuth();
  const [state, setState] = useState<RemapState>({
    step: "loading",
    importRecord: null,
    csvContent: null,
    parsedRows: [],
    headers: [],
    mappings: [],
    preview: null,
    progress: 0,
    results: null,
    error: null,
  });

  const ctx: OperationsContext = useMemo(
    () => ({ db, userId: userId ?? "" }),
    [userId]
  );

  // Load import record and CSV on mount
  useEffect(() => {
    async function load() {
      try {
        setState((s) => ({ ...s, step: "loading", error: null }));

        // Load import record
        const importRecord = await getImportRecord(ctx, importId);
        if (!importRecord) {
          throw new Error("Import record not found");
        }

        if (!importRecord.csvStoragePath) {
          throw new Error("No CSV file stored for this import. Re-mapping is not available.");
        }

        if (!importRecord.parseOptions) {
          throw new Error("No parse options stored. Re-mapping is not available.");
        }

        // Download CSV
        const csvContent = await downloadImportCSV(importRecord.csvStoragePath);

        // Parse CSV with stored options
        const { headers, rows } = parseCSV(csvContent, importRecord.parseOptions);

        // Use stored mappings or empty
        const mappings = importRecord.fieldMappings || [];

        setState((s) => ({
          ...s,
          step: "mapping",
          importRecord,
          csvContent,
          parsedRows: rows,
          headers,
          mappings,
          error: null,
        }));
      } catch (err) {
        setState((s) => ({
          ...s,
          step: "error",
          error: err instanceof Error ? err.message : "Failed to load import data",
        }));
      }
    }

    load();
  }, [importId, ctx]);

  // Update a single mapping
  const updateMapping = useCallback((index: number, targetField: string | null) => {
    setState((s) => ({
      ...s,
      mappings: s.mappings.map((m, i) =>
        i === index
          ? { ...m, targetField, userConfirmed: true, keepAsMetadata: !targetField }
          : m
      ),
    }));
  }, []);

  // Update mapping format (for date/amount fields)
  const updateMappingFormat = useCallback((index: number, format: string) => {
    setState((s) => ({
      ...s,
      mappings: s.mappings.map((m, i) =>
        i === index ? { ...m, format, userConfirmed: true } : m
      ),
    }));
  }, []);

  // Delete a mapping
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

  // Generate preview of changes
  const generatePreview = useCallback(async () => {
    if (!source) {
      setState((s) => ({ ...s, error: "Source not loaded" }));
      return false;
    }

    try {
      setState((s) => ({ ...s, step: "preview", preview: null, error: null }));

      const preview = await generateRemapPreview(
        ctx,
        importId,
        state.mappings,
        state.parsedRows,
        source.iban || null,
        source.id
      );

      setState((s) => ({ ...s, preview }));
      return true;
    } catch (err) {
      setState((s) => ({
        ...s,
        step: "mapping",
        error: err instanceof Error ? err.message : "Failed to generate preview",
      }));
      return false;
    }
  }, [ctx, importId, source, state.mappings, state.parsedRows]);

  // Apply the remapping
  const applyChanges = useCallback(async () => {
    if (!source) {
      setState((s) => ({ ...s, error: "Source not loaded" }));
      return false;
    }

    try {
      setState((s) => ({ ...s, step: "applying", progress: 0, error: null }));

      const results = await applyRemapping(
        ctx,
        importId,
        state.mappings,
        state.parsedRows,
        source.iban || null,
        source.id,
        (progress) => setState((s) => ({ ...s, progress }))
      );

      setState((s) => ({
        ...s,
        step: "complete",
        progress: 100,
        results,
      }));

      return true;
    } catch (err) {
      setState((s) => ({
        ...s,
        step: "preview",
        error: err instanceof Error ? err.message : "Failed to apply remapping",
      }));
      return false;
    }
  }, [ctx, importId, source, state.mappings, state.parsedRows]);

  // Go back to mapping step
  const goBackToMapping = useCallback(() => {
    setState((s) => ({ ...s, step: "mapping", preview: null, error: null }));
  }, []);

  // Clear error
  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  return {
    state,
    updateMapping,
    updateMappingFormat,
    deleteMapping,
    generatePreview,
    applyChanges,
    goBackToMapping,
    clearError,
  };
}
