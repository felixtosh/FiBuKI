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
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import { Transaction } from "@/types/transaction";
import { callFunction } from "@/lib/firebase/callable";
import { useAuth } from "@/components/auth";

const TRANSACTIONS_COLLECTION = "transactions";

function mapTransaction(doc: QueryDocumentSnapshot): Transaction {
  return { id: doc.id, ...doc.data() } as Transaction;
}

export function useTransactions() {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      userId
        ? query(
            collection(db, TRANSACTIONS_COLLECTION),
            where("userId", "==", userId),
            orderBy("date", "desc"),
          )
        : null,
    [userId],
  );

  const { data: transactions, loading, error } = useFirestoreCollection(
    q,
    mapTransaction,
  );

  // Mutations call Cloud Functions
  const updateTransaction = useCallback(
    async (transactionId: string, data: Partial<Transaction>) => {
      await callFunction("updateTransaction", { id: transactionId, data });
    },
    [],
  );

  // NOTE: deleteTransaction is intentionally NOT exposed.
  // Individual transaction deletion is not allowed - transactions must be
  // deleted together with their source to maintain accounting integrity.

  return {
    transactions,
    loading,
    error,
    updateTransaction,
  };
}
