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
import { activityEntry, type ActivityActor } from "../utils/activity";
import { checkTransactionQuota, incrementTransactionCount } from "../billing/checkTransactionQuota";

type Db = FirebaseFirestore.Firestore;

/**
 * Who added the Cash Payment, as the server knows it, never as an argument
 * says: `manual` is the User in the web UI, `api` an external client with an
 * API key (MCP, the REST API), `ai` the chat agent. The same vocabulary as a
 * Partner assignment's `partnerMatchedBy`, which a given Partner records.
 */
export type CashPaymentAuthor = "manual" | "api" | "ai";

/** The activity log's actor: the User, or an AI client on the User's behalf. */
function actorOf(author: CashPaymentAuthor): ActivityActor {
  return author === "manual" ? "manual" : "ai";
}

export interface CashPaymentInput {
  /** The Cash Box. */
  sourceId: string;
  /** The calendar day, `YYYY-MM-DD`. Stored as UTC midnight of that day. */
  date: string;
  /** Signed integer cents: negative is money out, positive money in. */
  amount: number;
  /** The User's own text for the payment. */
  name: string;
  /** A longer note, optional. */
  description?: string | null;
  /** A Partner of the User's, optional. Without one, Partner matching runs. */
  partnerId?: string | null;
}

export interface AddCashPaymentResult {
  transactionId: string;
  /** Set when the plan's monthly transaction quota was already used up. */
  quotaExceeded: boolean;
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

/** A Partner of the User's that is not a Merged Partner (which is refused naming its survivor). */
async function loadPartner(db: Db, userId: string, partnerId: unknown) {
  if (typeof partnerId !== "string" || !partnerId) {
    throw new HttpsError("invalid-argument", "partnerId must be a Partner id");
  }
  const partner = await db.collection("partners").doc(partnerId).get();
  if (!partner.exists || partner.data()?.userId !== userId) {
    throw new HttpsError("not-found", "Partner not found");
  }
  const mergedInto = partner.data()?.mergedInto as string | undefined;
  if (mergedInto) {
    throw new HttpsError(
      "failed-precondition",
      `Partner ${partnerId} is a Merged Partner (merged into ${mergedInto}); use ${mergedInto} instead`
    );
  }
  return partner;
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

function cashPaymentDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpsError("invalid-argument", "description must be text");
  return value.trim() || null;
}

/** "4,50 out" / "20,00 in", for the activity log. */
function amountLine(amount: number, currency: string): string {
  const euros = (Math.abs(amount) / 100).toFixed(2).replace(".", ",");
  return `${euros} ${currency} ${amount < 0 ? "out" : "in"}`;
}

export interface AddCashPaymentOptions {
  /** Admins are never over quota, as in an import. */
  isAdmin?: boolean;
}

/**
 * Adds one Cash Payment to the User's Cash Box. Checks every id belongs to
 * the User before anything is written; refuses a Bank Account that is not a
 * Cash Box.
 */
export async function addCashPayment(
  db: Db,
  userId: string,
  input: CashPaymentInput,
  author: CashPaymentAuthor,
  options: AddCashPaymentOptions = {}
): Promise<AddCashPaymentResult> {
  const date = cashPaymentDay(input?.date);
  const amount = cashPaymentAmount(input?.amount);
  const name = cashPaymentName(input?.name);
  const description = cashPaymentDescription(input?.description);
  const source = await loadCashBox(db, userId, input?.sourceId);
  const partner =
    input?.partnerId === undefined || input?.partnerId === null
      ? null
      : await loadPartner(db, userId, input.partnerId);
  const currency = (source.data()?.currency as string | undefined) ?? "EUR";

  // Soft limit, as in an import: the row is stored, flagged when over.
  const quota = await checkTransactionQuota(userId, 1, options.isAdmin === true);

  const partnerName = (partner?.data()?.name as string | undefined) ?? null;
  const now = Timestamp.now();
  const ref = db.collection("transactions").doc();
  await ref.set({
    userId,
    sourceId: source.id,
    date,
    amount,
    currency,
    name,
    description,
    partner: null,
    reference: null,
    partnerIban: null,
    addedByHand: true,
    fileIds: [],
    isComplete: false,
    partnerId: partner ? partner.id : null,
    partnerType: partner ? "user" : null,
    partnerMatchConfidence: partner ? 100 : null,
    partnerMatchedBy: partner ? author : null,
    noReceiptCategoryId: null,
    ...(quota.allowed ? {} : { quotaExceeded: true }),
    automationHistory: [
      activityEntry(
        {
          type: "cash_payment_added",
          actor: actorOf(author),
          summary:
            `Cash Payment added by ${author === "manual" ? "hand" : "an AI client"}: ` +
            `${amountLine(amount, currency)}${partnerName ? `, ${partnerName}` : ""}`,
          partnerName,
          forPartnerId: partner?.id ?? null,
        },
        now
      ),
    ],
    createdAt: now,
    updatedAt: now,
  });

  if (quota.allowed) await incrementTransactionCount(userId, 1);

  await afterCreate(db, userId, ref.id, { partnerGiven: partner !== null });

  return { transactionId: ref.id, quotaExceeded: !quota.allowed };
}

/**
 * The work an imported row gets after it is stored, through the same
 * modules: Partner matching (rule-based, chaining category and File matching
 * as it does after an import) when the User gave no Partner, then the
 * matcher's suggestions on the unconnected Files it pairs the new row with.
 * No second matching path: which Files pair with the row, and what each File
 * then suggests, is the matcher's answer. The scheduled mail receipt search
 * is not started for one hand row, and no agentic Partner search is queued
 * (a model call per coffee).
 *
 * A failure here never undoes the Cash Payment: the row is stored, and the
 * next matching run catches up.
 */
async function afterCreate(db: Db, userId: string, transactionId: string, { partnerGiven }: { partnerGiven: boolean }) {
  if (!partnerGiven) {
    try {
      const { runPartnerMatching } = await import("../matching/matchPartners");
      await runPartnerMatching(userId, { transactionIds: [transactionId], agenticFallback: false });
    } catch (err) {
      console.error(`[cashPayment] Partner matching failed for ${transactionId}:`, err);
    }
  }

  try {
    const [{ filesForTransaction, storedSuggestionsOf }, { rescoreFileSuggestions }] = await Promise.all([
      import("../matching/matcher"),
      import("../matching/rescoreFileSuggestions"),
    ]);
    const txDoc = await db.collection("transactions").doc(transactionId).get();
    const { matches } = await filesForTransaction(db, userId, txDoc);
    // The pairs strong enough for a File to store as a suggestion, by the matcher's own threshold.
    const strong = matches.filter((m) => storedSuggestionsOf([m]).length > 0).map((m) => m.fileId);
    for (const fileId of strong) {
      const file = await db.collection("files").doc(fileId).get();
      const connected = file.data()?.transactionIds as string[] | undefined;
      if (connected && connected.length > 0) continue;
      await rescoreFileSuggestions(db, fileId);
    }
  } catch (err) {
    console.error(`[cashPayment] File suggestions failed for ${transactionId}:`, err);
  }
}

export const addCashPaymentCallable = createCallable<CashPaymentInput, AddCashPaymentResult>(
  { name: "addCashPayment" },
  async (ctx, request) =>
    addCashPayment(ctx.db, ctx.userId, request, "manual", { isAdmin: ctx.request.auth?.token?.admin === true })
);
