"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  setDoc,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { ImportRecord } from "@/types/import";
import { callFunction } from "@/lib/firebase/callable";
import { useAuth } from "@/components/auth";

const IMPORTS_COLLECTION = "imports";

export function useImports(sourceId?: string) {
  const { userId } = useAuth();
  const [allImports, setAllImports] = useState<ImportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!sourceId || !userId) {
      setAllImports([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const q = query(
      collection(db, IMPORTS_COLLECTION),
      where("sourceId", "==", sourceId),
      where("userId", "==", userId),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as ImportRecord[];

        setAllImports(data);
        setLoading(false);
      },
      (err) => {
        console.error("Error fetching imports:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [sourceId, userId]);

  // Separate completed imports from drafts
  // Treat missing status as 'completed' for backwards compatibility
  const imports = useMemo(
    () => allImports.filter((imp) => (imp.status ?? "completed") === "completed"),
    [allImports]
  );

  const drafts = useMemo(
    () => allImports.filter((imp) => imp.status === "draft"),
    [allImports]
  );

  /**
   * Create a new import record with a specific ID
   * The ID should match the importJobId stored on transactions
   */
  const createImport = useCallback(
    async (
      importId: string,
      data: Omit<ImportRecord, "id" | "createdAt" | "userId">
    ): Promise<void> => {
      const docRef = doc(db, IMPORTS_COLLECTION, importId);
      if (!userId) return;
      await setDoc(docRef, {
        ...data,
        userId,
        createdAt: Timestamp.now(),
      });
    },
    [userId]
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
    [allImports]
  );

  return {
    /** All completed imports (status !== 'draft') */
    imports,
    /** Draft imports that can be resumed */
    drafts,
    loading,
    error,
    createImport,
    deleteImport,
    deleteDraft,
    getImportById,
  };
}
