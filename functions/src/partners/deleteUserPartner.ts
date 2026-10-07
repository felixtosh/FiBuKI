/**
 * Soft-delete a user partner and unlink from all transactions/files
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { activityEntry, logActivity } from "../utils/activity";

interface DeleteUserPartnerRequest {
  partnerId: string;
}

interface DeleteUserPartnerResponse {
  success: boolean;
  unlinkedTransactions: number;
  unlinkedFiles: number;
}

const BATCH_SIZE = 500;

export const deleteUserPartnerCallable = createCallable<
  DeleteUserPartnerRequest,
  DeleteUserPartnerResponse
>(
  {
    name: "deleteUserPartner",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (ctx, request) => {
    const { partnerId } = request;

    if (!partnerId) {
      throw new HttpsError("invalid-argument", "partnerId is required");
    }

    // Verify ownership
    const partnerRef = ctx.db.collection("partners").doc(partnerId);
    const partnerSnap = await partnerRef.get();

    if (!partnerSnap.exists) {
      throw new HttpsError("not-found", "Partner not found");
    }

    if (partnerSnap.data()!.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    const now = Timestamp.now();
    let unlinkedTransactions = 0;
    let unlinkedFiles = 0;

    // 1. Soft delete the partner
    await partnerRef.update({
      isActive: false,
      updatedAt: now,
    });

    // 2. Find and unlink all transactions with this partner
    const transactionsQuery = await ctx.db
      .collection("transactions")
      .where("userId", "==", ctx.userId)
      .where("partnerId", "==", partnerId)
      .get();

    // The log (#752) on every Transaction and File that loses the Partner.
    const deletedLog = logActivity(activityEntry({
      type: "partner_removed",
      actor: "manual",
      forPartnerId: partnerId,
      summary: "Partner removed: the Partner was deleted",
    }));

    if (!transactionsQuery.empty) {
      for (let i = 0; i < transactionsQuery.docs.length; i += BATCH_SIZE) {
        const batch = ctx.db.batch();
        const chunk = transactionsQuery.docs.slice(i, i + BATCH_SIZE);

        for (const txDoc of chunk) {
          batch.update(txDoc.ref, {
            partnerId: null,
            partnerType: null,
            partnerMatchedBy: null,
            partnerMatchConfidence: null,
            updatedAt: now,
            ...deletedLog,
          });
          unlinkedTransactions++;
        }

        await batch.commit();
      }
    }

    // 3. Find and unlink all files with this partner
    const filesQuery = await ctx.db
      .collection("files")
      .where("userId", "==", ctx.userId)
      .where("partnerId", "==", partnerId)
      .get();

    if (!filesQuery.empty) {
      for (let i = 0; i < filesQuery.docs.length; i += BATCH_SIZE) {
        const batch = ctx.db.batch();
        const chunk = filesQuery.docs.slice(i, i + BATCH_SIZE);

        for (const fileDoc of chunk) {
          batch.update(fileDoc.ref, {
            partnerId: null,
            partnerType: null,
            partnerMatchedBy: null,
            partnerMatchConfidence: null,
            updatedAt: now,
            ...deletedLog,
          });
          unlinkedFiles++;
        }

        await batch.commit();
      }
    }

    console.log(`[deleteUserPartner] Deleted partner ${partnerId}`, {
      userId: ctx.userId,
      unlinkedTransactions,
      unlinkedFiles,
    });

    return {
      success: true,
      unlinkedTransactions,
      unlinkedFiles,
    };
  }
);
