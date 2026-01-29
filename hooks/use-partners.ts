"use client";

import { useState, useEffect, useCallback, startTransition } from "react";
import { collection, query, orderBy, onSnapshot, where } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { callFunction } from "@/lib/firebase/callable";
import { UserPartner, PartnerFormData } from "@/types/partner";
import { useAuth } from "@/components/auth";

const PARTNERS_COLLECTION = "partners";

export function usePartners() {
  const { userId } = useAuth();
  const [partners, setPartners] = useState<UserPartner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Realtime listener for user partners
  useEffect(() => {
    if (!userId) {
      setPartners([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const q = query(
      collection(db, PARTNERS_COLLECTION),
      where("userId", "==", userId),
      where("isActive", "==", true),
      orderBy("name", "asc")
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as UserPartner[];

        // Use startTransition to batch updates and prevent flicker
        // where loading=false but partners is still empty
        startTransition(() => {
          setPartners(data);
          setLoading(false);
        });
      },
      (err) => {
        console.error("Error fetching partners:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  // Mutations call Cloud Functions
  const createPartner = useCallback(
    async (data: PartnerFormData, options?: { skipAutoMatch?: boolean }): Promise<string> => {
      const result = await callFunction<
        { data: PartnerFormData; skipAutoMatch?: boolean },
        { partnerId: string }
      >(
        "createUserPartner",
        { data, skipAutoMatch: options?.skipAutoMatch }
      );
      return result.partnerId;
    },
    []
  );

  const updatePartner = useCallback(
    async (partnerId: string, data: Partial<PartnerFormData>): Promise<void> => {
      await callFunction("updateUserPartner", { partnerId, data });
    },
    []
  );

  const deletePartner = useCallback(
    async (partnerId: string): Promise<void> => {
      await callFunction("deleteUserPartner", { partnerId });
    },
    []
  );

  const getPartnerById = useCallback(
    (partnerId: string): UserPartner | undefined => {
      return partners.find((p) => p.id === partnerId);
    },
    [partners]
  );

  const assignToTransaction = useCallback(
    async (
      transactionId: string,
      partnerId: string,
      partnerType: "global" | "user",
      matchedBy: "manual" | "suggestion",
      confidence?: number
    ): Promise<void> => {
      await callFunction("assignPartnerToTransaction", {
        transactionId,
        partnerId,
        partnerType,
        matchedBy,
        confidence,
      });
    },
    []
  );

  const removeFromTransaction = useCallback(
    async (transactionId: string): Promise<void> => {
      await callFunction("removePartnerFromTransaction", { transactionId });
    },
    []
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
