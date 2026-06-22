"use client";

import { useMemo } from "react";
import {
  collection,
  orderBy,
  query,
  where,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import { InvestmentTrade } from "@/types/investment-trade";
import { useAuth } from "@/components/auth";

function mapTrade(doc: QueryDocumentSnapshot): InvestmentTrade {
  return { id: doc.id, ...doc.data() } as InvestmentTrade;
}

export function useInvestmentTrades(sourceId: string | null) {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      userId && sourceId
        ? query(
            collection(db, "investmentTrades"),
            where("userId", "==", userId),
            where("sourceId", "==", sourceId),
            orderBy("date", "desc"),
          )
        : null,
    [userId, sourceId],
  );

  const { data: trades, loading, error } = useFirestoreCollection(q, mapTrade);

  return { trades, loading, error };
}
