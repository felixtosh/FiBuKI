"use client";

import { Transaction } from "@/types/transaction";
import { ActivityHistory } from "@/components/activity/activity-history";

interface TransactionHistoryProps {
  transaction: Transaction;
  expandedByDefault?: boolean;
}

/** A Transaction's activity log (#752). */
export function TransactionHistory({ transaction, expandedByDefault = false }: TransactionHistoryProps) {
  return <ActivityHistory entries={transaction.automationHistory} expandedByDefault={expandedByDefault} />;
}
