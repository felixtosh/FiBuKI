import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  Timestamp,
  writeBatch,
  increment,
  arrayUnion,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { functions } from "@/lib/firebase/config";
import {
  UserNoReceiptCategory,
  NoReceiptCategoryId,
  CategoryManualRemoval,
  ReceiptLostEntry,
} from "@/types/no-receipt-category";
import { Transaction } from "@/types/transaction";
import { PartnerCategoryManualRemoval } from "@/types/partner";
import { NO_RECEIPT_CATEGORY_TEMPLATES } from "@/lib/data/no-receipt-category-templates";
import { OperationsContext } from "./types";

const CATEGORIES_COLLECTION = "noReceiptCategories";
const TRANSACTIONS_COLLECTION = "transactions";
const PARTNERS_COLLECTION = "partners";

// ============ Category Management ============

/**
 * List all active no-receipt categories for the current user
 */
export async function listUserCategories(
  ctx: OperationsContext
): Promise<UserNoReceiptCategory[]> {
  const q = query(
    collection(ctx.db, CATEGORIES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("isActive", "==", true),
    orderBy("name", "asc")
  );

  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as UserNoReceiptCategory[];
}

/**
 * Get a single category by ID
 */
export async function getUserCategory(
  ctx: OperationsContext,
  categoryId: string
): Promise<UserNoReceiptCategory | null> {
  const docRef = doc(ctx.db, CATEGORIES_COLLECTION, categoryId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) return null;

  const data = snapshot.data();
  if (data.userId !== ctx.userId) return null;

  return { id: snapshot.id, ...data } as UserNoReceiptCategory;
}

/**
 * Update a category's fields
 */
export async function updateUserCategory(
  ctx: OperationsContext,
  categoryId: string,
  updates: Partial<Pick<UserNoReceiptCategory, "learnedPatterns" | "matchedPartnerIds">>
): Promise<void> {
  const category = await getUserCategory(ctx, categoryId);
  if (!category) {
    throw new Error(`Category ${categoryId} not found or access denied`);
  }

  await updateDoc(doc(ctx.db, CATEGORIES_COLLECTION, categoryId), {
    ...updates,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Get a category by template ID
 */
export async function getCategoryByTemplateId(
  ctx: OperationsContext,
  templateId: NoReceiptCategoryId
): Promise<UserNoReceiptCategory | null> {
  const q = query(
    collection(ctx.db, CATEGORIES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("templateId", "==", templateId),
    where("isActive", "==", true)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;

  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as UserNoReceiptCategory;
}

/**
 * Initialize user categories from templates.
 * Creates user-specific copies of all category templates.
 * Skips categories that already exist.
 */
export async function initializeUserCategories(
  ctx: OperationsContext
): Promise<{ created: number; skipped: number }> {
  const existing = await listUserCategories(ctx);
  const existingTemplateIds = new Set(existing.map((c) => c.templateId));

  const now = Timestamp.now();
  let created = 0;
  let skipped = 0;

  const batch = writeBatch(ctx.db);

  for (const template of NO_RECEIPT_CATEGORY_TEMPLATES) {
    if (existingTemplateIds.has(template.id)) {
      skipped++;
      continue;
    }

    const newCategory: Omit<UserNoReceiptCategory, "id"> = {
      userId: ctx.userId,
      templateId: template.id,
      name: template.name,
      description: template.description,
      helperText: template.helperText,
      matchedPartnerIds: [],
      learnedPatterns: [],
      transactionCount: 0,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const docRef = doc(collection(ctx.db, CATEGORIES_COLLECTION));
    batch.set(docRef, newCategory);
    created++;
  }

  if (created > 0) {
    await batch.commit();
  }

  console.log(`[Categories] Initialized ${created} categories, skipped ${skipped} existing`);
  return { created, skipped };
}

// ============ Transaction Category Assignment ============

/**
 * Assign a no-receipt category to a transaction.
 * Marks transaction as complete and clears any file connections.
 */
export async function assignCategoryToTransaction(
  ctx: OperationsContext,
  transactionId: string,
  categoryId: string,
  matchedBy: "manual" | "suggestion" | "auto",
  confidence?: number
): Promise<void> {
  // Verify transaction ownership
  const txDoc = doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId);
  const txSnapshot = await getDoc(txDoc);

  if (!txSnapshot.exists() || txSnapshot.data().userId !== ctx.userId) {
    throw new Error(`Transaction ${transactionId} not found or access denied`);
  }

  // Verify category ownership
  const category = await getUserCategory(ctx, categoryId);
  if (!category) {
    throw new Error(`Category ${categoryId} not found or access denied`);
  }

  const txData = { id: transactionId, ...txSnapshot.data() } as Transaction;
  const batch = writeBatch(ctx.db);

  // Update transaction
  batch.update(txDoc, {
    noReceiptCategoryId: categoryId,
    noReceiptCategoryTemplateId: category.templateId,
    noReceiptCategoryMatchedBy: matchedBy,
    noReceiptCategoryConfidence: confidence || (matchedBy === "manual" ? 100 : null),
    isComplete: true,
    updatedAt: Timestamp.now(),
  });

  // Increment category transaction count
  const categoryRef = doc(ctx.db, CATEGORIES_COLLECTION, categoryId);
  batch.update(categoryRef, {
    transactionCount: increment(1),
    updatedAt: Timestamp.now(),
  });

  // If transaction has a partner and category doesn't have this partner, add it
  // Auto-link partners to categories for both manual and auto matches
  if (txData.partnerId && (matchedBy === "manual" || matchedBy === "auto")) {
    if (!category.matchedPartnerIds.includes(txData.partnerId)) {
      batch.update(categoryRef, {
        matchedPartnerIds: arrayUnion(txData.partnerId),
      });
      console.log(`[Category] Added partner ${txData.partnerId} to category ${categoryId} (${matchedBy})`);
    }
  }

  await batch.commit();

  // Clear any manual removal entry for this transaction (user is re-adding it)
  if (category.manualRemovals?.some((r) => r.transactionId === transactionId)) {
    const updatedRemovals = category.manualRemovals.filter(
      (r) => r.transactionId !== transactionId
    );
    await updateDoc(categoryRef, {
      manualRemovals: updatedRemovals,
      updatedAt: Timestamp.now(),
    });
    console.log(`[Category] Cleared manual removal for tx ${transactionId} from category ${categoryId}`);
  }

  // Clear partner-level category manual removal if exists (user is re-adding to this category)
  if (txData.partnerId && (matchedBy === "manual" || matchedBy === "suggestion")) {
    clearPartnerCategoryRemoval(ctx, txData.partnerId, categoryId, transactionId).catch((error) => {
      console.error("Failed to clear partner category removal:", error);
    });
  }

  // Trigger partner-level category pattern learning (non-blocking)
  if ((matchedBy === "manual" || matchedBy === "suggestion") && txData.partnerId) {
    triggerPartnerCategoryLearning(txData.partnerId, categoryId, transactionId).catch((error) => {
      console.error("Failed to trigger partner category learning:", error);
    });
  }
}

/**
 * Assign "receipt lost" category with required reason/description.
 * Creates an Eigenbeleg (self-generated receipt) entry.
 */
export async function assignReceiptLostCategory(
  ctx: OperationsContext,
  transactionId: string,
  reason: string,
  description: string
): Promise<void> {
  // Find the receipt-lost category
  const category = await getCategoryByTemplateId(ctx, "receipt-lost");
  if (!category) {
    // Initialize categories first
    await initializeUserCategories(ctx);
    const freshCategory = await getCategoryByTemplateId(ctx, "receipt-lost");
    if (!freshCategory) {
      throw new Error("Failed to find or create receipt-lost category");
    }
    return assignReceiptLostCategory(ctx, transactionId, reason, description);
  }

  // Verify transaction ownership
  const txDoc = doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId);
  const txSnapshot = await getDoc(txDoc);

  if (!txSnapshot.exists() || txSnapshot.data().userId !== ctx.userId) {
    throw new Error(`Transaction ${transactionId} not found or access denied`);
  }

  const now = Timestamp.now();

  // Create receipt lost entry (Eigenbeleg)
  const receiptLostEntry: ReceiptLostEntry = {
    reason: reason.trim(),
    description: description.trim(),
    createdAt: now,
    confirmed: true,
  };

  const batch = writeBatch(ctx.db);

  // Update transaction
  batch.update(txDoc, {
    noReceiptCategoryId: category.id,
    noReceiptCategoryTemplateId: "receipt-lost",
    noReceiptCategoryMatchedBy: "manual",
    noReceiptCategoryConfidence: 100,
    receiptLostEntry,
    isComplete: true,
    updatedAt: now,
  });

  // Increment category transaction count
  const categoryRef = doc(ctx.db, CATEGORIES_COLLECTION, category.id);
  batch.update(categoryRef, {
    transactionCount: increment(1),
    updatedAt: now,
  });

  await batch.commit();
}

/**
 * Remove category assignment from a transaction.
 * Marks transaction as incomplete.
 * If category was system-recommended (auto/suggestion), tracks as manual removal (false positive).
 */
export async function removeCategoryFromTransaction(
  ctx: OperationsContext,
  transactionId: string
): Promise<void> {
  const txDoc = doc(ctx.db, TRANSACTIONS_COLLECTION, transactionId);
  const txSnapshot = await getDoc(txDoc);

  if (!txSnapshot.exists() || txSnapshot.data().userId !== ctx.userId) {
    throw new Error(`Transaction ${transactionId} not found or access denied`);
  }

  const txData = txSnapshot.data();
  const categoryId = txData.noReceiptCategoryId;
  const matchedBy = txData.noReceiptCategoryMatchedBy;

  if (!categoryId) {
    // No category assigned, nothing to do
    return;
  }

  // Check if this was a system-recommended assignment (auto or suggestion)
  const wasSystemRecommended = matchedBy === "auto" || matchedBy === "suggestion";

  const batch = writeBatch(ctx.db);

  // Check if transaction has files (if so, it's still complete)
  const hasFiles = txData.fileIds && txData.fileIds.length > 0;

  // Clear category fields
  batch.update(txDoc, {
    noReceiptCategoryId: null,
    noReceiptCategoryTemplateId: null,
    noReceiptCategoryMatchedBy: null,
    noReceiptCategoryConfidence: null,
    receiptLostEntry: null,
    // Only mark incomplete if no files attached
    isComplete: hasFiles,
    updatedAt: Timestamp.now(),
  });

  // Decrement category transaction count
  const categoryRef = doc(ctx.db, CATEGORIES_COLLECTION, categoryId);
  batch.update(categoryRef, {
    transactionCount: increment(-1),
    updatedAt: Timestamp.now(),
  });

  await batch.commit();

  // If this was a system-recommended assignment, track as false positive
  if (wasSystemRecommended) {
    try {
      const categorySnapshot = await getDoc(categoryRef);

      if (categorySnapshot.exists()) {
        const categoryData = categorySnapshot.data();
        const existingRemovals: CategoryManualRemoval[] = categoryData.manualRemovals || [];

        // Check if this transaction is already in manualRemovals (prevent duplicates)
        const alreadyRemoved = existingRemovals.some((r) => r.transactionId === transactionId);

        if (!alreadyRemoved) {
          // Store as manual removal (false positive) for pattern learning
          const removalEntry: CategoryManualRemoval = {
            transactionId,
            removedAt: Timestamp.now(),
            partner: txData.partner || null,
            name: txData.name || "",
          };

          await updateDoc(categoryRef, {
            manualRemovals: arrayUnion(removalEntry),
            updatedAt: Timestamp.now(),
          });

          console.log(`[Category Manual Removal] Stored false positive for category ${categoryId}: tx ${transactionId}`);
        } else {
          console.log(`[Category Manual Removal] Tx ${transactionId} already in manualRemovals, skipping`);
        }
      }

      // Store partner-level category removal and trigger re-learning
      if (txData.partnerId) {
        storePartnerCategoryRemoval(ctx, txData.partnerId, categoryId, transactionId, txData).catch((error) => {
          console.error("Failed to store partner category removal:", error);
        });

        triggerPartnerCategoryLearning(txData.partnerId, categoryId, transactionId).catch((error) => {
          console.error("Failed to trigger partner category re-learning:", error);
        });
      }
    } catch (error) {
      console.error("Failed to store category manual removal:", error);
      // Don't throw - manual removal tracking is non-critical
    }
  }

  // For manual removals, also trigger partner re-learning if there's a partner
  if (matchedBy === "manual") {
    if (txData.partnerId) {
      storePartnerCategoryRemoval(ctx, txData.partnerId, categoryId, transactionId, txData).catch((error) => {
        console.error("Failed to store partner category removal:", error);
      });

      triggerPartnerCategoryLearning(txData.partnerId, categoryId, transactionId).catch((error) => {
        console.error("Failed to trigger partner category re-learning:", error);
      });
    }
  }

  // Trigger re-matching to find a new category for this transaction
  triggerCategoryMatching([transactionId]).catch((error) => {
    console.error("Failed to trigger category re-matching:", error);
  });
}

/**
 * Trigger category matching for specific transactions via Cloud Function.
 * Non-blocking - runs in background.
 */
async function triggerCategoryMatching(transactionIds: string[]): Promise<void> {
  const matchCategories = httpsCallable<
    { transactionIds: string[] },
    { processed: number; autoMatched: number; withSuggestions: number }
  >(functions, "matchCategories");

  const result = await matchCategories({ transactionIds });
  console.log(
    `[Category Re-match] Processed ${result.data.processed}, auto-matched ${result.data.autoMatched}, suggestions ${result.data.withSuggestions}`
  );
}

/**
 * Trigger category matching for ALL unmatched transactions via Cloud Function.
 * Use this to populate categorySuggestions for existing transactions.
 * Returns the results from the Cloud Function.
 */
export async function triggerCategoryMatchingForAll(): Promise<{
  processed: number;
  autoMatched: number;
  withSuggestions: number;
}> {
  const matchCategories = httpsCallable<
    { matchAll?: boolean },
    { processed: number; autoMatched: number; withSuggestions: number }
  >(functions, "matchCategories");

  console.log("[Category Match All] Triggering category matching for all unmatched transactions...");
  const result = await matchCategories({ matchAll: false }); // matchAll: false = only unmatched
  console.log(
    `[Category Match All] Processed ${result.data.processed}, auto-matched ${result.data.autoMatched}, suggestions ${result.data.withSuggestions}`
  );
  return result.data;
}

/**
 * Add a partner to a category's matched partners list.
 */
export async function addPartnerToCategory(
  ctx: OperationsContext,
  categoryId: string,
  partnerId: string
): Promise<void> {
  const category = await getUserCategory(ctx, categoryId);
  if (!category) {
    throw new Error(`Category ${categoryId} not found or access denied`);
  }

  if (category.matchedPartnerIds.includes(partnerId)) {
    // Already added
    return;
  }

  await updateDoc(doc(ctx.db, CATEGORIES_COLLECTION, categoryId), {
    matchedPartnerIds: arrayUnion(partnerId),
    updatedAt: Timestamp.now(),
  });
}

/**
 * Remove a partner from a category's matched partners list.
 */
export async function removePartnerFromCategory(
  ctx: OperationsContext,
  categoryId: string,
  partnerId: string
): Promise<void> {
  const category = await getUserCategory(ctx, categoryId);
  if (!category) {
    throw new Error(`Category ${categoryId} not found or access denied`);
  }

  const updatedPartnerIds = category.matchedPartnerIds.filter(
    (id) => id !== partnerId
  );

  await updateDoc(doc(ctx.db, CATEGORIES_COLLECTION, categoryId), {
    matchedPartnerIds: updatedPartnerIds,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Remove a manual removal entry from a category.
 * This allows the transaction to be auto-matched to this category again.
 */
export async function clearManualRemoval(
  ctx: OperationsContext,
  categoryId: string,
  transactionId: string
): Promise<void> {
  const category = await getUserCategory(ctx, categoryId);
  if (!category) {
    throw new Error(`Category ${categoryId} not found or access denied`);
  }

  const existingRemovals = category.manualRemovals || [];
  const updatedRemovals = existingRemovals.filter(
    (r) => r.transactionId !== transactionId
  );

  await updateDoc(doc(ctx.db, CATEGORIES_COLLECTION, categoryId), {
    manualRemovals: updatedRemovals,
    updatedAt: Timestamp.now(),
  });

  console.log(`[Category] Cleared manual removal for tx ${transactionId} from category ${categoryId}`);

  // Trigger re-matching for this transaction since it's now eligible again
  triggerCategoryMatching([transactionId]).catch((error) => {
    console.error("Failed to trigger category re-matching after clearing removal:", error);
  });
}

// ============ Partner Category Learning ============

/**
 * Store a category removal on the partner for category pattern learning.
 * This serves as a negative training signal for the partner's category rules.
 */
async function storePartnerCategoryRemoval(
  ctx: OperationsContext,
  partnerId: string,
  categoryId: string,
  transactionId: string,
  txData: Record<string, unknown>
): Promise<void> {
  const partnerRef = doc(ctx.db, PARTNERS_COLLECTION, partnerId);
  const partnerSnapshot = await getDoc(partnerRef);

  if (!partnerSnapshot.exists() || partnerSnapshot.data().userId !== ctx.userId) {
    console.log(`[Partner Category Removal] Partner ${partnerId} not found or access denied`);
    return;
  }

  const partnerData = partnerSnapshot.data();
  const existingRemovals: PartnerCategoryManualRemoval[] = partnerData.categoryManualRemovals || [];

  // Check if already stored
  const alreadyStored = existingRemovals.some(
    (r) => r.transactionId === transactionId && r.categoryId === categoryId
  );

  if (alreadyStored) {
    console.log(`[Partner Category Removal] Already stored for partner ${partnerId}, category ${categoryId}`);
    return;
  }

  // Store the removal
  const removal: PartnerCategoryManualRemoval = {
    transactionId,
    categoryId,
    removedAt: Timestamp.now(),
    partner: (txData.partner as string) || null,
    name: (txData.name as string) || "",
    reference: (txData.reference as string) || null,
  };

  // Cap at 50 entries per category to prevent unbounded growth
  const otherRemovals = existingRemovals.filter((r) => r.categoryId !== categoryId);
  const sameCategoryRemovals = existingRemovals.filter((r) => r.categoryId === categoryId);
  const cappedSameCategoryRemovals = sameCategoryRemovals.slice(-49); // Keep last 49, add 1 new

  await updateDoc(partnerRef, {
    categoryManualRemovals: [...otherRemovals, ...cappedSameCategoryRemovals, removal],
    updatedAt: Timestamp.now(),
  });

  console.log(`[Partner Category Removal] Stored removal for partner ${partnerId}, category ${categoryId}, tx ${transactionId}`);
}

/**
 * Clear a category removal from the partner when user re-assigns the transaction to the category.
 */
async function clearPartnerCategoryRemoval(
  ctx: OperationsContext,
  partnerId: string,
  categoryId: string,
  transactionId: string
): Promise<void> {
  const partnerRef = doc(ctx.db, PARTNERS_COLLECTION, partnerId);
  const partnerSnapshot = await getDoc(partnerRef);

  if (!partnerSnapshot.exists() || partnerSnapshot.data().userId !== ctx.userId) {
    return;
  }

  const partnerData = partnerSnapshot.data();
  const existingRemovals: PartnerCategoryManualRemoval[] = partnerData.categoryManualRemovals || [];

  // Remove the entry for this transaction and category
  const updatedRemovals = existingRemovals.filter(
    (r) => !(r.transactionId === transactionId && r.categoryId === categoryId)
  );

  if (updatedRemovals.length !== existingRemovals.length) {
    await updateDoc(partnerRef, {
      categoryManualRemovals: updatedRemovals,
      updatedAt: Timestamp.now(),
    });
    console.log(`[Partner Category Removal] Cleared removal for partner ${partnerId}, category ${categoryId}, tx ${transactionId}`);
  }
}

/**
 * Trigger partner category pattern learning via Cloud Function.
 * Non-blocking - runs in background.
 */
async function triggerPartnerCategoryLearning(
  partnerId: string,
  categoryId: string,
  transactionId?: string
): Promise<void> {
  const learnPartnerCategoryPatterns = httpsCallable<
    { partnerId: string; categoryId: string; transactionId?: string },
    { patternsLearned: number; patterns: string[]; transactionsMatched: number }
  >(functions, "learnPartnerCategoryPatterns");

  try {
    const result = await learnPartnerCategoryPatterns({
      partnerId,
      categoryId,
      transactionId,
    });
    console.log(
      `[Partner Category Learning] Learned ${result.data.patternsLearned} patterns, matched ${result.data.transactionsMatched} transactions`
    );
  } catch (error) {
    console.error("[Partner Category Learning] Failed:", error);
    throw error;
  }
}

// ============ Admin Functions ============

/**
 * Retrigger category initialization for a user.
 * - Creates any missing categories from templates
 * - Auto-migrates orphaned category references (by name matching)
 * - Recalculates transaction counts
 */
export async function retriggerUserCategories(
  ctx: OperationsContext
): Promise<{ created: number; migrated: number; recalculated: number }> {
  // 1. Initialize any missing categories
  const { created } = await initializeUserCategories(ctx);

  // 2. Get all categories (fresh)
  const categories = await listUserCategories(ctx);
  const categoryByTemplateId = new Map(categories.map((c) => [c.templateId, c]));
  const categoryByName = new Map(
    categories.map((c) => [c.name.toLowerCase(), c])
  );

  // 3. Find transactions with orphaned categories and migrate them
  const orphanedQuery = query(
    collection(ctx.db, TRANSACTIONS_COLLECTION),
    where("userId", "==", ctx.userId),
    where("noReceiptCategoryId", "!=", null)
  );

  const orphanedSnapshot = await getDocs(orphanedQuery);
  let migrated = 0;

  const batch = writeBatch(ctx.db);
  let batchCount = 0;
  const MAX_BATCH_SIZE = 450;

  for (const txDoc of orphanedSnapshot.docs) {
    const txData = txDoc.data();
    const categoryId = txData.noReceiptCategoryId;

    // Check if category still exists
    const categoryExists = categories.some((c) => c.id === categoryId);

    if (!categoryExists) {
      // Try to migrate by template ID first, then by name
      let newCategory: UserNoReceiptCategory | undefined;

      if (txData.noReceiptCategoryTemplateId) {
        newCategory = categoryByTemplateId.get(txData.noReceiptCategoryTemplateId);
      }

      if (!newCategory) {
        // Try fuzzy name match - this handles renamed categories
        const templateName = NO_RECEIPT_CATEGORY_TEMPLATES.find(
          (t) => t.id === txData.noReceiptCategoryTemplateId
        )?.name;

        if (templateName) {
          newCategory = categoryByName.get(templateName.toLowerCase());
        }
      }

      if (newCategory) {
        batch.update(txDoc.ref, {
          noReceiptCategoryId: newCategory.id,
          updatedAt: Timestamp.now(),
        });
        migrated++;
        batchCount++;
      } else {
        // Can't migrate - clear the category
        // Only mark incomplete if transaction has no files
        const hasFiles = txData.fileIds && txData.fileIds.length > 0;
        batch.update(txDoc.ref, {
          noReceiptCategoryId: null,
          noReceiptCategoryTemplateId: null,
          noReceiptCategoryMatchedBy: null,
          noReceiptCategoryConfidence: null,
          isComplete: hasFiles,
          updatedAt: Timestamp.now(),
        });
        batchCount++;
      }

      // Commit batch if approaching limit
      if (batchCount >= MAX_BATCH_SIZE) {
        await batch.commit();
        batchCount = 0;
      }
    }
  }

  // Commit remaining
  if (batchCount > 0) {
    await batch.commit();
  }

  // 4. Recalculate transaction counts for each category
  let recalculated = 0;
  for (const category of categories) {
    const countQuery = query(
      collection(ctx.db, TRANSACTIONS_COLLECTION),
      where("userId", "==", ctx.userId),
      where("noReceiptCategoryId", "==", category.id)
    );

    const countSnapshot = await getDocs(countQuery);
    const actualCount = countSnapshot.size;

    if (category.transactionCount !== actualCount) {
      await updateDoc(doc(ctx.db, CATEGORIES_COLLECTION, category.id), {
        transactionCount: actualCount,
        updatedAt: Timestamp.now(),
      });
      recalculated++;
    }
  }

  console.log(
    `[Categories] Retrigger complete: ${created} created, ${migrated} migrated, ${recalculated} recalculated`
  );

  return { created, migrated, recalculated };
}

/**
 * Check if user has initialized their categories
 */
export async function hasUserCategories(ctx: OperationsContext): Promise<boolean> {
  const categories = await listUserCategories(ctx);
  return categories.length > 0;
}

/**
 * Get category statistics for admin view
 */
export async function getCategoryStats(
  ctx: OperationsContext
): Promise<
  Array<{
    category: UserNoReceiptCategory;
    actualTransactionCount: number;
    matchedPartnersCount: number;
    patternsCount: number;
  }>
> {
  const categories = await listUserCategories(ctx);

  const stats = await Promise.all(
    categories.map(async (category) => {
      // Get actual transaction count
      const countQuery = query(
        collection(ctx.db, TRANSACTIONS_COLLECTION),
        where("userId", "==", ctx.userId),
        where("noReceiptCategoryId", "==", category.id)
      );
      const countSnapshot = await getDocs(countQuery);

      return {
        category,
        actualTransactionCount: countSnapshot.size,
        matchedPartnersCount: category.matchedPartnerIds.length,
        patternsCount: category.learnedPatterns.length,
      };
    })
  );

  return stats;
}
