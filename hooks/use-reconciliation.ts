"use client";

import { useCallback, useMemo } from "react";
import {
  collection,
  query,
  where,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useAuth } from "@/components/auth";
import { callFunction } from "@/lib/firebase/callable";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import type { CardReconciliationGroup } from "@/types/card-reconciliation";

interface UseReconciliationOptions {
  /** Filter by card source ID */
  cardSourceId?: string;
  /** Filter by bank source ID */
  bankSourceId?: string;
  /** Filter by status */
  status?: "suggested" | "confirmed" | "rejected";
}

function mapGroup(doc: QueryDocumentSnapshot): CardReconciliationGroup {
  return { id: doc.id, ...doc.data() } as CardReconciliationGroup;
}

export function useReconciliation(options: UseReconciliationOptions = {}) {
  const { user } = useAuth();
  const uid = user?.uid;

  const q = useMemo(() => {
    if (!uid) return null;
    const constraints = [where("userId", "==", uid)];
    if (options.cardSourceId) {
      constraints.push(where("cardSourceId", "==", options.cardSourceId));
    }
    if (options.bankSourceId) {
      constraints.push(where("bankSourceId", "==", options.bankSourceId));
    }
    if (options.status) {
      constraints.push(where("status", "==", options.status));
    }
    return query(collection(db, "cardReconciliationGroups"), ...constraints);
  }, [uid, options.cardSourceId, options.bankSourceId, options.status]);

  const { data: rawGroups, loading, error } = useFirestoreCollection(
    q,
    mapGroup,
  );

  // Sort by confidence descending
  const groups = useMemo(
    () => [...rawGroups].sort((a, b) => b.confidence - a.confidence),
    [rawGroups],
  );

  const confirmGroup = useCallback(
    async (groupId: string, cardTransactionIds?: string[], note?: string) => {
      return callFunction<
        { groupId: string; cardTransactionIds?: string[]; note?: string },
        { success: boolean; reconciledCount: number }
      >("confirmReconciliation", { groupId, cardTransactionIds, note });
    },
    [],
  );

  const rejectGroup = useCallback(async (groupId: string) => {
    return callFunction<{ groupId: string }, { success: boolean }>(
      "rejectReconciliation",
      { groupId },
    );
  }, []);

  return {
    groups,
    loading,
    error,
    confirmGroup,
    rejectGroup,
  };
}
