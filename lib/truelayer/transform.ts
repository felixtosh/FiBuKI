/**
 * Transform TrueLayer transactions to our Transaction format
 */

import { Timestamp } from "firebase/firestore";
import { TrueLayerTransaction, TrueLayerAccount } from "@/types/truelayer";
import { Transaction } from "@/types/transaction";
import { generateDedupeHash } from "@/lib/import/deduplication";

/**
 * Transform TrueLayer transactions to our Transaction format
 */
export async function transformTransactions(
  transactions: TrueLayerTransaction[],
  sourceId: string,
  sourceIban: string,
  userId: string,
  importJobId: string | null
): Promise<Omit<Transaction, "id">[]> {
  const now = Timestamp.now();

  const results: Omit<Transaction, "id">[] = [];

  for (const tx of transactions) {
    // Determine if income or expense based on transaction_type
    const isCredit = tx.transaction_type === "CREDIT";
    const amount = Math.abs(tx.amount);

    // Build partner name from merchant or description
    const partner = tx.merchant_name || null;

    // Parse date and normalize to UTC midnight (date-only)
    const txDateFull = new Date(tx.timestamp);
    const txDate = new Date(Date.UTC(txDateFull.getUTCFullYear(), txDateFull.getUTCMonth(), txDateFull.getUTCDate()));

    // Reference for dedupe hash
    const reference = tx.meta?.provider_reference || tx.transaction_id;

    // Generate dedupe hash
    const dedupeHash = await generateDedupeHash(
      txDate,
      isCredit ? amount : -amount,
      sourceIban,
      reference
    );

    // Build original data
    const _original = {
      date: tx.timestamp,
      amount: tx.amount.toString(),
      rawRow: tx as unknown as Record<string, string>,
    };

    const transaction: Omit<Transaction, "id"> = {
      sourceId,
      importJobId,
      userId,
      date: Timestamp.fromDate(txDate),
      amount: isCredit ? amount : -amount,
      currency: tx.currency,
      name: tx.description,
      partner,
      partnerIban: null,
      description: null,
      reference,
      isComplete: false,
      dedupeHash,
      _original,
      createdAt: now,
      updatedAt: now,
    };

    results.push(transaction);
  }

  return results;
}

/**
 * Get IBAN from TrueLayer account
 */
export function getAccountIban(account: TrueLayerAccount): string | null {
  return account.account_number?.iban || null;
}

/**
 * Format account display name
 */
export function formatAccountName(account: TrueLayerAccount): string {
  if (account.display_name) {
    return account.display_name;
  }
  if (account.account_number?.iban) {
    return `Account ${account.account_number.iban.slice(-4)}`;
  }
  return `${account.account_type} Account`;
}
