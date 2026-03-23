/**
 * Shared helper to resolve merge fields from a user email.
 * Used by previewEmail and sendTestEmail to populate templates with real data.
 */

import { getAuth } from "firebase-admin/auth";

type EmailTemplate = "digest" | "budget_warning_90" | "budget_warning_100" | "invite" | "password_reset";

export interface MergeFields {
  name: string;
  email: string;
  plan: string;
  // Digest fields
  newTransactions?: number;
  unmatchedTransactions?: number;
  completionRate?: number;
  newFiles?: number;
  // Budget fields
  usageEur?: number;
  limitEur?: number;
}

const SAMPLE_FIELDS: Record<EmailTemplate, MergeFields> = {
  digest: {
    name: "Jane",
    email: "jane@example.com",
    plan: "Starter",
    newTransactions: 42,
    unmatchedTransactions: 7,
    completionRate: 83,
    newFiles: 12,
  },
  budget_warning_90: {
    name: "Jane",
    email: "jane@example.com",
    plan: "Starter",
    usageEur: 4.5,
    limitEur: 5.0,
  },
  budget_warning_100: {
    name: "Jane",
    email: "jane@example.com",
    plan: "Starter",
    usageEur: 5.0,
    limitEur: 5.0,
  },
  invite: {
    name: "Jane",
    email: "jane@example.com",
    plan: "Free",
  },
  password_reset: {
    name: "Jane",
    email: "jane@example.com",
    plan: "Free",
  },
};

export async function resolveMergeFields(
  db: FirebaseFirestore.Firestore,
  template: EmailTemplate,
  mergeFieldsEmail?: string
): Promise<MergeFields> {
  if (!mergeFieldsEmail) {
    console.log(`[resolveMergeFields] No mergeFieldsEmail provided, using sample data for ${template}`);
    return SAMPLE_FIELDS[template];
  }

  console.log(`[resolveMergeFields] Resolving for ${mergeFieldsEmail}, template=${template}`);

  try {
    const user = await getAuth().getUserByEmail(mergeFieldsEmail);
    const userId = user.uid;
    const name = user.displayName || "there";

    // Get subscription for plan name
    const subDoc = await db.collection("subscriptions").doc(userId).get();
    const subData = subDoc.data();
    const plan = subData?.planId
      ? String(subData.planId).charAt(0).toUpperCase() + String(subData.planId).slice(1)
      : "Free";

    const base: MergeFields = {
      name,
      email: user.email || mergeFieldsEmail,
      plan,
    };

    if (template === "digest") {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const txQuery = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("createdAt", ">=", sevenDaysAgo)
        .get();

      const newTransactions = txQuery.size;
      let unmatchedTransactions = 0;
      for (const doc of txQuery.docs) {
        const data = doc.data();
        const hasFiles = data.fileIds && data.fileIds.length > 0;
        const hasNoReceipt = !!data.noReceiptCategoryId;
        if (!hasFiles && !hasNoReceipt) {
          unmatchedTransactions++;
        }
      }

      const completeTxCount = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("isComplete", "==", true)
        .count()
        .get();

      const totalTxCount = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .count()
        .get();

      const total = totalTxCount.data().count;
      const complete = completeTxCount.data().count;
      const completionRate = total > 0 ? Math.round((complete / total) * 100) : 0;

      const filesQuery = await db
        .collection("files")
        .where("userId", "==", userId)
        .where("createdAt", ">=", sevenDaysAgo)
        .get();

      return {
        ...base,
        newTransactions,
        unmatchedTransactions,
        completionRate,
        newFiles: filesQuery.size,
      };
    }

    if (template === "budget_warning_90" || template === "budget_warning_100") {
      const usageEur = subData?.aiUsage?.currentPeriodCostEur ?? 4.5;
      const limitEur = subData?.aiUsage?.budgetEur ?? 5.0;
      return { ...base, usageEur, limitEur };
    }

    return base;
  } catch (err) {
    console.warn(`[resolveMergeFields] Could not resolve for ${mergeFieldsEmail}:`, err);
    return SAMPLE_FIELDS[template];
  }
}
