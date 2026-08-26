/**
 * Server-Side Tool Registry
 *
 * Single source of truth for all MCP/API tool handlers.
 * Used by:
 * - HTTP API (mcpApi) - external AI tools
 * - MCP SSE (mcpSse) - Anthropic Claude
 *
 * Note: Chat assistant (lib/agent/tools/) has its own implementation
 * for performance (direct Admin SDK reads). Writes are already unified
 * via Cloud Function callables.
 */

import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { documentationStateChanged } from "../documents/documentationState";
import { deriveForTransaction } from "../documents/syncDocumentationState";
import { buildDownloadUrl } from "../utils/buildDownloadUrl";
import { dayStartUtc, dayEndExclusiveUtc } from "../uva/dateWindow";
import { buildMarkNotInvoiceUpdates, buildUnmarkNotInvoiceUpdates } from "../files/notInvoiceOps";
import {
  buildClearVatNotClaimableUpdates,
  buildMarkVatNotClaimableUpdates,
  NonClaimableVatError,
} from "../files/nonClaimableVatOps";
import {
  buildExtractionCorrection,
  ExtractionCorrectionError,
  FileExtractionCorrection,
} from "../files/extractionCorrectionOps";
import {
  buildDismissSuggestionUpdates,
  buildUndismissSuggestionUpdates,
  checkDismissalReason,
  isTransactionDismissedForFile,
  type DismissibleFileState,
} from "../files/dismissSuggestionOps";
import { getStorage } from "firebase-admin/storage";
import { randomUUID } from "crypto";
import { classifyFileRecord, documentTypeFields } from "../documents/adapter";
import { reviewFileRecordVatRates, vatRateReviewFields } from "../documents/vatRateReview";
import { syncDocumentationStateForTransactions } from "../documents/syncDocumentationState";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "./definitions";
import type { ToolName } from "./definitions";
import { readBankOriginalAmount } from "../fx/bankOriginalAmount";
import {
  CADENCE_DAYS,
  CHARGE_SCAN_LIMIT,
  DEFAULT_COVERAGE_MONTHS,
  nextExpectedCharge,
  resolveEffectiveCycles,
  selectEffectiveCycleForAmount,
  summarizeChargeCoverage,
  type BillingCadence,
  type BillingDocumentExpectation,
  type ChargeDocumentation,
  type DeclaredCycleInput,
  type DerivedBillingCycle,
  type ExpectedChargeWindow,
  type ResolvedEffectiveCycle,
} from "../matching/billingCycle";
import { PLANS } from "../billing/config";
import { KNOWN_AUSTRIAN_RATES } from "../uva/rateSet";
import type { PlanId, PlanFeatures } from "../billing/config";

/**
 * Convert a Firestore Timestamp to the YYYY-MM-DD calendar day it stands for.
 * Bank transactions are date-only — returning full ISO timestamps causes
 * timezone confusion (e.g. Dec 1 CET → Nov 30 UTC).
 *
 * The stored convention is UTC midnight of the Vienna calendar day, so the
 * day is read in UTC: that is the same convention the date-range filter and
 * the UVA report use. Rendering in Europe/Vienna instead agrees for every row
 * written to the convention, and disagrees with the window that selected the
 * row for anything written with a real time of day (the bank sync paths), so
 * a row could come back from a June query reporting a July date.
 */
