/**
 * The Due Date and Debit Date a File stores (#236, #136), derived in one place
 * (#637).
 *
 * Both are read off the additional-fields rows the File is left with, against
 * the issue date it is left with: a row stating a date before the issue day is
 * a misread and stores nothing (#135). No such row stores null. The issue day
 * is read from the UTC date part, as stored dates require (#638).
 *
 * Every write that moves the rows or the issue date stores what this returns:
 * an Extraction, a Hand Correction and the one-time backfill (#641). The scorer
 * reads the stored dates only.
 */

import { Timestamp } from "firebase-admin/firestore";
import { dueDateFromAdditionalFields } from "../matching/dueDate";
import { debitDateFromAdditionalFields } from "../matching/debitDate";
import { toDateSafe } from "../utils/toDateSafe";

export interface StoredPaymentDates {
  extractedDueDate: Timestamp | null;
  extractedDebitDate: Timestamp | null;
}

/** The two dates `record` should store, from its rows and its issue date. */
export function derivePaymentDates(record: Record<string, unknown>): StoredPaymentDates {
  const issueDate = toDateSafe(record.extractedDate);
  return {
    extractedDueDate: asStoredDate(dueDateFromAdditionalFields(record.extractedAdditionalFields, issueDate)),
    extractedDebitDate: asStoredDate(
      debitDateFromAdditionalFields(record.extractedAdditionalFields, issueDate)
    ),
  };
}

function asStoredDate(date: Date | null): Timestamp | null {
  return date ? Timestamp.fromDate(date) : null;
}
