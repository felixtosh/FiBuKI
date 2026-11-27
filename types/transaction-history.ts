import type { Timestamp } from "firebase/firestore";
import { Transaction } from "./transaction";

/**
 * Who/what made a change to a transaction
 */
export interface ChangeAuthor {
  /** Type of change initiator */
  type: "user" | "ai_chat" | "import" | "system";

  /** User ID of the person who made the change */
  userId: string;

  /** Chat session ID if change was AI-initiated */
  sessionId?: string;

  /** Tool call ID for traceability */
  toolCallId?: string;
}

/**
 * A single entry in a transaction's edit history
 */
export interface TransactionHistoryEntry {
  id: string;

  /** Snapshot of the transaction fields before the change */
  previousState: Partial<Pick<Transaction, "description" | "fileIds" | "isComplete">>;

  /** List of field names that were changed */
  changedFields: string[];

  /** Who/what made the change */
  changedBy: ChangeAuthor;

  /** Optional reason for the change */
  changeReason?: string;

  /** When the change was made */
  createdAt: Timestamp;
}

/**
 * Summary of transaction history for display
 */
export interface TransactionHistorySummary {
  transactionId: string;
  totalChanges: number;
  lastChangeAt: Timestamp | null;
  lastChangeBy: ChangeAuthor | null;
}