function toLocalDate(
  ts: Timestamp | Date | { toDate?: () => Date } | string | null | undefined
): string | null {
  if (!ts) return null;
  if (typeof ts === "string") return ts;
  const date =
    ts instanceof Date
      ? ts
      : typeof (ts as Timestamp).toDate === "function"
        ? (ts as Timestamp).toDate()
        : null;
  if (!date || isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export { TOOL_NAMES };
export type { ToolName };

const db = getFirestore();

/**
 * Check if a tool requires a feature the user's plan doesn't have.
 * Returns an error message if blocked, or null if allowed.
 */
async function checkToolFeatureGate(userId: string, tool: string): Promise<string | null> {
  const toolDef = TOOL_DEFINITIONS.find((t) => t.name === tool);
  if (!toolDef?.requiredFeature) return null;

  const subDoc = await db.collection("subscriptions").doc(userId).get();
  const planId: PlanId = (subDoc.exists ? subDoc.data()!.plan : "free") || "free";
  const plan = PLANS[planId] || PLANS.free;

  if (!plan.planFeatures[toolDef.requiredFeature]) {
    return `Tool "${tool}" requires the "${toolDef.requiredFeature}" feature, which is not available on the ${plan.name} plan. Upgrade at https://fibuki.com/settings/billing`;
  }
  return null;
}

/**
 * Main tool dispatcher - routes tool calls to handlers
 */
export async function handleTool(
  userId: string,
  tool: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  // Check feature gate before executing
  const gateError = await checkToolFeatureGate(userId, tool);
  if (gateError) {
    throw new Error(gateError);
  }

  switch (tool) {
    // Sources
    case "list_sources":
      return listSources(userId);
    case "get_source":
      return getSource(userId, args.sourceId as string);
    case "create_source":
      return createSource(userId, args);
    case "delete_source":
      return deleteSource(userId, args);

    // Transactions
    case "list_transactions":
      return listTransactions(userId, args);
    case "get_transaction":
      return getTransaction(userId, args.transactionId as string);
    case "update_transaction":
      return updateTransaction(userId, args);
    case "list_transactions_needing_files":
      return listTransactionsNeedingFiles(userId, args);
    case "list_transactions_missing_invoice":
      return listTransactionsMissingInvoice(userId, args);
    case "import_transactions":
      return importTransactions(userId, args);

    // Files
    case "list_files":
      return listFiles(userId, args);
    case "get_file":
      return getFile(userId, args.fileId as string);
    case "connect_file_to_transaction":
      return connectFileToTransaction(userId, args);
    case "disconnect_file_from_transaction":
      return disconnectFileFromTransaction(userId, args);
    case "auto_connect_file_suggestions":
      return autoConnectFileSuggestions(userId, args);
    case "upload_file":
      return uploadFile(userId, args);
    case "score_file_transaction_match":
      return scoreFileTransactionMatch(userId, args);
    case "mark_file_as_not_invoice":
      return markFileAsNotInvoice(userId, args);
    case "unmark_file_as_not_invoice":
      return unmarkFileAsNotInvoice(userId, args);
    case "mark_file_vat_not_claimable":
      return markFileVatNotClaimable(userId, args);
    case "unmark_file_vat_not_claimable":
      return unmarkFileVatNotClaimable(userId, args);
    case "update_file_extraction":
      return updateFileExtraction(userId, args);
    case "dismiss_transaction_suggestion":
      return dismissTransactionSuggestion(userId, args);
    case "undismiss_transaction_suggestion":
      return undismissTransactionSuggestion(userId, args);

    // Identity entities (the user's personal/company entities used as invoice
    // sender). Returns id + name + vatId + ibans + address per entity.
    case "list_identity_entities":
      return listIdentityEntities(userId);
    case "update_identity_entity":
      return updateIdentityEntity(userId, args);

    // Partners
    case "list_partners":
      return listPartners(userId, args);
    case "get_partner":
      return getPartner(userId, args.partnerId as string);
    case "create_partner":
      return createPartner(userId, args);
    case "set_partner_billing_cycle":
      return setPartnerBillingCycle(userId, args);
    case "list_recurring_partners":
      return listRecurringPartners(userId, args);
    case "assign_partner_to_transaction":
      return assignPartnerToTx(userId, args);
    case "remove_partner_from_transaction":
      return removePartnerFromTx(userId, args);
    case "partner_rematch_report":
      return partnerRematchReport(userId, args);
    case "rematch_assigned_partners":
      return rematchAssignedPartnersTool(userId, args);

    // Categories
    case "list_no_receipt_categories":
      return listNoReceiptCategories(userId);
    case "assign_no_receipt_category":
      return assignNoReceiptCategory(userId, args);
    case "remove_no_receipt_category":
      return removeNoReceiptCategory(userId, args.transactionId as string);

    // Invoicing
    case "create_invoice":
      return createInvoice(userId, args);
    case "update_invoice":
      return updateInvoice(userId, args);
    case "issue_invoice":
      return issueInvoice(userId, args);
    case "list_invoices":
      return listInvoices(userId, args);
    case "get_invoice":
      return getInvoice(userId, args);
    case "duplicate_invoice":
      return duplicateInvoice(userId, args);
    case "cancel_invoice":
      return cancelInvoice(userId, args);

    // Status
    case "get_automation_status":
      return getAutomationStatus(userId);

    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

// ============================================================================
// Sources
// ============================================================================

export async function listSources(userId: string) {
  const snapshot = await db
    .collection("sources")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .orderBy("name", "asc")
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function getSource(userId: string, sourceId: string) {
  if (!sourceId) throw new Error("sourceId is required");

  const doc = await db.collection("sources").doc(sourceId).get();
  if (!doc.exists || doc.data()?.userId !== userId) {
    throw new Error("Source not found");
  }
  return { id: doc.id, ...doc.data() };
}

// ============================================================================
// Transactions
// ============================================================================

export async function listTransactions(userId: string, args: Record<string, unknown>) {
  let query: FirebaseFirestore.Query = db
    .collection("transactions")
    .where("userId", "==", userId);

  if (args.sourceId) {
    query = query.where("sourceId", "==", args.sourceId);
  }
  if (args.isComplete !== undefined) {
    query = query.where("isComplete", "==", args.isComplete);
  }

  // Date range pushed into the query so filters apply BEFORE the limit.
  // Dates come in as YYYY-MM-DD calendar days and are stored as UTC midnight
  // of that day, so the window is pure-UTC (fork #65 — a Vienna offset
  // boundary misfiles rows that carry a real booking time).
  //
  // A malformed boundary is rejected, not dropped: silently widening the
  // window returns the newest transactions of all time, which reads to a
  // caller as "the period is empty of anything older".
  if (args.dateFrom) {
    const fromDate = dayStartUtc(args.dateFrom as string);
    if (!fromDate) {
      throw new Error(`dateFrom must be a calendar day as YYYY-MM-DD, got "${args.dateFrom}"`);
    }
    query = query.where("date", ">=", Timestamp.fromDate(fromDate));
  }
  if (args.dateTo) {
    const toExclusive = dayEndExclusiveUtc(args.dateTo as string);
    if (!toExclusive) {
      throw new Error(`dateTo must be a calendar day as YYYY-MM-DD, got "${args.dateTo}"`);
    }
    query = query.where("date", "<", Timestamp.fromDate(toExclusive));
  }

  query = query.orderBy("date", "desc");

  // Cursor pagination: cursor is the last document id from the previous page.
  if (args.cursor) {
    const cursorSnap = await db.collection("transactions").doc(args.cursor as string).get();
    if (cursorSnap.exists && cursorSnap.data()?.userId === userId) {
      query = query.startAfter(cursorSnap);
    }
  }

  // Search is a substring match that Firestore can't push down. When set we
  // overfetch (up to 5x the requested limit) and filter in memory, capped to
  // avoid runaway scans. Callers that need stable pagination should avoid
  // combining `search` with `cursor`.
  const requestedLimit = Math.min(Math.max((args.limit as number) || 50, 1), 500);
  const search = (args.search as string | undefined)?.toLowerCase();
  const fetchLimit = search ? Math.min(requestedLimit * 5, 1000) : requestedLimit;
  query = query.limit(fetchLimit);

  const snapshot = await query.get();
  let transactions = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      date: toLocalDate(data.date) || data.date,
      amountFormatted: `${((data.amount || 0) / 100).toFixed(2)} ${data.currency || "EUR"}`,
    } as Record<string, unknown>;
  });

  if (search) {
    transactions = transactions.filter(
      (t) =>
        (t.name as string | undefined)?.toLowerCase().includes(search) ||
        (t.description as string | undefined)?.toLowerCase().includes(search) ||
        (t.partner as string | undefined)?.toLowerCase().includes(search)
    );
    transactions = transactions.slice(0, requestedLimit);
  }

  const hasMore = snapshot.docs.length === fetchLimit;
  const nextCursor = hasMore && transactions.length > 0
    ? (transactions[transactions.length - 1].id as string)
    : null;

  return { transactions, nextCursor, count: transactions.length };
}

export async function getTransaction(userId: string, transactionId: string) {
  if (!transactionId) throw new Error("transactionId is required");

  const doc = await db.collection("transactions").doc(transactionId).get();
  if (!doc.exists || doc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }

  const data = doc.data()!;
  return {
    id: doc.id,
    ...data,
    date: toLocalDate(data.date) || data.date,
    amountFormatted: `${((data.amount || 0) / 100).toFixed(2)} ${data.currency || "EUR"}`,
  };
}

export async function updateTransaction(userId: string, args: Record<string, unknown>) {
  const { transactionId, description, isComplete, vatRate, isReverseCharge } = args;
  if (!transactionId) throw new Error("transactionId is required");

  // Manual override lane (fork #64, spec §3 step 3): the UVA calculation
  // validates the rate against the transaction's period; this only rejects
  // values that are never an Austrian rate (19 = Jungholz/Mittelberg).
  if (vatRate !== undefined && vatRate !== null) {
    if (typeof vatRate !== "number" || !KNOWN_AUSTRIAN_RATES.includes(vatRate)) {
      throw new Error(
        `vatRate must be one of ${KNOWN_AUSTRIAN_RATES.join(", ")} (or null to clear the override)`
      );
    }
  }
  if (
    isReverseCharge !== undefined &&
    isReverseCharge !== null &&
    typeof isReverseCharge !== "boolean"
  ) {
    throw new Error("isReverseCharge must be true, false, or null to clear");
  }

  const docRef = db.collection("transactions").doc(transactionId as string);
  const doc = await docRef.get();
  if (!doc.exists || doc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }

  const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (description !== undefined) updates.description = description;
  if (isComplete !== undefined) {
    updates.isComplete = isComplete;
    // #215: marking complete changes neither fileIds nor noReceiptCategoryId,
    // so the onTransactionUpdate guard never re-derives — a bare line marked
    // complete would stay `undocumented` forever. Derive here so this writer
    // keeps the pair in step like every other one. The override itself stays:
    // isComplete is written as given, only the derived fact is refreshed.
    const derived = await deriveForTransaction(db, doc.data()!);
    if (documentationStateChanged(doc.data()?.documentationState, derived)) {
      updates.documentationState = derived;
    }
  }
  if (vatRate !== undefined) updates.vatRate = vatRate;
  if (isReverseCharge !== undefined) updates.isReverseCharge = isReverseCharge;

  await docRef.update(updates);
  return { success: true, transactionId };
}

/**
 * One page of the user's transactions, newest first, filtered in memory.
 *
 * Every listing that selects on an absent field has to work this way:
 * Firestore has no "field missing" predicate, so the read deliberately
 * overfetches and a page is built from up to `scanLimit` documents. Rows past
 * that are reached via `nextCursor`, not silently dropped, and the caller's
 * `count` is the page size — never a count of what the account owes.
 *
 * The cursor is the last document actually CONSUMED, not the last one
 * returned, so the next page resumes exactly where this one stopped: rows
 * filtered out in memory are skipped, rows that simply didn't fit are not.
 */
async function scanTransactionsPage(
  userId: string,
  args: Record<string, unknown>,
  keep: (transaction: Record<string, unknown>) => boolean
): Promise<{ page: Array<Record<string, unknown>>; nextCursor: string | null }> {
  let query: FirebaseFirestore.Query = db
    .collection("transactions")
    .where("userId", "==", userId)
    .orderBy("date", "desc");

  // Cursor pagination: cursor is the last document id from the previous page.
  if (args.cursor) {
    const cursorSnap = await db.collection("transactions").doc(args.cursor as string).get();
    if (cursorSnap.exists && cursorSnap.data()?.userId === userId) {
      query = query.startAfter(cursorSnap);
    }
  }

  const requestedLimit = Math.min(Math.max((args.limit as number) || 50, 1), 500);
  const scanLimit = Math.min(requestedLimit * 5, 1000);
  query = query.limit(scanLimit);

  const snapshot = await query.get();
  const scanned = snapshot.docs.map((doc) => {
    const data = doc.data();
    return { id: doc.id, ...data, date: toLocalDate(data.date) || data.date } as Record<string, unknown>;
  });

  let matching = scanned.filter(keep);

  if (args.minAmount !== undefined) {
    const minAmount = args.minAmount as number;
    matching = matching.filter((t) => Math.abs((t.amount as number) || 0) >= minAmount);
  }

  const page = matching.slice(0, requestedLimit);
  const truncated = matching.length > requestedLimit;
  const hasMore = truncated || scanned.length === scanLimit;

  const nextCursor = !hasMore
    ? null
    : truncated
      ? (page[page.length - 1].id as string)
      : ((scanned[scanned.length - 1]?.id as string) ?? null);

  return { page, nextCursor };
}

export async function listTransactionsNeedingFiles(userId: string, args: Record<string, unknown>) {
  // "needs a receipt" is three absent-field tests: no files, no no-receipt
  // category, not parked on the quota limit.
  const { page, nextCursor } = await scanTransactionsPage(
    userId,
    args,
    (t) =>
      (!(t.fileIds as string[]) || (t.fileIds as string[]).length === 0) &&
      !t.noReceiptCategoryId &&
      !t.quotaExceeded
  );

  return { transactions: page, nextCursor, count: page.length };
}

/**
 * The chase queue (#104): transactions holding a receipt but no invoice.
 *
 * `documentationState` is a present-field equality Firestore could filter on
 * directly, but that needs a composite index alongside the date ordering, and
 * the sibling listing already established the over-fetch shape — so this uses
 * the same scan, with the same cursor semantics.
 */
export async function listTransactionsMissingInvoice(userId: string, args: Record<string, unknown>) {
  const { page, nextCursor } = await scanTransactionsPage(
    userId,
    args,
    (t) => t.documentationState === "receipt-only"
  );

  // Only the page's own documents are read — the § 11 defect list is what
  // makes the row actionable, and reading it for rows nobody asked for would
  // turn a listing into a fan-out.
  const transactions = await Promise.all(
    page.map(async (t) => {
      const fileIds = (t.fileIds as string[] | undefined) ?? [];
      const files = await Promise.all(
        fileIds.slice(0, 10).map(async (fileId) => {
          const snap = await db.collection("files").doc(fileId).get();
          if (!snap.exists) return null;
          const data = snap.data()!;
          return {
            fileId,
            fileName: data.fileName ?? null,
            documentType: data.documentType ?? null,
            missingElements: data.documentTypeMissingElements ?? [],
            basisReason: (data.documentTypeBasis as { reason?: string } | undefined)?.reason ?? null,
          };
        })
      );

      const documents = files.filter((f): f is NonNullable<typeof f> => f !== null);
      const missingElements = [...new Set(documents.flatMap((d) => d.missingElements as string[]))];

      return {
        id: t.id,
        date: t.date,
        amount: t.amount,
        currency: t.currency ?? "EUR",
        name: t.name ?? null,
        partner: t.partner ?? t.partnerName ?? null,
        partnerId: t.partnerId ?? null,
        documentationState: t.documentationState,
        missingElements,
        documents,
      };
    })
  );

  return { transactions, nextCursor, count: transactions.length };
}

// ============================================================================
// Files
// ============================================================================

export async function listFiles(userId: string, args: Record<string, unknown>) {
  let query = db.collection("files").where("userId", "==", userId).orderBy("uploadedAt", "desc");

  const limit = Math.min((args.limit as number) || 50, 100);
  query = query.limit(limit);

  const snapshot = await query.get();
  let files = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((f: Record<string, unknown>) => !f.deletedAt && !f.isNotInvoice);

  if (args.hasConnections !== undefined) {
    files = files.filter((f: Record<string, unknown>) =>
      args.hasConnections
        ? ((f.transactionIds as string[])?.length || 0) > 0
        : ((f.transactionIds as string[])?.length || 0) === 0
    );
  }

  if (args.hasSuggestions !== undefined) {
    files = files.filter((f: Record<string, unknown>) =>
      args.hasSuggestions
        ? ((f.transactionSuggestions as unknown[])?.length || 0) > 0
        : ((f.transactionSuggestions as unknown[])?.length || 0) === 0
    );
  }

  // #203: the review queue for documents printing a rate Austria does not
  // have. In memory like the filters above, and for the same reason — the flag
  // is absent on every record written before the detector existed, and
  // Firestore has no "field missing" predicate.
  if (args.needsVatRateReview !== undefined) {
    files = files.filter((f: Record<string, unknown>) =>
      args.needsVatRateReview ? f.needsVatRateReview === true : f.needsVatRateReview !== true
    );
  }

  return files;
}

export async function getFile(userId: string, fileId: string) {
  if (!fileId) throw new Error("fileId is required");

  const doc = await db.collection("files").doc(fileId).get();
  if (!doc.exists || doc.data()?.userId !== userId) {
    throw new Error("File not found");
  }
  return { id: doc.id, ...doc.data() };
}

export async function connectFileToTransaction(userId: string, args: Record<string, unknown>) {
  const { fileId, transactionId } = args;
  if (!fileId || !transactionId) {
    throw new Error("fileId and transactionId are required");
  }

  const [fileDoc, txDoc] = await Promise.all([
    db.collection("files").doc(fileId as string).get(),
    db.collection("transactions").doc(transactionId as string).get(),
  ]);

  if (!fileDoc.exists || fileDoc.data()?.userId !== userId) {
    throw new Error("File not found");
  }
  if (!txDoc.exists || txDoc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }

  if (txDoc.data()?.quotaExceeded) {
    throw new Error("Cannot connect files to over-quota transactions via API");
  }

  // A rejected pair does not reconnect (fork #101). This handler backs both
  // connect_file_to_transaction and the best-suggestion loop in
  // auto_connect_file_suggestions, so the check belongs here rather than at
  // either caller.
  //
  // Unlike the chat tool, there is no override argument on the MCP surface: an
  // external caller that means it can lift the rejection first with
  // undismiss_transaction_suggestion, which leaves a record of having done so.
  if (
    isTransactionDismissedForFile(
      fileDoc.data() as DismissibleFileState,
      transactionId as string
    )
  ) {
    throw new Error(
      "PAIR_REJECTED: this file was rejected for this transaction. " +
        "Use undismiss_transaction_suggestion first if connecting it is genuinely intended."
    );
  }

  const batch = db.batch();
  const now = FieldValue.serverTimestamp();

  const connRef = db.collection("fileConnections").doc();
  batch.set(connRef, {
    fileId,
    transactionId,
    userId,
    connectionType: "api",
    createdAt: now,
  });

  batch.update(fileDoc.ref, {
    transactionIds: FieldValue.arrayUnion(transactionId),
    updatedAt: now,
  });

  batch.update(txDoc.ref, {
    fileIds: FieldValue.arrayUnion(fileId),
    isComplete: true,
    updatedAt: now,
  });

  await batch.commit();
  return { success: true, fileId, transactionId };
}

export async function disconnectFileFromTransaction(userId: string, args: Record<string, unknown>) {
  const { fileId, transactionId } = args;
  if (!fileId || !transactionId) {
    throw new Error("fileId and transactionId are required");
  }

  const connSnapshot = await db
    .collection("fileConnections")
    .where("fileId", "==", fileId)
    .where("transactionId", "==", transactionId)
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (connSnapshot.empty) {
    throw new Error("Connection not found");
  }

  const batch = db.batch();
  const now = FieldValue.serverTimestamp();

  batch.delete(connSnapshot.docs[0].ref);

  batch.update(db.collection("files").doc(fileId as string), {
    transactionIds: FieldValue.arrayRemove(transactionId),
    updatedAt: now,
  });

  batch.update(db.collection("transactions").doc(transactionId as string), {
    fileIds: FieldValue.arrayRemove(fileId),
    updatedAt: now,
  });

  await batch.commit();
  return { success: true, fileId, transactionId };
}

/**
 * Flag a file as not an invoice — the tool-surface twin of the
 * markFileAsNotInvoice callable, writing the identical field set via the
 * shared builder in files/notInvoiceOps.
 *
 * Refuses while the file is still connected to a transaction. The callable has
 * no such guard because the UI shows the connection right next to the button;
 * an agent working from a list does not, and a flagged-but-connected file is a
 * transaction whose receipt has silently become a non-receipt.
 */
/**
 * Correct a file's extracted record by hand (fork #147).
 *
 * The shape rules live in `buildExtractionCorrection` so they can be tested
 * without a database; this owns ownership, the write, and the reply.
 */
export async function updateFileExtraction(userId: string, args: Record<string, unknown>) {
  const fileId = args.fileId as string;
  if (!fileId) {
    throw new Error("fileId is required");
  }

  const fileRef = db.collection("files").doc(fileId);
  const fileSnap = await fileRef.get();

  if (!fileSnap.exists || fileSnap.data()?.userId !== userId) {
    throw new Error("File not found");
  }

  // Read the keys off `args` rather than spreading it: a caller passing an
  // unknown key must not reach the update, and "absent" has to stay distinct
  // from "null" all the way down.
  const fields: FileExtractionCorrection = {};
  for (const key of ["amount", "vatAmount", "vatPercent", "date", "lineItems"] as const) {
    if (args[key] !== undefined) {
      (fields as Record<string, unknown>)[key] = args[key];
    }
  }

  let built;
  try {
    built = buildExtractionCorrection(fields);
  } catch (error) {
    if (error instanceof ExtractionCorrectionError) {
      throw new Error(error.message);
    }
    throw error;
  }

  // The § 11 classification is stored, not recomputed at read time, so a
  // correction that moves the amount or the rate must move it too — otherwise
  // the person fixes the figure and the document type stays wrong (#104).
  const corrected = { ...fileSnap.data()!, ...built.updates };
  Object.assign(built.updates, documentTypeFields(classifyFileRecord(corrected)));

  // The rate-review flag is stored the same way and goes stale the same way: a
  // correction that types 11% in, or types it back out, has to move it (#203).
  Object.assign(built.updates, vatRateReviewFields(reviewFileRecordVatRates(corrected)));

  await fileRef.update(built.updates);

  const previousDocumentType = fileSnap.data()?.documentType;
  const connectedTransactionIds = (fileSnap.data()?.transactionIds as string[] | undefined) ?? [];
  if (previousDocumentType !== built.updates.documentType && connectedTransactionIds.length > 0) {
    await syncDocumentationStateForTransactions(db, connectedTransactionIds);
  }

  const after = (await fileRef.get()).data() ?? {};
  console.log(`[updateFileExtraction] Corrected file ${fileId}`, {
    userId,
    changed: built.changed,
  });

  return {
    success: true,
    fileId,
    changed: built.changed,
    file: {
      fileName: after.fileName ?? null,
      extractedAmount: after.extractedAmount ?? null,
      extractedVatAmount: after.extractedVatAmount ?? null,
      extractedVatPercent: after.extractedVatPercent ?? null,
      lineItemsUnreconciled: after.lineItemsUnreconciled ?? false,
      extractedRateGroups: after.extractedRateGroups ?? null,
    },
  };
}

export async function markFileAsNotInvoice(userId: string, args: Record<string, unknown>) {
  const fileId = args.fileId as string;
  if (!fileId) {
    throw new Error("fileId is required");
  }

  const fileRef = db.collection("files").doc(fileId);
  const fileSnap = await fileRef.get();

  if (!fileSnap.exists || fileSnap.data()?.userId !== userId) {
    throw new Error("File not found");
  }

  const fileData = fileSnap.data()!;

  const connectedTo = (fileData.transactionIds as string[] | undefined) ?? [];
  if (connectedTo.length > 0) {
    throw new Error(
      `File is connected to ${connectedTo.length} transaction(s) — disconnect it first ` +
        `(disconnect_file_from_transaction) before marking it as not an invoice`
    );
  }

  await fileRef.update(buildMarkNotInvoiceUpdates(fileData, args.reason as string | undefined));

  console.log(`[markFileAsNotInvoice] Marked file ${fileId} as not invoice`, {
    userId,
    reason: (args.reason as string) || "Marked by user",
    via: "tools",
  });

  return { success: true, fileId, isNotInvoice: true };
}

/**
 * Restore a file as an invoice. Re-opens extraction, which is what recovers the
 * extracted fields that marking cleared — so the pair is reversible.
 */
export async function unmarkFileAsNotInvoice(userId: string, args: Record<string, unknown>) {
  const fileId = args.fileId as string;
  if (!fileId) {
    throw new Error("fileId is required");
  }

  const fileRef = db.collection("files").doc(fileId);
  const fileSnap = await fileRef.get();

  if (!fileSnap.exists || fileSnap.data()?.userId !== userId) {
    throw new Error("File not found");
  }

  const fileData = fileSnap.data()!;

  // Manual connections outrank a re-run of transaction matching.
  const manualConnections = await db
    .collection("fileConnections")
    .where("fileId", "==", fileId)
    .where("connectionType", "==", "manual")
    .get();

  await fileRef.update(buildUnmarkNotInvoiceUpdates(fileData, !manualConnections.empty));

  console.log(`[unmarkFileAsNotInvoice] Unmarked file ${fileId} as invoice`, {
    userId,
    via: "tools",
  });

  return { success: true, fileId, isNotInvoice: false };
}

/**
 * Record that a document's printed VAT is not deductible Vorsteuer (#203).
 *
 * The state transition lives in `files/nonClaimableVatOps` so the rules can be
 * tested without a database; this owns ownership, the write, and the reply.
 *
 * No connection guard, unlike mark_file_as_not_invoice: a connected file is
 * exactly the case that matters here. The whole point is that the transaction
 * keeps its receipt and stops claiming the VAT on it.
 */
export async function markFileVatNotClaimable(userId: string, args: Record<string, unknown>) {
  const fileId = args.fileId as string;
  if (!fileId) {
    throw new Error("fileId is required");
  }

  const fileRef = db.collection("files").doc(fileId);
  const fileSnap = await fileRef.get();

  if (!fileSnap.exists || fileSnap.data()?.userId !== userId) {
    throw new Error("File not found");
  }

  let updates: Record<string, unknown>;
  try {
    updates = buildMarkVatNotClaimableUpdates(args.reason, args.note);
  } catch (error) {
    if (error instanceof NonClaimableVatError) {
      throw new Error(error.message);
    }
    throw error;
  }

  await fileRef.update(updates);

  console.log(`[markFileVatNotClaimable] Marked file ${fileId} non-claimable`, {
    userId,
    reason: updates.vatNotClaimableReason,
    via: "tools",
  });

  return {
    success: true,
    fileId,
    vatNotClaimableReason: updates.vatNotClaimableReason,
    vatNotClaimableNote: updates.vatNotClaimableNote,
  };
}

/** Clear the marker. The extracted figures never moved, so nothing is restored. */
export async function unmarkFileVatNotClaimable(userId: string, args: Record<string, unknown>) {
  const fileId = args.fileId as string;
  if (!fileId) {
    throw new Error("fileId is required");
  }

  const fileRef = db.collection("files").doc(fileId);
  const fileSnap = await fileRef.get();

  if (!fileSnap.exists || fileSnap.data()?.userId !== userId) {
    throw new Error("File not found");
  }

  await fileRef.update(buildClearVatNotClaimableUpdates());

  console.log(`[unmarkFileVatNotClaimable] Cleared non-claimable marker on ${fileId}`, {
    userId,
    via: "tools",
  });

  return { success: true, fileId, vatNotClaimableReason: null };
}

/**
 * Read the file, build the dismissal updates and write them in one Firestore
 * transaction. The builders rewrite whole arrays, so a plain read-then-update
 * would drop one of two rejections racing on the same file — and an agent sweep
 * is exactly the caller that issues them back to back.
 *
 * A missing file and another user's file are refused separately: an agent
 * working a list needs to tell "this id is stale" from "this id is not mine",
 * and the callable draws the same distinction.
 */
async function applyDismissalUpdate<T extends { updates: Record<string, unknown> }>(
  userId: string,
  args: Record<string, unknown>,
  build: (fileData: DismissibleFileState, transactionId: string) => T
): Promise<T & { fileId: string; transactionId: string }> {
  const fileId = args.fileId as string;
  const transactionId = args.transactionId as string;

  if (!fileId) {
    throw new Error("fileId is required");
  }
  if (!transactionId) {
    throw new Error("transactionId is required");
  }

  const fileRef = db.collection("files").doc(fileId);

  const outcome = await db.runTransaction(async (tx) => {
    const fileSnap = await tx.get(fileRef);

    if (!fileSnap.exists) {
      throw new Error("File not found");
    }
    if (fileSnap.data()?.userId !== userId) {
      throw new Error("Access denied");
    }

    const built = build(fileSnap.data() as DismissibleFileState, transactionId);
    // An undo of a pair that was never dismissed builds nothing, and Firestore
    // refuses an empty update — so there is no write at all, not even updatedAt.
    if (Object.keys(built.updates).length > 0) {
      tx.update(fileRef, built.updates);
    }
    return built;
  });

  return { ...outcome, fileId, transactionId };
}

/**
 * Reject a proposed file-to-transaction pair — the tool-surface twin of the
 * dismissTransactionSuggestion callable, writing the identical field set via
 * the shared builder in files/dismissSuggestionOps.
 *
 * Rejecting a pair that is not currently suggested succeeds and reports a null
 * confidence, so a sweep that re-runs over its own work list is a no-op rather
 * than a pile of duplicate rejection records.
 */
export async function dismissTransactionSuggestion(userId: string, args: Record<string, unknown>) {
  const reasonProblem = checkDismissalReason(args.reason);
  if (reasonProblem) {
    throw new Error(reasonProblem);
  }
  const reason = args.reason as string | undefined;

  const { fileId, transactionId, dismissedConfidence, alreadyDismissed } =
    await applyDismissalUpdate(userId, args, (fileData, txId) =>
      buildDismissSuggestionUpdates(fileData, txId, reason)
    );

  console.log(`[dismissTransactionSuggestion] Dismissed suggestion for file ${fileId}`, {
    userId,
    transactionId,
    alreadyDismissed,
    via: "tools",
  });

  return { success: true, fileId, transactionId, dismissedConfidence };
}

/**
 * Undo a rejection — the tool-surface twin of the undismissTransactionSuggestion
 * callable, writing the identical field set via the shared builder.
 *
 * Clears the blacklist so transaction matching may propose the pair again; it
 * does not put the suggestion back, because the match sources that justified it
 * were not kept. The rejection itself stays on the file as history.
 */
export async function undismissTransactionSuggestion(
  userId: string,
  args: Record<string, unknown>
) {
  const { fileId, transactionId, wasDismissed } = await applyDismissalUpdate(
    userId,
    args,
    buildUndismissSuggestionUpdates
  );

  console.log(`[undismissTransactionSuggestion] Restored suggestion for file ${fileId}`, {
    userId,
    transactionId,
    wasDismissed,
    via: "tools",
  });

  return { success: true, fileId, transactionId, wasDismissed };
}

export async function autoConnectFileSuggestions(userId: string, args: Record<string, unknown>) {
  const minConfidence = (args.minConfidence as number) || 89;
  const fileId = args.fileId as string | undefined;

  let files: Record<string, unknown>[];

  if (fileId) {
    const doc = await db.collection("files").doc(fileId).get();
    if (!doc.exists || doc.data()?.userId !== userId) {
      throw new Error("File not found");
    }
    files = [{ id: doc.id, ...doc.data() }];
  } else {
    const snapshot = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("transactionMatchComplete", "==", true)
      .get();

    files = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter(
        (f: Record<string, unknown>) =>
          !f.deletedAt &&
          !f.isNotInvoice &&
          (!(f.transactionIds as string[]) || (f.transactionIds as string[]).length === 0) &&
          (f.transactionSuggestions as Array<{ confidence: number }>)?.some(
            (s) => s.confidence >= minConfidence
          )
      );
  }

  const result = { connected: 0, skipped: 0, connections: [] as Record<string, unknown>[] };

  for (const file of files) {
    if ((file.transactionIds as string[])?.length > 0) {
      result.skipped++;
      continue;
    }

    const suggestions = file.transactionSuggestions as Array<{
      transactionId: string;
      confidence: number;
    }>;
    const bestSuggestion = suggestions
      ?.filter((s) => s.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence)[0];

    if (!bestSuggestion) {
      result.skipped++;
      continue;
    }

    try {
      await connectFileToTransaction(userId, {
        fileId: file.id,
        transactionId: bestSuggestion.transactionId,
      });
      result.connected++;
      result.connections.push({
        fileId: file.id,
        transactionId: bestSuggestion.transactionId,
        confidence: bestSuggestion.confidence,
      });
    } catch {
      result.skipped++;
    }
  }

  return result;
}

// ============================================================================
// Categories
// ============================================================================

export async function listNoReceiptCategories(userId: string) {
  const snapshot = await db
    .collection("noReceiptCategories")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .orderBy("name", "asc")
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function assignNoReceiptCategory(userId: string, args: Record<string, unknown>) {
  const { transactionId, categoryId } = args;
  if (!transactionId || !categoryId) {
    throw new Error("transactionId and categoryId are required");
  }

  const [txDoc, catDoc] = await Promise.all([
    db.collection("transactions").doc(transactionId as string).get(),
    db.collection("noReceiptCategories").doc(categoryId as string).get(),
  ]);

  if (!txDoc.exists || txDoc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }
  if (!catDoc.exists || catDoc.data()?.userId !== userId) {
    throw new Error("Category not found");
  }

  const catData = catDoc.data()!;
  const batch = db.batch();
  const now = FieldValue.serverTimestamp();

  batch.update(txDoc.ref, {
    noReceiptCategoryId: categoryId,
    noReceiptCategoryTemplateId: catData.templateId,
    noReceiptCategoryMatchedBy: "api",
    isComplete: true,
    updatedAt: now,
  });

  batch.update(catDoc.ref, {
    transactionCount: FieldValue.increment(1),
    updatedAt: now,
  });

  await batch.commit();
  return { success: true, transactionId, categoryId, categoryName: catData.name };
}

export async function removeNoReceiptCategory(userId: string, transactionId: string) {
  if (!transactionId) throw new Error("transactionId is required");

  const txDoc = await db.collection("transactions").doc(transactionId).get();
  if (!txDoc.exists || txDoc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }

  const txData = txDoc.data()!;
  const categoryId = txData.noReceiptCategoryId;
  if (!categoryId) {
    throw new Error("Transaction has no category assigned");
  }

  const hasFiles = txData.fileIds && txData.fileIds.length > 0;
  const batch = db.batch();
  const now = FieldValue.serverTimestamp();

  batch.update(txDoc.ref, {
    noReceiptCategoryId: null,
    noReceiptCategoryTemplateId: null,
    noReceiptCategoryMatchedBy: null,
    isComplete: hasFiles,
    updatedAt: now,
  });

  batch.update(db.collection("noReceiptCategories").doc(categoryId), {
    transactionCount: FieldValue.increment(-1),
    updatedAt: now,
  });

  await batch.commit();
  return { success: true, transactionId, isComplete: hasFiles };
}

// ============================================================================
// Partners
// ============================================================================

/**
 * List the user's identity entities (personalEntity + companies[]). These
 * are the parties an invoice can be issued FROM. Returned in a flat array
 * with `type: "person" | "company"` so MCP callers can pick an entityId
 * to pass as `issuerEntityId` in update_invoice.
 */
export async function listIdentityEntities(userId: string) {
  const snap = await db.doc(`users/${userId}/settings/userData`).get();
  if (!snap.exists) return { entities: [] };
  const data = snap.data() || {};
  const entities: Array<Record<string, unknown>> = [];
  if (data.personalEntity && data.personalEntity.id) {
    entities.push({ ...data.personalEntity, type: "person" });
  }
  if (Array.isArray(data.companies)) {
    for (const c of data.companies) {
      if (c && c.id) entities.push({ ...c, type: "company" });
    }
  }
  return { entities };
}

/**
 * Patch an existing identity entity (personalEntity or one of companies[]).
 * Accepts a sparse patch of name / vatId / ibans / address. Used by MCP
 * agents to bring a company entity up to invoice-ready state (IBAN, VAT,
 * address) without forcing the user into the settings UI.
 */
export async function updateIdentityEntity(
  userId: string,
  args: Record<string, unknown>,
) {
  const entityId = String(args.entityId || "");
  if (!entityId) throw new Error("entityId is required");
  const patch = (args.patch as Record<string, unknown>) || {};

  const docRef = db.doc(`users/${userId}/settings/userData`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) throw new Error("User data not found");
    const data = snap.data() as Record<string, unknown>;

    const applyPatch = (entity: Record<string, unknown>) => {
      const next: Record<string, unknown> = { ...entity };
      if (typeof patch.name === "string") next.name = patch.name.trim();
      if (typeof patch.vatId === "string") {
        const v = patch.vatId.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (v) next.vatId = v; else delete next.vatId;
      }
      if (Array.isArray(patch.ibans)) {
        next.ibans = (patch.ibans as unknown[])
          .map((i) => String(i).trim().toUpperCase().replace(/\s+/g, ""))
          .filter(Boolean);
      }
      if (Array.isArray(patch.aliases)) {
        next.aliases = (patch.aliases as unknown[])
          .map((a) => String(a).trim())
          .filter(Boolean);
      }
      if (patch.address !== undefined) {
        const addr = (patch.address as Record<string, string> | null) || null;
        if (addr) {
          const clean: Record<string, string> = {};
          if (addr.street?.trim()) clean.street = addr.street.trim();
          if (addr.postalCode?.trim()) clean.postalCode = addr.postalCode.trim();
          if (addr.city?.trim()) clean.city = addr.city.trim();
          if (addr.country?.trim()) clean.country = addr.country.trim().toUpperCase();
          if (Object.keys(clean).length > 0) next.address = clean;
        } else {
          delete next.address;
        }
      }
      return next;
    };

    const personal = data.personalEntity as Record<string, unknown> | undefined;
    if (personal && personal.id === entityId) {
      data.personalEntity = applyPatch(personal);
    } else {
      const companies = (data.companies as Array<Record<string, unknown>>) || [];
      const idx = companies.findIndex((c) => c.id === entityId);
      if (idx < 0) throw new Error(`Identity entity ${entityId} not found`);
      companies[idx] = applyPatch(companies[idx]);
      data.companies = companies;
    }
    data.updatedAt = FieldValue.serverTimestamp();
    tx.set(docRef, data, { merge: true });
  });

  return { success: true, entityId };
}

export async function listPartners(userId: string, args: Record<string, unknown>) {
  const snapshot = await db
    .collection("partners")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .orderBy("name", "asc")
    .get();

  let partners = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      name: data.name,
      aliases: data.aliases || [],
      vatId: data.vatId || null,
      ibans: data.ibans || [],
      website: data.website || null,
      country: data.country || null,
      defaultCategoryId: data.defaultCategoryId || null,
      billingCycle: toApiBillingCycle(data.billingCycle),
    };
  });

  if (args.search) {
    const search = (args.search as string).toLowerCase();
    partners = partners.filter(
      (p) =>
        p.name?.toLowerCase().includes(search) ||
        p.aliases?.some((a: string) => a.toLowerCase().includes(search))
    );
  }

  const limit = Math.min((args.limit as number) || 50, 100);
  return partners.slice(0, limit);
}

