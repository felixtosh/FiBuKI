/**
 * Accepted Receipt (#165): record - or revoke - the ruling that a
 * receipt-only transaction's evidence is as good as it will ever get.
 *
 * A recorded ruling, not a hide: who ruled, when, why, over which files. It
 * deliberately touches nothing else - not `documentationState` (the line
 * really is receipt-only and the UVA must keep treating it that way), not
 * `isComplete`, not the BMD export. The chase queue derives liveness on read
 * (`isAcceptanceLive`), so the ruling goes stale by itself when the files or
 * the documentation state change; nothing here needs a trigger.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import type { ReceiptOnlyAcceptance } from "../documents/receiptOnlyAcceptance";
import { activityEntry, logActivity } from "../utils/activity";

interface AcceptReceiptOnlyRequest {
  /** Transaction ID to rule on */
  id: string;
  action: "accept" | "revoke";
  /** accept only: why no § 11 invoice is obtainable. Required - the reason IS the record. */
  reason?: string;
}

interface AcceptReceiptOnlyResponse {
  success: boolean;
  /**
   * accept only: input VAT appears to be claimed on this bare receipt. A
   * warning and never a block - deductibility stays the Tax Advisor's call.
   */
  warning?: string;
}

/**
 * Does anything on this line claim input VAT despite the missing invoice?
 * A receipt never carries a § 12 deduction, so a claimed figure on an
 * accepted line is worth a warning (only) at ruling time.
 */
export async function claimedVatWarning(
  db: FirebaseFirestore.Firestore,
  tx: {
    vatRate?: number | null;
    vatAmount?: number | null;
    fileIds?: string[] | null;
  }
): Promise<string | undefined> {
  let claims = (tx.vatRate ?? 0) > 0 || (tx.vatAmount ?? 0) > 0;

  if (!claims) {
    const fileIds = (tx.fileIds ?? []).slice(0, 10);
    const snaps = await Promise.all(
      fileIds.map((id) => db.collection("files").doc(id).get())
    );
    claims = snaps.some(
      (snap) => snap.exists && ((snap.data()?.extractedVatAmount as number) ?? 0) > 0
    );
  }

  return claims
    ? "Input VAT (Vorsteuer) appears to be claimed on this line, but a receipt never carries a § 12 deduction. The ruling is recorded anyway - deductibility stays the Tax Advisor's call."
    : undefined;
}

export const acceptReceiptOnlyCallable = createCallable<
  AcceptReceiptOnlyRequest,
  AcceptReceiptOnlyResponse
>(
  { name: "acceptReceiptOnly" },
  async (ctx, request) => {
    const { id, action, reason } = request;

    if (!id) {
      throw new HttpsError("invalid-argument", "Transaction ID is required");
    }
    if (action !== "accept" && action !== "revoke") {
      throw new HttpsError("invalid-argument", 'action must be "accept" or "revoke"');
    }

    const transactionRef = ctx.db.collection("transactions").doc(id);
    const transactionSnap = await transactionRef.get();

    if (!transactionSnap.exists) {
      throw new HttpsError("not-found", "Transaction not found");
    }
    const transactionData = transactionSnap.data()!;
    if (transactionData.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    if (action === "revoke") {
      if (!transactionData.receiptOnlyAcceptance) {
        throw new HttpsError(
          "failed-precondition",
          "No Accepted Receipt ruling is recorded on this transaction"
        );
      }
      await transactionRef.update({
        receiptOnlyAcceptance: null,
        updatedAt: FieldValue.serverTimestamp(),
        ...logActivity(activityEntry({ type: "ruling_revoked", actor: "manual", summary: "Accepted Receipt ruling revoked" })),
      });
      return { success: true };
    }

    // accept
    if (transactionData.documentationState !== "receipt-only") {
      throw new HttpsError(
        "failed-precondition",
        `Only a receipt-only transaction can carry an Accepted Receipt ruling ` +
          `(this one is ${transactionData.documentationState ?? "not yet derived"})`
      );
    }
    const trimmedReason = (reason ?? "").trim();
    if (!trimmedReason) {
      throw new HttpsError(
        "invalid-argument",
        "A reason is required - the ruling IS the record"
      );
    }

    const acceptance: ReceiptOnlyAcceptance = {
      by: ctx.userId,
      at: Timestamp.now(),
      reason: trimmedReason,
      fileIds: (transactionData.fileIds as string[] | undefined) ?? [],
    };

    const warning = await claimedVatWarning(ctx.db, transactionData);

    await transactionRef.update({
      receiptOnlyAcceptance: acceptance,
      updatedAt: FieldValue.serverTimestamp(),
      ...logActivity(activityEntry({ type: "ruling_recorded", actor: "manual", summary: `Accepted Receipt ruling recorded: ${trimmedReason}` })),
    });

    return warning ? { success: true, warning } : { success: true };
  }
);
