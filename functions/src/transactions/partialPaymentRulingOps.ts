/**
 * Accepted Partial Payment (#554): record - or revoke - the ruling that a
 * tipped Transaction's bank line really is short of `document + tip`.
 *
 * One writer for both doors, the `acceptPartialPayment` callable and the
 * `accept_partial_payment` MCP tool, so a ruling made from either lands in the
 * same shape. Each door maps `PartialPaymentRulingError` onto its own surface.
 *
 * Like Accepted Receipt (#165), the ruling touches nothing but itself. It does
 * not change the Files, the tip, `isComplete` or the Documentation State. The
 * UVA and the BMD export read it through `isPartialPaymentAcceptanceLive`, so
 * it goes stale by itself when the figures it names change; nothing here needs
 * a trigger.
 */

import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  partialPaymentFigures,
  type PartialPaymentAcceptance,
  type RuledFileRecord,
} from "../uva/partialPaymentAcceptance";

export type PartialPaymentRulingErrorCode =
  | "invalid-argument"
  | "not-found"
  | "permission-denied"
  | "failed-precondition";

export class PartialPaymentRulingError extends Error {
  constructor(
    readonly code: PartialPaymentRulingErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface PartialPaymentRulingRequest {
  transactionId: string;
  action: "accept" | "revoke";
  /** accept only: why the shortfall is real. Required - the reason IS the record. */
  reason?: unknown;
}

/**
 * Record or revoke the ruling. Returns the ruling written, or null on revoke.
 *
 * Accepting needs a connected File that carries a tip: on any other line a
 * short bank amount already takes the partial-payment path with no ruling,
 * and a ruling there would be a record of nothing. Files the user does not
 * own are read as having no figures, exactly as the UVA run reads them.
 */
export async function rulePartialPayment(
  db: Firestore,
  userId: string,
  request: PartialPaymentRulingRequest
): Promise<PartialPaymentAcceptance | null> {
  const { transactionId, action, reason } = request;
  if (!transactionId || typeof transactionId !== "string") {
    throw new PartialPaymentRulingError("invalid-argument", "Transaction ID is required");
  }
  if (action !== "accept" && action !== "revoke") {
    throw new PartialPaymentRulingError("invalid-argument", 'action must be "accept" or "revoke"');
  }

  const transactionRef = db.collection("transactions").doc(transactionId);
  const transactionSnap = await transactionRef.get();
  if (!transactionSnap.exists) {
    throw new PartialPaymentRulingError("not-found", "Transaction not found");
  }
  const tx = transactionSnap.data()!;
  if (tx.userId !== userId) {
    throw new PartialPaymentRulingError("permission-denied", "Access denied");
  }

  if (action === "revoke") {
    if (!tx.partialPaymentAcceptance) {
      throw new PartialPaymentRulingError(
        "failed-precondition",
        "No Accepted Partial Payment ruling is recorded on this transaction"
      );
    }
    await transactionRef.update({
      partialPaymentAcceptance: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return null;
  }

  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  if (!trimmedReason) {
    throw new PartialPaymentRulingError(
      "invalid-argument",
      "A reason is required - the ruling IS the record"
    );
  }

  const fileIds = (tx.fileIds as string[] | undefined) ?? [];
  const snaps = await Promise.all(fileIds.map((id) => db.collection("files").doc(id).get()));
  const filesById = new Map<string, RuledFileRecord>();
  for (const snap of snaps) {
    const data = snap.data();
    if (snap.exists && data?.userId === userId) filesById.set(snap.id, data as RuledFileRecord);
  }

  const figures = partialPaymentFigures(
    { amount: tx.amount as number, fileIds },
    filesById
  );
  if (!figures.files.some((f) => f.tip !== null)) {
    throw new PartialPaymentRulingError(
      "failed-precondition",
      "Only a transaction whose connected files carry a tip can carry an Accepted " +
        "Partial Payment ruling; a short bank line without a tip is already read as a " +
        "partial payment"
    );
  }

  const acceptance: PartialPaymentAcceptance = {
    by: userId,
    at: Timestamp.now(),
    reason: trimmedReason,
    ...figures,
  };
  await transactionRef.update({
    partialPaymentAcceptance: acceptance,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return acceptance;
}