export async function getPartner(userId: string, partnerId: string) {
  if (!partnerId) throw new Error("partnerId is required");

  const doc = await db.collection("partners").doc(partnerId).get();
  if (!doc.exists || doc.data()?.userId !== userId) {
    throw new Error("Partner not found");
  }
  const data = doc.data()!;
  // The stored cycle carries Timestamps, which do not survive JSON — the
  // billing cycle goes out in the same shape both partner tools return.
  return { id: doc.id, ...data, billingCycle: toApiBillingCycle(data.billingCycle) };
}

export async function createPartner(userId: string, args: Record<string, unknown>) {
  const { createUserPartnerInternal } = await import("../partners/createUserPartner");
  return createUserPartnerInternal(db, userId, {
    name: args.name as string,
    aliases: args.aliases as string[] | undefined,
    vatId: args.vatId as string | undefined,
    ibans: args.ibans as string[] | undefined,
    website: args.website as string | undefined,
    country: args.country as string | undefined,
  });
}

// ============================================================================
// Partner billing cycle (#167)
// ============================================================================

const DOCUMENT_EXPECTATIONS: BillingDocumentExpectation[] = [
  "invoice",
  "no-receipt-category",
  "nothing",
];

/** A partner's stored billing cycle, one entry per recurrence in each half. */
interface StoredBillingCycle {
  learned?: Array<DerivedBillingCycle & { learnedAt?: unknown }>;
  declared?: DeclaredCycleInput[];
  effective?: ResolvedEffectiveCycle[];
}

