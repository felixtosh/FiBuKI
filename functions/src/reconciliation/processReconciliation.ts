/**
 * Card Reconciliation — Utility Function
 *
 * Called from onTransactionUpdate when a source partner is assigned to a
 * bank transaction, indicating it's a payment to one of the user's own accounts.
 *
 * Flow:
 * 1. Look up the card source from the partner's identitySourceField
 * 2. Get unreconciled card charges from that card source
 * 3. Score the bank payment against the card charges
 * 4. Create CardReconciliationGroup docs for matches above threshold
 * 5. Write reconciliation suggestions/confirmations
 * 6. Create notification
 */

import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  RECONCILIATION_CONFIG,
  scoreReconciliation,
  formatReconciliationBreakdown,
  CardChargeData,
  BankPaymentCandidate,
} from "./reconciliationScoring";

const db = getFirestore();

/**
 * Get unreconciled card charges from a card source within a date window.
 */
async function getUnreconciledCardCharges(
  userId: string,
  cardSourceId: string,
  beforeDate: Date,
  lookbackDays: number = RECONCILIATION_CONFIG.LOOKBACK_DAYS
): Promise<CardChargeData[]> {
  const startDate = new Date(beforeDate);
  startDate.setDate(startDate.getDate() - lookbackDays);

  const snapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("sourceId", "==", cardSourceId)
    .where("date", ">=", Timestamp.fromDate(startDate))
    .where("date", "<=", Timestamp.fromDate(beforeDate))
    .orderBy("date", "desc")
    .limit(200)
    .get();

  const charges: CardChargeData[] = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    // Skip already reconciled charges
    if (data.reconciledByBankTxId) continue;
    charges.push({
      id: doc.id,
      amount: data.amount,
      date: data.date,
      name: data.name || "",
    });
  }

  return charges;
}

/**
 * Try to reconcile a bank transaction with card charges from a linked card.
 *
 * Called from onTransactionUpdate when:
 * - A partner is assigned to a bank transaction
 * - That partner has identitySourceField = "source:{cardSourceId}"
 * - The card source has linkedSourceId matching the bank transaction's source
 *
 * @param userId - User ID
 * @param bankTxId - Bank transaction ID
 * @param bankTxData - Bank transaction data (amount, date, name, sourceId, etc.)
 * @param cardSourceId - Card source ID (from partner's identitySourceField)
 */
