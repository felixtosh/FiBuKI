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
import { UserPartner, PartnerFormData } from "@/types/partner";
import { useAuth } from "@/components/auth";

const PARTNERS_COLLECTION = "partners";

function mapPartner(doc: QueryDocumentSnapshot): UserPartner {
  return { id: doc.id, ...doc.data() } as UserPartner;
}

export function usePartners() {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      userId
        ? query(
            collection(db, PARTNERS_COLLECTION),
            where("userId", "==", userId),
            where("isActive", "==", true),
            orderBy("name", "asc"),
          )
        : null,
    [userId],
  );

  const { data: partners, loading, error } = useFirestoreCollection(
    q,
    mapPartner,
  );

  const createPartner = useCallback(
    async (
      data: PartnerFormData,
      options?: { skipAutoMatch?: boolean },
    ): Promise<string> => {
      const result = await callFunction<
        { data: PartnerFormData; skipAutoMatch?: boolean },
        { partnerId: string }
      >("createUserPartner", { data, skipAutoMatch: options?.skipAutoMatch });
      return result.partnerId;
    },
    [],
  );

  const updatePartner = useCallback(
    async (
      partnerId: string,
      data: Partial<PartnerFormData>,
    ): Promise<void> => {
      await callFunction("updateUserPartner", { partnerId, data });
    },
    [],
  );

  const deletePartner = useCallback(async (partnerId: string): Promise<void> => {
    await callFunction("deleteUserPartner", { partnerId });
  }, []);

  const getPartnerById = useCallback(
    (partnerId: string): UserPartner | undefined => {
      return partners.find((p) => p.id === partnerId);
    },
    [partners],
  );

  const assignToTransaction = useCallback(
    async (
      transactionId: string,
      partnerId: string,
      partnerType: "global" | "user",
      matchedBy: "manual" | "suggestion",
      confidence?: number,
    ): Promise<void> => {
      await callFunction("assignPartnerToTransaction", {
        transactionId,
        partnerId,
        partnerType,
        matchedBy,
        confidence,
      });
    },
    [],
  );

  const removeFromTransaction = useCallback(
    async (transactionId: string): Promise<void> => {
      await callFunction("removePartnerFromTransaction", { transactionId });
    },
    [],
  );

  return {
    partners,
    loading,
    error,
    createPartner,
    updatePartner,
    deletePartner,
    getPartnerById,
    assignToTransaction,
    removeFromTransaction,
  };
}