function readStoredBillingCycle(raw: unknown): StoredBillingCycle {
  if (!raw || typeof raw !== "object") return {};
  const cycle = raw as StoredBillingCycle;
  return {
    learned: Array.isArray(cycle.learned) ? cycle.learned : [],
    declared: Array.isArray(cycle.declared) ? cycle.declared : [],
    effective: Array.isArray(cycle.effective) ? cycle.effective : [],
  };
}

/**
 * The billing cycle as the tools return it: the effective view plus the two
 * halves it was resolved from. Null for a partner that does not bill on a
 * schedule, so a client can test the field rather than an empty hull.
 */
function toApiBillingCycle(raw: unknown): Record<string, unknown> | null {
  const { learned = [], declared = [], effective = [] } = readStoredBillingCycle(raw);
  if (learned.length === 0 && declared.length === 0 && effective.length === 0) return null;

  return {
    effective,
    // learnedAt is an instant, not a calendar day: ISO, not YYYY-MM-DD.
    learned: learned.map((cycle) => ({
      ...cycle,
      learnedAt: toIsoInstant(cycle.learnedAt),
    })),
    declared,
  };
}

function toIsoInstant(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "object" && typeof (value as Timestamp).toDate === "function") {
    const date = (value as Timestamp).toDate();
    return isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") return value;
  return null;
}

