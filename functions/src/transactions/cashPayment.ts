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
import { connectFileToNewTransaction, FILE_ALREADY_CONNECTED_MESSAGE } from "../fileConnections/writer";

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

// ============================================================================
// From a File (#789)
// ============================================================================

export interface CashPaymentFromFileInput {
  /** The File the payment is for; the new row is connected to it. */
  fileId: string;
  /** The Cash Box. Optional when the User has exactly one. */
  sourceId?: string | null;
  /** Overrides of what the File says; a value sent wins. */
  date?: string | null;
  amount?: number | null;
  name?: string | null;
  description?: string | null;
  partnerId?: string | null;
}

export interface AddCashPaymentFromFileResult extends AddCashPaymentResult {
  fileId: string;
  connectionId: string;
}

/** Who connected the File, as the File Connection writer names it. */
function connectionOriginOf(author: CashPaymentAuthor): "manual" | "mcp" | "agent" {
  return author === "manual" ? "manual" : author === "api" ? "mcp" : "agent";
}

/**
 * The User's File, unconnected. Another User's File reads as missing; a File
 * already on a Transaction is refused (the writer checks again inside its
 * transaction).
 */
async function loadUnconnectedFile(db: Db, userId: string, fileId: unknown) {
  if (typeof fileId !== "string" || !fileId) {
    throw new HttpsError("invalid-argument", "fileId is required");
  }
  const file = await db.collection("files").doc(fileId).get();
  if (!file.exists || file.data()?.userId !== userId) {
    throw new HttpsError("not-found", "File not found");
  }
  const connected = file.data()?.transactionIds;
  if (Array.isArray(connected) && connected.length > 0) {
    throw new HttpsError("failed-precondition", FILE_ALREADY_CONNECTED_MESSAGE);
  }
  return file;
}

/**
 * The Cash Box a payment from a File goes to: the one named, or the User's
 * only Cash Box. None, or several without a choice, is refused saying which.
 */
async function cashBoxFor(db: Db, userId: string, sourceId: unknown) {
  if (sourceId !== undefined && sourceId !== null && sourceId !== "") return loadCashBox(db, userId, sourceId);
  const snap = await db.collection("sources").where("userId", "==", userId).get();
  const boxes = snap.docs.filter((d) => d.data().accountKind === "cash" && d.data().isActive !== false);
  if (boxes.length === 1) return boxes[0];
  if (boxes.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      "There is no Cash Box yet. Create one first (a Bank Account of kind cash), then add the payment."
    );
  }
  throw new HttpsError(
    "invalid-argument",
    `There are ${boxes.length} Cash Boxes; say which with sourceId: ` +
      boxes.map((b) => `${b.data().name ?? b.id} (${b.id})`).join(", ")
  );
}

