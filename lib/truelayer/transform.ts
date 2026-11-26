/**
 * Read a TrueLayer account. A sync's lines are stored by import-transactions.ts.
 */

import { TrueLayerAccount } from "@/types/truelayer";

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
