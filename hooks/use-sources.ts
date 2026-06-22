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
import { callFunction } from "@/lib/firebase/callable";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import {
  TransactionSource,
  SourceFormData,
  SavedFieldMapping,
} from "@/types/source";
import { useAuth } from "@/components/auth";

const SOURCES_COLLECTION = "sources";

function mapSource(doc: QueryDocumentSnapshot): TransactionSource {
  return { id: doc.id, ...doc.data() } as TransactionSource;
}

export function useSources() {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      userId
        ? query(
            collection(db, SOURCES_COLLECTION),
            where("userId", "==", userId),
            where("isActive", "==", true),
            orderBy("name", "asc"),
          )
        : null,
    [userId],
  );

  const { data: sources, loading, error } = useFirestoreCollection(
    q,
    mapSource,
  );

  // Mutations call Cloud Functions
  const addSource = useCallback(
    async (data: SourceFormData): Promise<string> => {
      const result = await callFunction<
        { data: SourceFormData },
        { sourceId: string }
      >("createSource", { data });
      return result.sourceId;
    },
    [],
  );

  const updateSource = useCallback(
    async (sourceId: string, data: Partial<TransactionSource>) => {
      await callFunction("updateSource", { sourceId, data });
    },
    [],
  );

  const deleteSource = useCallback(async (sourceId: string) => {
    await callFunction("deleteSource", { sourceId });
  }, []);

  const saveFieldMappings = useCallback(
    async (sourceId: string, mappings: SavedFieldMapping) => {
      await callFunction("updateSource", {
        sourceId,
        data: { fieldMappings: mappings },
      });
    },
    [],
  );

  const getSourceById = useCallback(
    (sourceId: string): TransactionSource | undefined => {
      return sources.find((s) => s.id === sourceId);
    },
    [sources],
  );

  return {
    sources,
    loading,
    error,
    addSource,
    updateSource,
    deleteSource,
    saveFieldMappings,
    getSourceById,
  };
}
