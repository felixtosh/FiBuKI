/**
 * The one writer of a File's or Transaction's Booking Accounts (#785).
 *
 * The call replaces the whole list, so a re-run import is idempotent and `[]`
 * clears it. A list equal to the stored one writes nothing. It touches no
 * extraction field, no `extractionCorrectedFields`, no suggestion and no
 * connection: a Booking Account is not part of the Extraction.
 */

import type { Firestore } from "firebase-admin/firestore";
import { activityEntry, logActivity, type ActivityActor } from "../utils/activity";
import type { BookingAccount, BookingAccountOrigin } from "./types";

export type BookingAccountTarget = { fileId: string } | { transactionId: string };

export interface SetBookingAccountsResult {
  changed: boolean;
  bookingAccounts: BookingAccount[];
}

/**
 * The origins a tool caller may claim. `manual` says a person decided, and
 * only a person's own editor may write it.
 */
export const TOOL_BOOKING_ACCOUNT_ORIGINS: readonly BookingAccountOrigin[] = ["sevdesk"];

/** Exactly one of `fileId` / `transactionId`. */
export function bookingAccountTarget(args: Record<string, unknown>): BookingAccountTarget {
  const fileId = typeof args.fileId === "string" && args.fileId ? args.fileId : null;
  const transactionId =
    typeof args.transactionId === "string" && args.transactionId ? args.transactionId : null;
  if (!fileId === !transactionId) throw new Error("Pass exactly one of fileId or transactionId");
  return fileId ? { fileId } : { transactionId: transactionId! };
}

const isOptionalString = (v: unknown) => v === undefined || v === null || typeof v === "string";
const isOptionalBoolean = (v: unknown) => v === undefined || typeof v === "boolean";

/**
 * A caller's list, checked entry by entry, then normalised. Amounts are
 * integer cents and may be negative, like a credit note's gross.
 */
export function parseBookingAccounts(raw: unknown): BookingAccount[] {
  if (!Array.isArray(raw)) throw new Error("bookingAccounts must be an array ([] clears it)");
  raw.forEach((entry, i) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const fail = (field: string, rule: string) => {
      throw new Error(`bookingAccounts[${i}].${field} ${rule}`);
    };
    if (typeof e.accountNumber !== "string" || !e.accountNumber.trim()) fail("accountNumber", "must be a non-empty string");
    if (typeof e.accountName !== "string" || !e.accountName.trim()) fail("accountName", "must be a non-empty string");
    if (!isOptionalString(e.skr03)) fail("skr03", "must be a string or null");
    if (!isOptionalString(e.skr04)) fail("skr04", "must be a string or null");
    if (!isOptionalBoolean(e.isAsset)) fail("isAsset", "must be true or false");
    if (!isOptionalBoolean(e.isGwg)) fail("isGwg", "must be true or false");
    if (
      e.vatPercent !== undefined &&
      e.vatPercent !== null &&
      (typeof e.vatPercent !== "number" || !(e.vatPercent >= 0 && e.vatPercent <= 100))
    ) {
      fail("vatPercent", "must be a number from 0 to 100, or null");
    }
    if (e.amount !== undefined && e.amount !== null && !Number.isSafeInteger(e.amount)) {
      fail("amount", "must be integer cents, or null");
    }
    if (!TOOL_BOOKING_ACCOUNT_ORIGINS.includes(e.origin as BookingAccountOrigin)) {
      fail("origin", `must be one of ${TOOL_BOOKING_ACCOUNT_ORIGINS.join(", ")}`);
    }
    if (!isOptionalString(e.externalId)) fail("externalId", "must be a string or null");
  });
  return normalised(raw);
}

/**
 * Every field in a fixed order and the optional ones filled, so two equal
 * lists compare equal however they were written.
 */
function normalised(list: unknown[]): BookingAccount[] {
  return (list as Array<Record<string, unknown>>).map((entry) => ({
    accountNumber: entry.accountNumber as string,
    accountName: entry.accountName as string,
    skr03: (entry.skr03 as string | null | undefined) ?? null,
    skr04: (entry.skr04 as string | null | undefined) ?? null,
    isAsset: (entry.isAsset as boolean | undefined) ?? false,
    isGwg: (entry.isGwg as boolean | undefined) ?? false,
    vatPercent: (entry.vatPercent as number | null | undefined) ?? null,
    amount: (entry.amount as number | null | undefined) ?? null,
    origin: entry.origin as BookingAccountOrigin,
    externalId: (entry.externalId as string | null | undefined) ?? null,
  }));
}

export async function setBookingAccounts(
  db: Firestore,
  userId: string,
  target: BookingAccountTarget,
  bookingAccounts: BookingAccount[],
  actor: ActivityActor
): Promise<SetBookingAccountsResult> {
  const isFile = "fileId" in target;
  const ref = isFile
    ? db.collection("files").doc(target.fileId)
    : db.collection("transactions").doc(target.transactionId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.userId !== userId) {
    throw new Error(isFile ? "File not found" : "Transaction not found");
  }

  const storedRaw = snap.data()!.bookingAccounts;
  const stored = normalised(Array.isArray(storedRaw) ? storedRaw : []);
  if (JSON.stringify(stored) === JSON.stringify(bookingAccounts)) {
    return { changed: false, bookingAccounts: stored };
  }

  await ref.update({
    bookingAccounts,
    ...logActivity(
      activityEntry({
        type: bookingAccounts.length > 0 ? "booking_accounts_set" : "booking_accounts_cleared",
        actor,
        summary: summaryOf(stored, bookingAccounts),
      })
    ),
  });
  return { changed: true, bookingAccounts };
}

function numbers(list: BookingAccount[]): string {
  return list.length > 0 ? list.map((a) => a.accountNumber).join(", ") : "none";
}

function summaryOf(before: BookingAccount[], after: BookingAccount[]): string {
  return after.length > 0
    ? `Booking accounts set: ${numbers(before)} → ${numbers(after)}`
    : `Booking accounts cleared (were ${numbers(before)})`;
}