/**
 * Declare, change or clear the declared half of a partner's billing cycle.
 *
 * The learned half is never written here — a re-learn and a declaration are
 * two independent lanes over one field, and the effective view is re-resolved
 * from both by the same pure function the learner uses. `declared: null`
 * drops every declaration; with nothing learned to fall back on the field
 * goes entirely rather than lingering as an empty hull.
 */
export async function setPartnerBillingCycle(userId: string, args: Record<string, unknown>) {
  const { partnerId } = args;
  if (!partnerId) throw new Error("partnerId is required");
  if (!("declared" in args)) {
    throw new Error("declared is required (pass null to clear the declared cycle)");
  }

  const partnerRef = db.collection("partners").doc(partnerId as string);
  const partnerSnap = await partnerRef.get();
  if (!partnerSnap.exists || partnerSnap.data()?.userId !== userId) {
    throw new Error("Partner not found");
  }

  const declared = args.declared === null ? [] : parseDeclaredCycles(args.declared);
  const { learned = [] } = readStoredBillingCycle(partnerSnap.data()!.billingCycle);
  const effective = resolveEffectiveCycles(learned, declared);

  if (declared.length === 0 && learned.length === 0) {
    await partnerRef.update({
      billingCycle: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { success: true, partnerId, billingCycle: null };
  }

  // Written whole rather than by dotted path: clearing has to remove the
  // declared half, and a field-path delete cannot run in the same update as
  // the effective view it changes.
  const billingCycle = {
    ...(learned.length > 0 ? { learned } : {}),
    ...(declared.length > 0 ? { declared } : {}),
    effective,
  };
  await partnerRef.update({ billingCycle, updatedAt: FieldValue.serverTimestamp() });

  return { success: true, partnerId, billingCycle: toApiBillingCycle(billingCycle) };
}

/** One declared recurrence, or an array of them (one per amount band). */
function parseDeclaredCycles(raw: unknown): DeclaredCycleInput[] {
  const entries = Array.isArray(raw) ? raw : [raw];
  if (entries.length === 0) return [];

  const declared = entries.map(parseDeclaredCycle);

  // Resolution matches a declaration to a learned recurrence by its band, so
  // two declarations that cannot be told apart would fold onto one another.
  const bands = declared.map((d) => d.amountBand ?? null);
  if (new Set(bands).size !== bands.length) {
    throw new Error("each declared recurrence needs its own amountBand");
  }

  return declared;
}

function parseDeclaredCycle(raw: unknown): DeclaredCycleInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("declared must be an object, an array of objects, or null");
  }
  const input = raw as Record<string, unknown>;

  const cadence = input.cadence as BillingCadence | undefined;
  if (cadence !== undefined && !(cadence in CADENCE_DAYS)) {
    throw new Error(
      `declared.cadence must be one of: ${Object.keys(CADENCE_DAYS).join(", ")} ` +
      "(or give declared.frequencyDays instead)"
    );
  }

  const frequencyDays = requireDays(input, cadence);
  const expectedAmountMin = optionalCents(input.expectedAmountMin, "declared.expectedAmountMin");
  const expectedAmountMax = optionalCents(input.expectedAmountMax, "declared.expectedAmountMax");
  if (
    expectedAmountMin !== undefined &&
    expectedAmountMax !== undefined &&
    expectedAmountMin > expectedAmountMax
  ) {
    throw new Error("declared.expectedAmountMin must not exceed declared.expectedAmountMax");
  }

  let amountBand = optionalCents(input.amountBand, "declared.amountBand");
  // A band given as a range still needs its nominal amount: that is what a
  // declaration is matched to a learned recurrence by.
  if (amountBand === undefined && expectedAmountMin !== undefined && expectedAmountMax !== undefined) {
    amountBand = Math.round(((expectedAmountMin + expectedAmountMax) / 2) * 100) / 100;
  }

  const expectation = (input.documentExpectation ?? "invoice") as BillingDocumentExpectation;
  if (!DOCUMENT_EXPECTATIONS.includes(expectation)) {
    throw new Error(
      `declared.documentExpectation must be one of: ${DOCUMENT_EXPECTATIONS.join(", ")}`
    );
  }

  let currency: string | undefined;
  if (input.currency !== undefined && input.currency !== null) {
    if (typeof input.currency !== "string" || !/^[A-Za-z]{3}$/.test(input.currency)) {
      throw new Error("declared.currency must be a three-letter code, e.g. EUR");
    }
    currency = input.currency.toUpperCase();
  }

  // Spread conditionally: Firestore rejects an undefined value outright.
  return {
    frequencyDays,
    ...(amountBand !== undefined ? { amountBand } : {}),
    ...(expectedAmountMin !== undefined ? { expectedAmountMin } : {}),
    ...(expectedAmountMax !== undefined ? { expectedAmountMax } : {}),
    ...(currency !== undefined ? { currency } : {}),
    documentExpectation: expectation,
  };
}