/** The File's day as `YYYY-MM-DD`, read from the UTC date part (the dates rule). */
function fileDay(value: unknown): string | null {
  const toDate = (value as { toDate?: unknown } | null)?.toDate;
  const date = typeof toDate === "function" ? (value as { toDate: () => Date }).toDate() : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/**
 * What the File says the payment was, as defaults a caller may override: its
 * day; its gross amount (the VAT-bearing total plus a tip, what was handed
 * over) signed by direction (an outgoing invoice is money in, anything else
 * money out); its Partner (the User's own; a Global one is filled onto the
 * row by the payee rule as the File connects); and a name.
 */
export function cashPaymentDefaultsFromFile(file: FirebaseFirestore.DocumentData): {
  date: string | null;
  amount: number | null;
  name: string | null;
  partnerId: string | null;
} {
  const gross = typeof file.extractedAmount === "number" ? Math.abs(file.extractedAmount) : null;
  const tip = typeof file.extractedTipAmount === "number" ? Math.abs(file.extractedTipAmount) : 0;
  const amount =
    gross === null || gross + tip === 0 ? null : (gross + tip) * (file.invoiceDirection === "outgoing" ? 1 : -1);
  const name =
    [file.extractedPartner, file.extractedIssuer?.name, file.fileName].find(
      (v): v is string => typeof v === "string" && v.trim() !== ""
    ) ?? null;
  const partnerId =
    typeof file.partnerId === "string" && file.partnerId && file.partnerType !== "global" ? file.partnerId : null;
  return { date: fileDay(file.extractedDate), amount, name: name?.trim() ?? null, partnerId };
}

/**
 * Adds one Cash Payment from a File: the File's figures are the defaults,
 * values the caller sends win, and the row is created connected to the File,
 * through the File Connection writer, in one Firestore transaction. A refused
 * connect (the File connected meanwhile, a Copy, a deleted File) leaves no row.
 */
export async function addCashPaymentFromFile(
  db: Db,
  userId: string,
  input: CashPaymentFromFileInput,
  author: CashPaymentAuthor,
  options: AddCashPaymentOptions = {}
): Promise<AddCashPaymentFromFileResult> {
  const file = await loadUnconnectedFile(db, userId, input?.fileId);
  const fileData = file.data()!;
  const defaults = cashPaymentDefaultsFromFile(fileData);
  const pick = <T>(sent: T | null | undefined, fallback: T | null): T | null =>
    sent === undefined || sent === null ? fallback : sent;

  const date = cashPaymentDay(pick(input?.date, defaults.date));
  const amount = cashPaymentAmount(pick(input?.amount, defaults.amount));
  const name = cashPaymentName(pick(input?.name, defaults.name));
  const description = cashPaymentDescription(input?.description);
  const source = await cashBoxFor(db, userId, input?.sourceId);
  const partnerSent = input?.partnerId !== undefined && input?.partnerId !== null;
  const partner = partnerSent
    ? await loadPartner(db, userId, input.partnerId)
    : defaults.partnerId
      ? await loadPartner(db, userId, defaults.partnerId).catch(() => null)
      : null;
  const currency = (source.data()?.currency as string | undefined) ?? "EUR";

  // Soft limit, as in an import. Over it, only the User's own click may still
  // connect the File (the writer's rule), so an AI client is refused whole.
  const quota = await checkTransactionQuota(userId, 1, options.isAdmin === true);

  const partnerName = (partner?.data()?.name as string | undefined) ?? null;
  const fileName = (fileData.fileName as string | undefined) ?? file.id;
  const now = Timestamp.now();
  const ref = db.collection("transactions").doc();
  const outcome = await connectFileToNewTransaction(
    db,
    userId,
    {
      fileId: file.id,
      transaction: {
        ref,
        data: {
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
                  `Cash Payment added from File "${fileName}" by ${author === "manual" ? "hand" : "an AI client"}: ` +
                  `${amountLine(amount, currency)}${partnerName ? `, ${partnerName}` : ""}`,
                partnerName,
                forPartnerId: partner?.id ?? null,
                fileId: file.id,
                fileName,
              },
              now
            ),
          ],
          createdAt: now,
          updatedAt: now,
        },
      },
    },
    { origin: connectionOriginOf(author), onlyUnconnectedFile: true }
  );

  if (quota.allowed) await incrementTransactionCount(userId, 1);

  // The payee rule may have filled the Partner from the File as it connected.
  const after = await ref.get();
  await afterCreate(db, userId, ref.id, { partnerGiven: Boolean(after.data()?.partnerId) });

  return { transactionId: ref.id, quotaExceeded: !quota.allowed, fileId: file.id, connectionId: outcome.connectionId };
}

export const addCashPaymentFromFileCallable = createCallable<CashPaymentFromFileInput, AddCashPaymentFromFileResult>(
  { name: "addCashPaymentFromFile" },
  async (ctx, request) =>
    addCashPaymentFromFile(ctx.db, ctx.userId, request, "manual", { isAdmin: ctx.request.auth?.token?.admin === true })
);
