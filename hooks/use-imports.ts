"use client";

import { useCallback, useMemo } from "react";
import {
  collection,
  orderBy,
  query,
  where,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { ImportRecord } from "@/types/import";
import { callFunction } from "@/lib/firebase/callable";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import { useAuth } from "@/components/auth";

const IMPORTS_COLLECTION = "imports";

function mapImport(doc: QueryDocumentSnapshot): ImportRecord {
  return { id: doc.id, ...doc.data() } as ImportRecord;
}

export function useImports(sourceId?: string) {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      sourceId && userId
        ? query(
            collection(db, IMPORTS_COLLECTION),
            where("sourceId", "==", sourceId),
            where("userId", "==", userId),
            orderBy("createdAt", "desc"),
          )
        : null,
    [sourceId, userId],
  );

  const { data: allImports, loading, error } = useFirestoreCollection(
    q,
    mapImport,
  );

  // Separate completed imports from drafts.
  // Treat missing status as 'completed' for backwards compatibility.
  const imports = useMemo(
    () => allImports.filter((imp) => (imp.status ?? "completed") === "completed"),
    [allImports],
  );

  const drafts = useMemo(
    () => allImports.filter((imp) => imp.status === "draft"),
    [allImports],
  );

  /**
   * Delete an import and all its associated transactions
   * Uses Cloud Function which has Storage delete permissions
   */
  const deleteImport = useCallback(async (importId: string) => {
    await callFunction("deleteImportRecord", { importId });
  }, []);

  /**
   * Delete a draft import (only for status === 'draft')
   * Uses Cloud Function which also deletes the CSV from storage
   */
  const deleteDraft = useCallback(async (importId: string) => {
    await callFunction("deleteDraftImport", { importId });
  }, []);

  /**
   * Get a single import by ID (from the already-loaded imports)
   */
  const getImportById = useCallback(
    (importId: string): ImportRecord | undefined => {
      return allImports.find((imp) => imp.id === importId);
    },
    [allImports],
  );

  return {
    /** All completed imports (status !== 'draft') */
    imports,
    /** Draft imports that can be resumed */
    drafts,
    loading,
    error,
    deleteImport,
    deleteDraft,
    getImportById,
  };
}