function requireDays(input: Record<string, unknown>, cadence: BillingCadence | undefined): number {
  const named = cadence !== undefined ? CADENCE_DAYS[cadence] : undefined;
  const given = input.frequencyDays;

  if (given !== undefined && given !== null) {
    if (typeof given !== "number" || !Number.isFinite(given) || given <= 0) {
      throw new Error("declared.frequencyDays must be a positive number of days");
    }
    if (named !== undefined && Math.round(given) !== named) {
      throw new Error(
        `declared.cadence "${cadence}" is ${named} days — drop declared.frequencyDays or give ${named}`
      );
    }
    return Math.round(given);
  }

  if (named === undefined) {
    throw new Error("declared needs either a cadence or frequencyDays");
  }
  return named;
}

function optionalCents(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative amount in cents`);
  }
  return value;
}

/**
 * Every partner that bills on a schedule, with what a subscription view needs
 * to render without a second call per partner: the cycle, the last charge
 * seen, the next expected window and the document coverage of its charges.
 *
 * **This response shape is a contract** — yazzbert/homelab#134 renders from it
 * directly. Keep it stable.
 *
 * "Recurring" is an effective cycle, declared or learned, which lives in a
 * nested array Firestore cannot filter on: the partners are read the way
 * `list_partners` reads them and filtered here, and only the page's partners
 * cost a transaction query.
 */
export async function listRecurringPartners(userId: string, args: Record<string, unknown>) {
  const dateTo = (args.dateTo as string | undefined) ?? new Date().toISOString().slice(0, 10);
  const rangeEnd = dayEndExclusiveUtc(dateTo);
  if (!rangeEnd) {
    throw new Error(`dateTo must be a calendar day as YYYY-MM-DD, got "${args.dateTo}"`);
  }
  const dateFrom = (args.dateFrom as string | undefined) ?? defaultCoverageStart(dateTo);
  const rangeStart = dayStartUtc(dateFrom);
  if (!rangeStart) {
    throw new Error(`dateFrom must be a calendar day as YYYY-MM-DD, got "${args.dateFrom}"`);
  }

  const snapshot = await db
    .collection("partners")
    .where("userId", "==", userId)
    .where("isActive", "==", true)
    .orderBy("name", "asc")
    .get();

  const recurring = snapshot.docs
    .map((doc) => ({ id: doc.id, data: doc.data(), cycle: readStoredBillingCycle(doc.data().billingCycle) }))
    .filter((partner) => (partner.cycle.effective?.length ?? 0) > 0);

  // The cursor is the last partner id of the previous page; an unknown one
  // starts from the beginning, as it does in the transaction listings.
  const cursorIndex = args.cursor
    ? recurring.findIndex((partner) => partner.id === (args.cursor as string))
    : -1;
  const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  const limit = Math.min(Math.max((args.limit as number) || 25, 1), 100);
  const page = recurring.slice(start, start + limit);

  const partners = [];
  for (const partner of page) {
    partners.push(
      await buildRecurringPartner(
        userId,
        partner.id,
        partner.data,
        partner.cycle,
        rangeStart,
        rangeEnd
      )
    );
  }

  return {
    partners,
    nextCursor: start + page.length < recurring.length ? page[page.length - 1].id : null,
    count: partners.length,
    dateFrom,
    dateTo,
  };
}

/** Default coverage window: wide enough that a yearly charge is seen once. */
function defaultCoverageStart(dateTo: string): string {
  const end = dayStartUtc(dateTo) ?? new Date();
  const from = new Date(end);
  from.setUTCMonth(from.getUTCMonth() - DEFAULT_COVERAGE_MONTHS);
  return from.toISOString().slice(0, 10);
}

/** One charge of a recurring partner, as read off the transaction. */
interface RecurringCharge {
  id: string;
  date: Date;
  /** Signed, in the account's currency — the amount the bands were learned on. */
  amount: number;
  currency: string;
  hasFile: boolean;
  hasCategory: boolean;
  noReceiptCategoryId: string | null;
  /** What the bank says it actually charged, before settling (#112). */
  billed: { amount: number; currency: string } | null;
}

async function buildRecurringPartner(
  userId: string,
  partnerId: string,
  data: Record<string, unknown>,
  cycle: StoredBillingCycle,
  rangeStart: Date,
  rangeEnd: Date
) {
  // partnerId only — never bankPartnerId: the card descriptor's partner is
  // not the supplier whose cycle this is.
  const snapshot = await db
    .collection("transactions")
    .where("userId", "==", userId)
    .where("partnerId", "==", partnerId)
    .where("date", "<", Timestamp.fromDate(rangeEnd))
    .orderBy("date", "desc")
    .limit(CHARGE_SCAN_LIMIT)
    .get();

  const charges = snapshot.docs
    .map((doc) => toRecurringCharge(doc.id, doc.data()))
    .filter((charge): charge is RecurringCharge => charge !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const effective = cycle.effective ?? [];
  const primary = effective[0];
  // Which recurrence a charge belongs to is the same band selection the
  // matcher makes, on the same amount the bands were learned from. A charge
  // that belongs to no band — a one-off payment to a recurring vendor — is
  // counted for the partner but is nobody's recurrence, so it can't push a
  // stray amount into the weekly band's last charge.
  const bandOf = (charge: RecurringCharge) =>
    selectEffectiveCycleForAmount(effective, charge.amount);
  const expectationOf = (charge: RecurringCharge) => bandOf(charge) ?? primary;
  const inRange = charges.filter((charge) => charge.date.getTime() >= rangeStart.getTime());
  const lastCharge = charges[0] ?? null;

  return {
    partnerId,
    name: data.name ?? null,
    // The vendor's own site is where a missing invoice gets downloaded from.
    website: data.website ?? null,
    billingCycle: toApiBillingCycle(data.billingCycle),
    lastCharge: lastCharge ? toApiCharge(lastCharge) : null,
    nextExpected: toApiWindow(
      nextExpectedCharge(lastCharge?.date ?? null, lastCharge ? expectationOf(lastCharge) : primary)
    ),
    coverage: summarizeChargeCoverage(
      inRange.map((charge) => toDocumentation(charge, expectationOf(charge)))
    ),
    recurrences: effective.map((band) => {
      const ofBand = (charge: RecurringCharge) => bandOf(charge) === band;
      const last = charges.find(ofBand) ?? null;
      return {
        amountBand: band.amountBand ?? null,
        source: band.source,
        frequencyDays: band.frequencyDays,
        frequencyConfidence: band.frequencyConfidence ?? null,
        typicalDayOfMonth: band.typicalDayOfMonth ?? null,
        documentExpectation: band.documentExpectation ?? "invoice",
        lastCharge: last ? toApiCharge(last) : null,
        nextExpected: toApiWindow(nextExpectedCharge(last?.date ?? null, band)),
        coverage: summarizeChargeCoverage(
          inRange.filter(ofBand).map((charge) => toDocumentation(charge, band))
        ),
      };
    }),
  };
}

function toRecurringCharge(id: string, data: Record<string, unknown>): RecurringCharge | null {
  const date = data.date instanceof Date
    ? data.date
    : typeof (data.date as Timestamp | undefined)?.toDate === "function"
      ? (data.date as Timestamp).toDate()
      : null;
  if (!date || isNaN(date.getTime())) return null;

  const original = readBankOriginalAmount(
    (data._original as { rawRow?: Record<string, string> } | undefined)?.rawRow
  );

  return {
    id,
    date,
    amount: typeof data.amount === "number" ? data.amount : 0,
    currency: (data.currency as string) || "EUR",
    hasFile: ((data.fileIds as string[] | undefined) ?? []).length > 0,
    hasCategory: !!data.noReceiptCategoryId,
    noReceiptCategoryId: (data.noReceiptCategoryId as string | undefined) ?? null,
    billed: original ? { amount: original.amount, currency: original.currency } : null,
  };
}

function toDocumentation(
  charge: RecurringCharge,
  band: ResolvedEffectiveCycle | undefined
): ChargeDocumentation {
  return {
    hasFile: charge.hasFile,
    hasCategory: charge.hasCategory,
    documentExpectation: band?.documentExpectation,
  };
}

/**
 * A charge, in the currency it was billed in and in EUR.
 *
 * The bank books in the account's currency; what the vendor actually charged
 * is the bank's own stated original (#112), which is why nothing here
 * converts. Both figures are ABSOLUTE cents — unlike the signed amounts
 * `list_transactions` returns, a charge is a charge whichever way it was
 * booked. `amountEur` is null when the account is not in EUR: no rate is
 * stored to convert with, and a guess would end up in a run-rate.
 */
function toApiCharge(charge: RecurringCharge) {
  return {
    transactionId: charge.id,
    date: toLocalDate(charge.date),
    amount: charge.billed ? charge.billed.amount : Math.abs(charge.amount),
    currency: charge.billed ? charge.billed.currency : charge.currency,
    amountEur: charge.currency.toUpperCase() === "EUR" ? Math.abs(charge.amount) : null,
    hasFile: charge.hasFile,
    hasCategory: charge.hasCategory,
    noReceiptCategoryId: charge.noReceiptCategoryId,
  };
}

function toApiWindow(window: ExpectedChargeWindow | null) {
  if (!window) return null;
  return {
    expectedAt: toLocalDate(window.expectedAt),
    from: toLocalDate(window.from),
    to: toLocalDate(window.to),
    varianceDays: window.varianceDays,
  };
}

export async function assignPartnerToTx(userId: string, args: Record<string, unknown>) {
  const { transactionId, partnerId } = args;
  if (!transactionId) throw new Error("transactionId is required");
  if (!partnerId) throw new Error("partnerId is required");

  // Verify transaction ownership
  const txDoc = await db.collection("transactions").doc(transactionId as string).get();
  if (!txDoc.exists || txDoc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }

  // Verify partner ownership
  const partnerDoc = await db.collection("partners").doc(partnerId as string).get();
  if (!partnerDoc.exists || partnerDoc.data()?.userId !== userId) {
    throw new Error("Partner not found");
  }

  const now = FieldValue.serverTimestamp();
  await db.collection("transactions").doc(transactionId as string).update({
    partnerId,
    partnerType: "user",
    partnerMatchedBy: "api",
    partnerMatchConfidence: null,
    updatedAt: now,
    automationHistory: FieldValue.arrayUnion({
      type: "partner_assigned",
      ranAt: Timestamp.now(),
      status: "completed",
      actor: "manual",
      level: "decision",
      partnerName: partnerDoc.data()!.name || null,
      forPartnerId: partnerId,
      summary: `Partner "${partnerDoc.data()!.name}" assigned via API`,
    }),
  });

  return { success: true, transactionId, partnerId };
}

export async function removePartnerFromTx(userId: string, args: Record<string, unknown>) {
  const { transactionId } = args;
  if (!transactionId) throw new Error("transactionId is required");

  const txDoc = await db.collection("transactions").doc(transactionId as string).get();
  if (!txDoc.exists || txDoc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }

  const txData = txDoc.data()!;
  const previousPartnerId = txData.partnerId;

  // Look up partner name for activity log
  let partnerName: string | null = null;
  if (previousPartnerId) {
    try {
      const pSnap = await db.collection("partners").doc(previousPartnerId).get();
      partnerName = pSnap.data()?.name || null;
    } catch { /* best effort */ }
  }

  const now = FieldValue.serverTimestamp();
  await db.collection("transactions").doc(transactionId as string).update({
    partnerId: null,
    partnerType: null,
    partnerMatchedBy: null,
    partnerMatchConfidence: null,
    updatedAt: now,
    automationHistory: FieldValue.arrayUnion({
      type: "partner_removed",
      ranAt: Timestamp.now(),
      status: "completed",
      actor: "manual",
      level: "decision",
      partnerName: partnerName || previousPartnerId || null,
      forPartnerId: previousPartnerId || null,
      summary: `Partner "${partnerName || previousPartnerId}" removed via API`,
    }),
  });

  return { success: true, transactionId };
}

/**
 * Read-only re-match review (fork #86). Deliberately no write path: the only
 * existing way to re-match an assigned transaction is to remove the partner
 * first, and that records a false positive that permanently vetoes the pair —
 * including for the assignments that were correct all along.
 */
function rematchNumberArg(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

function rematchAssignedBeforeArg(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("assignedBefore must be an ISO 8601 string");
  }
  if (isNaN(new Date(value).getTime())) {
    throw new Error("assignedBefore must be a valid ISO 8601 date");
  }
  return value;
}

export async function partnerRematchReport(
  userId: string,
  args: Record<string, unknown>
) {
  const { buildPartnerRematchReport } = await import(
    "../matching/partnerRematchReport"
  );

  const asNumber = rematchNumberArg;

  let matchedBy: string[] | undefined;
  if (args.matchedBy !== undefined) {
    if (!Array.isArray(args.matchedBy) ||
        args.matchedBy.some((v) => typeof v !== "string")) {
      throw new Error("matchedBy must be an array of strings");
    }
    matchedBy = args.matchedBy as string[];
  }

  return buildPartnerRematchReport(userId, {
    minConfidence: asNumber(args.minConfidence, "minConfidence"),
    maxConfidence: asNumber(args.maxConfidence, "maxConfidence"),
    assignedBefore: rematchAssignedBeforeArg(args.assignedBefore),
    matchedBy,
    limit: asNumber(args.limit, "limit"),
    includeAgreements: args.includeAgreements === true,
  });
}

/**
 * Whole-account re-match (fork #86, piece 2). Dry run unless the caller passes
 * dryRun exactly false — a boolean that defaults to "write" is how an account
 * gets rewritten by a typo.
 */
export async function rematchAssignedPartnersTool(
  userId: string,
  args: Record<string, unknown>
) {
  const { rematchAssignedPartners } = await import(
    "../matching/rematchAssignedPartners"
  );

  for (const field of ["dryRun", "clearUnconfirmed", "includeKept"]) {
    if (args[field] !== undefined && typeof args[field] !== "boolean") {
      throw new Error(`${field} must be a boolean`);
    }
  }

  // The tool takes no matchedBy: this path rewrites `auto` assignments only, and
  // an argument implying otherwise would invite exactly the mistake it forbids.
  if (args.matchedBy !== undefined) {
    throw new Error(
      "matchedBy is not accepted here — this tool only re-matches auto-assigned " +
      "transactions. Manual, suggestion and ai assignments are judgements it must not overwrite; " +
      "use partner_rematch_report to inspect those read-only."
    );
  }

  return rematchAssignedPartners(userId, {
    dryRun: args.dryRun === undefined ? true : (args.dryRun as boolean),
    clearUnconfirmed: args.clearUnconfirmed === true,
    minConfidence: rematchNumberArg(args.minConfidence, "minConfidence"),
    maxConfidence: rematchNumberArg(args.maxConfidence, "maxConfidence"),
    assignedBefore: rematchAssignedBeforeArg(args.assignedBefore),
    maxWrites: rematchNumberArg(args.maxWrites, "maxWrites"),
    limit: rematchNumberArg(args.limit, "limit"),
    includeKept: args.includeKept === true,
  });
}

// ============================================================================
// Source Management
// ============================================================================

export async function createSource(userId: string, args: Record<string, unknown>) {
  const { createSourceInternal } = await import("../sources/createSource");
  return createSourceInternal(db, userId, {
    name: args.name as string,
    accountKind: (args.accountKind as "bank_account" | "credit_card") || "bank_account",
    iban: args.iban as string | undefined,
    currency: (args.currency as string) || "EUR",
    type: "manual",
  });
}

export async function deleteSource(userId: string, args: Record<string, unknown>) {
  const { sourceId, confirm } = args;
  if (!sourceId) throw new Error("sourceId is required");
  if (confirm !== true) {
    throw new Error("Must set confirm: true to delete a source. This will delete all associated transactions.");
  }

  const { deleteSourceInternal } = await import("../sources/deleteSource");
  return deleteSourceInternal(db, userId, sourceId as string);
}

// ============================================================================
// Import
// ============================================================================

export async function importTransactions(userId: string, args: Record<string, unknown>) {
  const { sourceId, transactions: rawTxs } = args;
  if (!sourceId) throw new Error("sourceId is required");
  if (!rawTxs || !Array.isArray(rawTxs)) throw new Error("transactions array is required");

  // Verify source ownership
  const sourceDoc = await db.collection("sources").doc(sourceId as string).get();
  if (!sourceDoc.exists || sourceDoc.data()?.userId !== userId) {
    throw new Error("Source not found");
  }

  // Build transaction data with dedupeHashes
  const crypto = await import("crypto");
  const importJobId = `api_${Date.now()}`;

  const transactions = (rawTxs as Array<Record<string, unknown>>).map((tx, index) => {
    const date = tx.date as string;
    const amount = tx.amount as number;
    const name = tx.name as string;
    const currency = (tx.currency as string) || "EUR";

    // Generate dedupeHash from key fields
    const hashInput = `${sourceId}|${date}|${amount}|${name}|${currency}`;
    const dedupeHash = crypto.createHash("sha256").update(hashInput).digest("hex");

    return {
      sourceId: sourceId as string,
      date,
      amount,
      currency,
      name,
      description: (tx.description as string) || null,
      partner: (tx.partner as string) || null,
      reference: (tx.reference as string) || null,
      partnerIban: (tx.partnerIban as string) || null,
      dedupeHash,
      importJobId,
      csvRowIndex: index,
      _original: {
        date: date,
        amount: String(amount),
        rawRow: tx as Record<string, string>,
      },
    };
  });

  // Use bulk create directly (not via callable to avoid double auth check)
  const { Timestamp: AdminTimestamp } = await import("firebase-admin/firestore");
  const { checkTransactionQuota, incrementTransactionCount } = await import("../billing/checkTransactionQuota");

  const quota = await checkTransactionQuota(userId, transactions.length, false);
  const overLimitStartIndex = quota.allowed ? transactions.length : quota.remainingSlots;

  const now = AdminTimestamp.now();
  const transactionIds: string[] = [];
  const overLimitTransactionIds: string[] = [];
  const BATCH_SIZE = 500;

  let globalIndex = 0;
  for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = transactions.slice(i, i + BATCH_SIZE);

    for (const txData of chunk) {
      const docRef = db.collection("transactions").doc();
      transactionIds.push(docRef.id);

      const isOverLimit = globalIndex >= overLimitStartIndex;
      if (isOverLimit) {
        overLimitTransactionIds.push(docRef.id);
      }

      const dateObj = new Date(txData.date);
      if (isNaN(dateObj.getTime())) {
        throw new Error(`Invalid date: ${txData.date}`);
      }
      // Store the convention the rest of the system reads: UTC midnight of the
      // calendar day. A date carrying a time of day would otherwise sit an
      // hour outside the period windows that select it.
      const dateAtUtcMidnight = new Date(
        Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate())
      );

      const transactionDoc: Record<string, unknown> = {
        userId,
        sourceId: txData.sourceId,
        date: AdminTimestamp.fromDate(dateAtUtcMidnight),
        amount: txData.amount,
        currency: txData.currency,
        name: txData.name,
        description: txData.description,
        partner: txData.partner,
        reference: txData.reference,
        partnerIban: txData.partnerIban,
        dedupeHash: txData.dedupeHash,
        importJobId: txData.importJobId,
        csvRowIndex: txData.csvRowIndex,
        _original: txData._original,
        fileIds: [],
        isComplete: false,
        partnerId: null,
        partnerType: null,
        partnerMatchConfidence: null,
        partnerMatchedBy: null,
        noReceiptCategoryId: null,
        createdAt: now,
        updatedAt: now,
      };

      if (isOverLimit) {
        transactionDoc.quotaExceeded = true;
      }

      batch.set(docRef, transactionDoc);
      globalIndex++;
    }

    await batch.commit();
  }

  const withinQuotaCount = transactionIds.length - overLimitTransactionIds.length;
  if (withinQuotaCount > 0) {
    incrementTransactionCount(userId, withinQuotaCount).catch((err) =>
      console.error("[importTransactions] Failed to increment transaction count:", err)
    );
  }

  return {
    success: true,
    transactionIds,
    count: transactionIds.length,
    quotaExceeded: overLimitTransactionIds.length > 0,
    overLimitCount: overLimitTransactionIds.length,
  };
}

// ============================================================================
// File Upload & Scoring
// ============================================================================

export async function uploadFile(userId: string, args: Record<string, unknown>) {
  const { url, base64, fileName, mimeType } = args;
  if (!fileName) throw new Error("fileName is required");
  if (!mimeType) throw new Error("mimeType is required");
  if (!url && !base64) throw new Error("Either url or base64 is required");

  let fileBuffer: Buffer;

  if (base64) {
    fileBuffer = Buffer.from(base64 as string, "base64");
  } else {
    // Download from URL
    const response = await fetch(url as string);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    fileBuffer = Buffer.from(arrayBuffer);
  }

  // Upload to Storage with a Firebase download token (avoids signBlob IAM)
  const bucket = getStorage().bucket();
  const storagePath = `users/${userId}/files/${Date.now()}_${fileName}`;
  const file = bucket.file(storagePath);
  const downloadToken = randomUUID();

  await file.save(fileBuffer, {
    contentType: mimeType as string,
    metadata: {
      metadata: {
        userId,
        firebaseStorageDownloadTokens: downloadToken,
      },
    },
  });

  const downloadUrl = buildDownloadUrl(bucket.name, storagePath, downloadToken);

  // Create file record in Firestore
  const now = FieldValue.serverTimestamp();
  const fileDoc = await db.collection("files").add({
    userId,
    fileName: fileName as string,
    mimeType: mimeType as string,
    storagePath,
    downloadUrl,
    fileSize: fileBuffer.length,
    transactionIds: [],
    isNotInvoice: false,
    extractionComplete: false,
    partnerMatchComplete: false,
    transactionMatchComplete: false,
    uploadedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return {
    success: true,
    fileId: fileDoc.id,
    fileName,
    storagePath,
    fileSize: fileBuffer.length,
  };
}

export async function scoreFileTransactionMatch(userId: string, args: Record<string, unknown>) {
  const { fileId, transactionId } = args;
  if (!fileId) throw new Error("fileId is required");
  if (!transactionId) throw new Error("transactionId is required");

  // Verify ownership
  const [fileDoc, txDoc] = await Promise.all([
    db.collection("files").doc(fileId as string).get(),
    db.collection("transactions").doc(transactionId as string).get(),
  ]);

  if (!fileDoc.exists || fileDoc.data()?.userId !== userId) {
    throw new Error("File not found");
  }
  if (!txDoc.exists || txDoc.data()?.userId !== userId) {
    throw new Error("Transaction not found");
  }

  // Use the shared scoring logic
  const { scoreTransaction, formatScoreBreakdown } = await import("../matching/transactionScoring");

  const fileData = fileDoc.data()!;
  const txData = txDoc.data()!;

  const result = scoreTransaction(
    {
      extractedAmount: fileData.extractedAmount,
      extractedCurrency: fileData.extractedCurrency,
      extractedDate: fileData.extractedDate,
      extractedPartner: fileData.extractedPartner,
      extractedIban: fileData.extractedIban,
      extractedText: fileData.extractedText,
      partnerId: fileData.partnerId,
      documentType: fileData.documentType,
    },
    {
      id: transactionId as string,
      amount: txData.amount,
      date: txData.date,
      currency: txData.currency,
      name: txData.name,
      partner: txData.partner,
      partnerName: txData.partnerName,
      partnerId: txData.partnerId,
      partnerIban: txData.partnerIban,
      reference: txData.reference,
      documentationState: txData.documentationState,
    },
    []
  );

  return {
    fileId,
    transactionId,
    confidence: result.confidence,
    matchSources: result.matchSources,
    breakdown: formatScoreBreakdown(result.breakdown),
    // #104: why a confident pair still scored zero, or why it will not
    // auto-connect. Absent when the transaction has no documentation state.
    documentation: result.documentation ?? null,
  };
}

// ============================================================================
// Automation Status
// ============================================================================

/** Filter tools to those available for a given plan's features */
function getAvailableTools(features: PlanFeatures) {
  return TOOL_DEFINITIONS.filter((tool) => {
    if (!tool.requiredFeature) return true;
    return features[tool.requiredFeature];
  });
}

export async function getAutomationStatus(userId: string) {
  const subDoc = await db.collection("subscriptions").doc(userId).get();

  const planId: PlanId = (subDoc.exists ? subDoc.data()!.plan : "free") || "free";
  const plan = PLANS[planId] || PLANS.free;
  const features = plan.planFeatures;
  const availableTools = getAvailableTools(features);

  if (!subDoc.exists) {
    return {
      automationMode: "active",
      plan: "free",
      planFeatures: features,
      availableTools,
      rateLimit: plan.rateLimit,
      aiBudget: {
        fairUseLimitEur: 0.5,
        usageCurrentPeriodEur: 0,
        creditsEur: 0,
        paused: false,
      },
    };
  }

  const sub = subDoc.data()!;
  return {
    automationMode: sub.automationMode || "active",
    plan: sub.plan || "free",
    planFeatures: features,
    availableTools,
    rateLimit: plan.rateLimit,
    aiBudget: {
      fairUseLimitEur: sub.aiFairUseLimitEur ?? 0.5,
      usageCurrentPeriodEur: sub.aiUsageCurrentPeriodEur ?? 0,
      creditsEur: sub.aiCreditsEur ?? 0,
      overageCapEur: sub.aiOverageCapEur ?? 0,
      overageUsedEur: sub.aiOverageCurrentPeriodEur ?? 0,
      paused: sub.aiPaused ?? false,
    },
    transactionQuota: {
      currentCount: sub.transactionCountCurrentMonth ?? 0,
      month: sub.transactionCountMonth ?? null,
    },
  };
}

// ============================================================================
// Invoicing
// ============================================================================

export async function createInvoice(userId: string, args: Record<string, unknown>) {
  const { performCreateInvoice } = await import("../invoicing/createInvoice");
  const result = await performCreateInvoice(db, userId, {
    partnerId: args.partnerId as string,
    partnerType: ((args.partnerType as "user" | "global") || "user") as "user" | "global",
    issuerEntityId: args.issuerEntityId as string | undefined,
    issuerIban: args.issuerIban as string | undefined,
    issueDate: args.issueDate as string | undefined,
    paymentTerms: args.paymentTerms as string | undefined,
    currency: args.currency as string | undefined,
    lineItems: args.lineItems as Array<{
      description: string;
      quantity: number;
      unitPrice: number;
      vatRate?: number;
    }> | undefined,
    notes: args.notes as string | undefined,
  });

  // Look up the freshly-created invoice number for the response.
  const snap = await db.collection("invoices").doc(result.invoiceId).get();
  const number = snap.exists ? (snap.data() as { number?: string }).number || "" : "";
  return { invoiceId: result.invoiceId, status: "draft" as const, number };
}

export async function updateInvoice(userId: string, args: Record<string, unknown>) {
  const { performUpdateInvoice } = await import("../invoicing/updateInvoice");
  if (!args.invoiceId) throw new Error("invoiceId is required");
  if (!args.patch || typeof args.patch !== "object") {
    throw new Error("patch is required");
  }
  const result = await performUpdateInvoice(db, userId, {
    invoiceId: args.invoiceId as string,
    patch: args.patch as Record<string, unknown>,
  });
  return { invoiceId: result.invoiceId, status: result.status };
}

export async function issueInvoice(userId: string, args: Record<string, unknown>) {
  const { performIssueInvoice } = await import("../invoicing/issueInvoice");
  const result = await performIssueInvoice(db, userId, {
    invoiceId: args.invoiceId as string,
    createShareLink: args.createShareLink as boolean | undefined,
  });
  const response: Record<string, unknown> = {
    invoiceId: result.invoiceId,
    fileId: result.fileId,
    downloadUrl: result.downloadUrl,
  };
  if (result.shareUrl) response.shareUrl = result.shareUrl;
  if (result.shareToken) response.shareToken = result.shareToken;
  return response;
}

export async function listInvoices(userId: string, args: Record<string, unknown>) {
  const { performListInvoices } = await import("../invoicing/listInvoices");
  const result = await performListInvoices(db, userId, {
    status: args.status as
      | "draft"
      | "issued"
      | "sent"
      | "paid"
      | "cancelled"
      | undefined,
    partnerId: args.partnerId as string | undefined,
    fromDate: args.fromDate as string | undefined,
    toDate: args.toDate as string | undefined,
    limit: args.limit as number | undefined,
  });
  return result.invoices;
}

export async function getInvoice(userId: string, args: Record<string, unknown>) {
  const { performGetInvoice } = await import("../invoicing/getInvoice");
  const result = await performGetInvoice(db, userId, {
    invoiceId: args.invoiceId as string,
  });
  const response: Record<string, unknown> = { invoice: result.invoice };
  if (result.downloadUrl) response.downloadUrl = result.downloadUrl;
  if (result.shareUrl) response.shareUrl = result.shareUrl;
  return response;
}

export async function duplicateInvoice(userId: string, args: Record<string, unknown>) {
  const { performDuplicateInvoice } = await import("../invoicing/duplicateInvoice");
  const result = await performDuplicateInvoice(db, userId, {
    invoiceId: args.invoiceId as string,
  });
  return { invoiceId: result.invoiceId };
}

export async function cancelInvoice(userId: string, args: Record<string, unknown>) {
  const { performCancelInvoice } = await import("../invoicing/cancelInvoice");
  const result = await performCancelInvoice(db, userId, {
    invoiceId: args.invoiceId as string,
  });
  return { invoiceId: result.invoiceId, status: result.status };
}
