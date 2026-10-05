"use client";

import { useState, useEffect, useCallback, useMemo, startTransition, useRef } from "react";
import { collection, query, orderBy, onSnapshot, where, limit, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import {
  UserNoReceiptCategory,
  NoReceiptCategoryId,
  CategorySuggestion,
} from "@/types/no-receipt-category";
import { Transaction } from "@/types/transaction";
import {
  OperationsContext,
  listUserCategories,
  initializeUserCategories,
  assignCategoryToTransaction,
  removeCategoryFromTransaction,
  assignReceiptLostCategory,
  retriggerUserCategories,
  hasUserCategories,
  updateUserCategory,
  triggerCategoryMatchingForAll,
} from "@/lib/operations";
import { CategoryLearnedPattern } from "@/types/no-receipt-category";
import { useAuth } from "@/components/auth";
// Category suggestions now come from transaction.categorySuggestions (computed on backend)
// No client-side matching functions needed

const CATEGORIES_COLLECTION = "noReceiptCategories";

export function useNoReceiptCategories() {
  const { userId } = useAuth();
  const [categories, setCategories] = useState<UserNoReceiptCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [initializing, setInitializing] = useState(false);

  const ctx: OperationsContext = useMemo(
    () => ({
      db,
      userId: userId ?? "",
    }),
    [userId]
  );

  // Realtime listener for user categories
  useEffect(() => {
    if (!userId) {
      setCategories([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const q = query(
      collection(db, CATEGORIES_COLLECTION),
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
        })) as UserNoReceiptCategory[];

        // Use startTransition to batch updates and prevent flicker
        // where loading=false but categories is still empty
        startTransition(() => {
          setCategories(data);
          setLoading(false);
        });
      },
      (err) => {
        console.error("Error fetching categories:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  // Track if we've already attempted initialization to avoid repeated checks
  const initAttemptedRef = useRef(false);

  // Auto-initialize categories if none exist (but not during active imports)
  useEffect(() => {
    if (!loading && categories.length === 0 && !initializing && userId && !initAttemptedRef.current) {
      // Mark that we've attempted to avoid repeated queries
      initAttemptedRef.current = true;

      // First check if there's an active import - don't auto-initialize during import
      const checkAndInitialize = async () => {
        try {
          const activeImportQuery = query(
            collection(db, "userImports"),
            where("userId", "==", userId),
            where("status", "in", ["pending", "validating", "wiping", "importing"]),
            limit(1)
          );
          const activeImportSnap = await getDocs(activeImportQuery);

          if (!activeImportSnap.empty) {
            console.log("[Categories] Skipping auto-init - active import in progress");
            initAttemptedRef.current = false; // Allow retry after import completes
            return;
          }

          // No active import, proceed with initialization
          setInitializing(true);
          await initializeUserCategories(ctx);
          console.log("[Categories] Auto-initialized user categories");
        } catch (err) {
          console.error("[Categories] Failed to auto-initialize:", err);
          initAttemptedRef.current = false; // Allow retry on error
        } finally {
          setInitializing(false);
        }
      };

      checkAndInitialize();
    }
  }, [loading, categories.length, ctx, initializing, userId]);

  // Reset init attempted flag when userId changes
  useEffect(() => {
    initAttemptedRef.current = false;
  }, [userId]);

  /**
   * Assign a category to a transaction
   */
  const assignToTransaction = useCallback(
    async (
      transactionId: string,
      categoryId: string,
      matchedBy: "manual" | "suggestion" = "manual",
      confidence?: number
    ): Promise<void> => {
      await assignCategoryToTransaction(
        ctx,
        transactionId,
        categoryId,
        matchedBy,
        confidence
      );
    },
    [ctx]
  );

  /**
   * Remove category from a transaction
   */
  const removeFromTransaction = useCallback(
    async (transactionId: string): Promise<void> => {
      await removeCategoryFromTransaction(ctx, transactionId);
    },
    [ctx]
  );

  /**
   * Assign "Receipt Lost" category with required documentation
   */
  const assignReceiptLost = useCallback(
    async (
      transactionId: string,
      reason: string,
      description: string
    ): Promise<void> => {
      await assignReceiptLostCategory(ctx, transactionId, reason, description);
    },
    [ctx]
  );

  /**
   * Get a category by its ID
   */
  const getCategoryById = useCallback(
    (categoryId: string): UserNoReceiptCategory | undefined => {
      return categories.find((c) => c.id === categoryId);
    },
    [categories]
  );

  /**
   * Get a category by template ID
   */
  const getCategoryByTemplateId = useCallback(
    (templateId: NoReceiptCategoryId): UserNoReceiptCategory | undefined => {
      return categories.find((c) => c.templateId === templateId);
    },
    [categories]
  );

  /**
   * Get category suggestions for a transaction (from stored backend results)
   */
  const getSuggestionsForTransaction = useCallback(
    (transaction: Transaction): CategorySuggestion[] => {
      // Return stored suggestions from transaction (computed by backend)
      return transaction.categorySuggestions || [];
    },
    []
  );

  /**
   * Retrigger categories (admin function)
   */
  const retrigger = useCallback(async () => {
    return retriggerUserCategories(ctx);
  }, [ctx]);

  /**
   * Update a category's fields (patterns, partners)
   */
  const updateCategory = useCallback(
    async (
      categoryId: string,
      updates: Partial<Pick<UserNoReceiptCategory, "learnedPatterns" | "matchedPartnerIds">>
    ): Promise<void> => {
      await updateUserCategory(ctx, categoryId, updates);
    },
    [ctx]
  );

  /**
   * Trigger category matching for all unmatched transactions.
   * Populates categorySuggestions on transactions via Cloud Function.
   */
  const matchAllTransactions = useCallback(async () => {
    return triggerCategoryMatchingForAll();
  }, []);

  return {
    categories,
    loading: loading || initializing,
    error,
    assignToTransaction,
    removeFromTransaction,
    assignReceiptLost,
    getCategoryById,
    getCategoryByTemplateId,
    getSuggestionsForTransaction,
    retrigger,
    updateCategory,
    matchAllTransactions,
  };
}

/**
 * Hook to get category suggestions for a specific transaction.
 * Returns stored suggestions from backend (no client-side computation).
 */
export function useCategorySuggestions(
  transaction: Transaction | null,
  _categories: UserNoReceiptCategory[]
): CategorySuggestion[] {
  return useMemo(() => {
    if (!transaction) {
      return [];
    }

    // Suggestions are pre-computed by backend and stored on transaction
    return transaction.categorySuggestions || [];
  }, [transaction]);
}