export async function tryReconcileTransaction(
  userId: string,
  bankTxId: string,
  bankTxData: {
    amount: number;
    date: Timestamp;
    name: string;
    sourceId: string;
    noReceiptCategoryTemplateId?: string | null;
    partnerId?: string | null;
  },
  cardSourceId: string
): Promise<void> {
  const t0 = Date.now();

  // Skip already reconciled bank transactions
  // (need to check the full doc since bankTxData may not include this field)
  const bankTxDoc = await db.collection("transactions").doc(bankTxId).get();
  if (!bankTxDoc.exists) return;
  const fullBankTxData = bankTxDoc.data()!;
  if (fullBankTxData.reconciliationMatchComplete) {
    console.log(`[Reconciliation] Bank tx ${bankTxId} already reconciled, skipping`);
    return;
  }

  // Only process negative (outgoing) bank transactions
  if (bankTxData.amount >= 0) return;

  // Get the card source to check linked bank account
  const cardSourceDoc = await db.collection("sources").doc(cardSourceId).get();
  if (!cardSourceDoc.exists) {
    console.log(`[Reconciliation] Card source ${cardSourceId} not found, skipping`);
    return;
  }

  const cardSourceData = cardSourceDoc.data()!;
  const cardSourceName = cardSourceData.name || "";

  // Verify the card source is linked to the bank transaction's source
  if (cardSourceData.linkedSourceId !== bankTxData.sourceId) {
    console.log(
      `[Reconciliation] Card source ${cardSourceId} not linked to bank source ${bankTxData.sourceId}, skipping`
    );
    return;
  }

  // Get unreconciled card charges
  const cardCharges = await getUnreconciledCardCharges(
    userId,
    cardSourceId,
    bankTxData.date.toDate()
  );

  if (cardCharges.length === 0) {
    console.log(`[Reconciliation] No unreconciled card charges for source ${cardSourceId}`);
    return;
  }

  // Build bank payment candidate
  const candidate: BankPaymentCandidate = {
    id: bankTxId,
    amount: bankTxData.amount,
    date: bankTxData.date,
    name: bankTxData.name,
    sourceId: bankTxData.sourceId,
    noReceiptCategoryTemplateId: bankTxData.noReceiptCategoryTemplateId || null,
    partnerId: bankTxData.partnerId || null,
  };

  // Score the reconciliation (isSourcePartner = true since that's the trigger)
  const match = scoreReconciliation(
    candidate,
    cardCharges,
    cardSourceData.linkedSourceId,
    true // isSourcePartner
  );

  if (!match || match.confidence < RECONCILIATION_CONFIG.SUGGESTION_THRESHOLD) {
    console.log(
      `[Reconciliation] No match for bank tx ${bankTxId} ` +
      `(${match ? `${match.confidence}% < ${RECONCILIATION_CONFIG.SUGGESTION_THRESHOLD}%` : "null"})`
    );
    return;
  }

  console.log(
    `[Reconciliation] Match: bank tx "${candidate.name}" ` +
    `(${(Math.abs(candidate.amount) / 100).toFixed(2)} EUR) -> ` +
    `${match.cardTransactions.length} card charges ` +
    `(sum: ${(match.cardChargesSum / 100).toFixed(2)} EUR) ` +
    `confidence: ${match.confidence}% ` +
    `[${formatReconciliationBreakdown(match.scoreBreakdown)}]`
  );

  // Compute date range for card charges
  const chargeDates = match.cardTransactions.map((c) => c.date.toDate().getTime());
  const minDate = Timestamp.fromDate(new Date(Math.min(...chargeDates)));
  const maxDate = Timestamp.fromDate(new Date(Math.max(...chargeDates)));

  // Create reconciliation group
  const groupRef = db.collection("cardReconciliationGroups").doc();
  const now = Timestamp.now();

  const status =
    match.confidence >= RECONCILIATION_CONFIG.AUTO_CONFIRM_THRESHOLD
      ? "confirmed"
      : "suggested";

  const groupData = {
    id: groupRef.id,
    userId,
    bankTransactionId: bankTxId,
    bankSourceId: bankTxData.sourceId,
    cardSourceId,
    cardTransactionIds: match.cardTransactions.map((c) => c.id),
    cardChargesSum: match.cardChargesSum,
    bankPaymentAmount: match.bankPaymentAmount,
    remainderAmount: match.remainderAmount,
    pattern: match.pattern,
    status,
    confidence: match.confidence,
    scoreBreakdown: match.scoreBreakdown,
    cardChargesDateRange: { from: minDate, to: maxDate },
    createdAt: now,
    updatedAt: now,
  };

  const batch = db.batch();
  batch.set(groupRef, groupData);

  if (status === "confirmed") {
    // Auto-confirm: mark card transactions as reconciled
    for (const cardTx of match.cardTransactions) {
      const txRef = db.collection("transactions").doc(cardTx.id);
      batch.update(txRef, {
        reconciledByBankTxId: bankTxId,
        reconciliationGroupId: groupRef.id,
        updatedAt: now,
      });
    }

    // Mark bank transaction as processed
    batch.update(db.collection("transactions").doc(bankTxId), {
      reconciliationMatchComplete: true,
      updatedAt: now,
    });

    console.log(
      `[Reconciliation] Auto-confirmed group ${groupRef.id} ` +
      `(${match.confidence}% >= ${RECONCILIATION_CONFIG.AUTO_CONFIRM_THRESHOLD}%)`
    );
  } else {
    // Suggestion: write suggestion to bank transaction for UI display
    const suggestion = {
      groupId: groupRef.id,
      cardSourceName,
      chargeCount: match.cardTransactions.length,
      chargesSum: match.cardChargesSum,
      confidence: match.confidence,
      pattern: match.pattern,
      remainderAmount: match.remainderAmount,
    };

    batch.update(db.collection("transactions").doc(bankTxId), {
      reconciliationSuggestions: FieldValue.arrayUnion(suggestion),
      reconciliationMatchComplete: true,
      updatedAt: now,
    });
  }

  await batch.commit();

  const elapsed = Date.now() - t0;
  console.log(`[Reconciliation] Created group ${groupRef.id} in ${elapsed}ms`);

  // Create notification
  try {
    await db.collection(`users/${userId}/notifications`).add({
      type: "reconciliation_suggestion",
      title: "Card reconciliation found",
      message:
        `Detected ${match.cardTransactions.length} card charge${match.cardTransactions.length !== 1 ? "s" : ""} ` +
        `matching a bank payment of ${(Math.abs(bankTxData.amount) / 100).toFixed(2)} EUR. ` +
        (status === "confirmed" ? "Auto-confirmed." : "Please review."),
      createdAt: FieldValue.serverTimestamp(),
      readAt: null,
      context: {
        reconciliationGroupCount: 1,
        cardSourceName,
        totalChargesCount: match.cardTransactions.length,
        groupId: groupRef.id,
        status,
      },
    });
  } catch (err) {
    console.error("[Reconciliation] Failed to create notification:", err);
  }
}
