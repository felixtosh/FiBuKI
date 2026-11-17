/**
 * The one writer of a Cash Payment (#788): a Transaction on a Cash Box that
 * the User typed, in their own words, with no bank statement behind it.
 *
 * Every path that creates one goes through here: the web UI's
 * `addCashPayment` callable and the `add_cash_payment` tool (MCP, the REST
 * API, and the chat through runTool). Adding one from a File and correcting
 * or deleting one belong here too, so the Cash Box exception to "a
 * Transaction's bank figures change only through an import" lives in one
 * module.
 *
 * A Cash Payment is an ordinary Transaction everywhere else: the matcher, the
 * UVA, the reports and the BMD export read it like a bank row. What sets it
 * apart is `addedByHand: true` and what it lacks: no import job, no CSV row
 * index, no raw original row and no dedupe hash, so it is never deduplicated
 * against anything and two identical coffees on one day are both kept.
 */

import { Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

type Db = FirebaseFirestore.Firestore;

export interface CashPaymentInput {
  /** The Cash Box. */
  sourceId: string;
  /** The calendar day, `YYYY-MM-DD`. Stored as UTC midnight of that day. */
  date: string;
  /** Signed integer cents: negative is money out, positive money in. */
  amount: number;
  /** The User's own text for the payment. */
  name: string;
}

export interface AddCashPaymentResult {
  transactionId: string;
}

/**
 * The User's Cash Box. Another User's Bank Account reads as missing, not as
 * denied; a Bank Account of another kind is refused, so no row is invented
 * on a real bank account.
 */
export async function loadCashBox(db: Db, userId: string, sourceId: unknown) {
  if (typeof sourceId !== "string" || !sourceId) {
    throw new HttpsError("invalid-argument", "sourceId (the Cash Box) is required");
  }
  const source = await db.collection("sources").doc(sourceId).get();
  if (!source.exists || source.data()?.userId !== userId) {
    throw new HttpsError("not-found", "Bank Account not found");
  }
  if (source.data()?.accountKind !== "cash") {
    throw new HttpsError(
      "failed-precondition",
      `Bank Account "${source.data()?.name ?? sourceId}" is not a Cash Box; only a Cash Box takes a Cash Payment.`
    );
  }
  return source;
}

/**
 * The calendar day as stored: UTC midnight of that day (the dates rule in
 * CLAUDE.md). Only a bare `YYYY-MM-DD` is taken, so no host's time zone or a
 * caller's offset can move the payment to the day before.
 */
export function cashPaymentDay(value: unknown): Timestamp {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const day = new Date(Date.UTC(y, m - 1, d));
    if (day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d) {
      return Timestamp.fromDate(day);
    }
  }
  throw new HttpsError("invalid-argument", "date must be a calendar day, YYYY-MM-DD");
}

/** Signed integer cents, never zero: negative is money out. */
export function cashPaymentAmount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value === 0) {
    throw new HttpsError(
      "invalid-argument",
      "amount must be a non-zero whole number of cents, negative for money out (e.g. -450 for 4,50 paid)"
    );
  }
  return value;
}

/** The User's text for the payment, trimmed; required. */
export function cashPaymentName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new HttpsError("invalid-argument", "name (what the payment was for) is required");
  return name;
}

/** Adds one Cash Payment to the User's Cash Box. */
export async function addCashPayment(
  db: Db,
  userId: string,
  input: CashPaymentInput
): Promise<AddCashPaymentResult> {
  const date = cashPaymentDay(input?.date);
  const amount = cashPaymentAmount(input?.amount);
  const name = cashPaymentName(input?.name);
  const source = await loadCashBox(db, userId, input?.sourceId);
  const now = Timestamp.now();
  const ref = db.collection("transactions").doc();
  await ref.set({
    userId,
    sourceId: source.id,
    date,
    amount,
    currency: source.data()?.currency ?? "EUR",
    name,
    addedByHand: true,
    fileIds: [],
    isComplete: false,
    partnerId: null,
    createdAt: now,
    updatedAt: now,
  });
  return { transactionId: ref.id };
}

export const addCashPaymentCallable = createCallable<CashPaymentInput, AddCashPaymentResult>(
  { name: "addCashPayment" },
  async (ctx, request) => addCashPayment(ctx.db, ctx.userId, request)
);
