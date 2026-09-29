export interface PurgePolicyFile {
  transactionIds?: string[];
  hadTransactionConnections?: boolean;
  documentType?: string;
  extractedDate?: { toDate: () => Date } | Date | null;
}

/**
 * Whether the Purge confirmation carries the BAO § 132 retention warning for
 * this File (#268). A warning, never a refusal.
 */
export function isRetentionRelevant(file: PurgePolicyFile, now?: Date): boolean;
